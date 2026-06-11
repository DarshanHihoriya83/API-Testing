require("dotenv").config();

const express = require("express");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const jwt = require("jsonwebtoken");
const morgan = require("morgan");

const app = express();

app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || "change-me-please";
const COOKIE_SECRET = process.env.COOKIE_SECRET || "change-me-cookie-secret";
const JWT_SECRET = process.env.JWT_SECRET || "change-me-jwt-secret";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1h";
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || "7d";
const COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const BCRYPT_ROUNDS = 10;

app.use(cookieParser(COOKIE_SECRET));

function getApiKeyFromRequest(req) {
  const headerKey = req.header("x-api-key");
  if (headerKey) return headerKey;

  const auth = req.header("authorization");
  if (!auth) return null;
  const match = auth.match(/^ApiKey\s+(.+)$/i);
  if (match) return match[1];
  return null;
}

function apiKeyAuth(req, res, next) {
  const key = getApiKeyFromRequest(req);
  if (!key || key !== API_KEY) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Missing or invalid API key"
    });
  }
  return next();
}

// In-memory stores
const users = new Map(); // id -> user
const orders = new Map(); // id -> order
const refreshTokens = new Set();
let nextUserId = 1;
let nextOrderId = 1;

const ORDER_STATUSES = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled"];

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isEmailLike(v) {
  return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function isValidPassword(v) {
  return typeof v === "string" && v.length >= 8;
}

function getBearerToken(req) {
  const auth = req.header("authorization");
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, type: "access" },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function signRefreshToken(user) {
  const token = jwt.sign(
    { sub: user.id, type: "refresh" },
    JWT_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRES_IN }
  );
  refreshTokens.add(token);
  return token;
}

function issueAuthTokens(user) {
  return {
    accessToken: signAccessToken(user),
    refreshToken: signRefreshToken(user),
    tokenType: "Bearer",
    expiresIn: JWT_EXPIRES_IN
  };
}

function revokeRefreshToken(token) {
  if (token) refreshTokens.delete(token);
}

function jwtAuth(req, res, next) {
  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "missing access token; use Authorization: Bearer <token>"
    });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.type === "refresh") {
      return res.status(401).json({
        error: "Unauthorized",
        message: "refresh token cannot be used as an access token"
      });
    }

    const user = users.get(payload.sub);
    if (!user) {
      return res.status(401).json({ error: "Unauthorized", message: "user no longer exists" });
    }

    req.user = user;
    req.auth = payload;
    return next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Unauthorized", message: "access token expired" });
    }
    return res.status(401).json({ error: "Unauthorized", message: "invalid access token" });
  }
}

const PUBLIC_API_ROUTES = new Set([
  "POST:/api/register",
  "POST:/api/login",
  "POST:/api/auth/refresh"
]);

function isPublicApiRoute(req) {
  const fullPath = `${req.baseUrl || ""}${req.path}`;
  return PUBLIC_API_ROUTES.has(`${req.method}:${fullPath}`);
}

function requireJwtUnlessPublic(req, res, next) {
  if (isPublicApiRoute(req)) return next();
  return jwtAuth(req, res, next);
}

// API key + JWT required on all /api routes (except register, login, refresh)
app.use("/api", apiKeyAuth);
app.use("/api", requireJwtUnlessPublic);

function sanitizeUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function findUserByEmail(email) {
  const target = email.toLowerCase();
  for (const u of users.values()) {
    if (u.email.toLowerCase() === target) return u;
  }
  return null;
}

function setUserCookie(res, userId) {
  res.cookie("userId", userId, {
    httpOnly: true,
    signed: true,
    maxAge: COOKIE_MAX_AGE_MS,
    sameSite: "lax"
  });
}

function getUserIdFromCookie(req) {
  return req.signedCookies.userId || null;
}

function isPositiveInteger(v) {
  return Number.isInteger(v) && v > 0;
}

function isNonNegativeNumber(v) {
  return typeof v === "number" && !Number.isNaN(v) && v >= 0;
}

function validateOrderItem(item) {
  if (!item || typeof item !== "object") return "each item must be an object";
  if (!isNonEmptyString(item.name)) return "item name is required";
  if (!isPositiveInteger(item.quantity)) return "item quantity must be a positive integer";
  if (!isNonNegativeNumber(item.price)) return "item price must be a non-negative number";
  return null;
}

function normalizeOrderItems(items) {
  return items.map((item) => ({
    name: item.name.trim(),
    quantity: item.quantity,
    price: item.price
  }));
}

function calculateOrderTotal(items) {
  return items.reduce((sum, item) => sum + item.quantity * item.price, 0);
}

function sanitizeOrder(order) {
  return {
    id: order.id,
    userId: order.userId,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    items: order.items,
    status: order.status,
    total: order.total,
    shippingAddress: order.shippingAddress,
    notes: order.notes,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
}

function parsePagination(query) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 20));
  return { page, limit };
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Registration: create user with hashed password and return JWT tokens
app.post("/api/register", async (req, res) => {
  const { name, email, password } = req.body || {};

  if (!isNonEmptyString(name)) {
    return res.status(400).json({ error: "BadRequest", message: "name is required" });
  }
  if (!isEmailLike(email)) {
    return res.status(400).json({ error: "BadRequest", message: "valid email is required" });
  }
  if (!isValidPassword(password)) {
    return res.status(400).json({
      error: "BadRequest",
      message: "password is required and must be at least 8 characters"
    });
  }
  if (findUserByEmail(email)) {
    return res.status(409).json({ error: "Conflict", message: "email already registered" });
  }

  const now = new Date().toISOString();
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = {
    id: String(nextUserId++),
    name: name.trim(),
    email: email.trim().toLowerCase(),
    passwordHash,
    createdAt: now,
    updatedAt: now
  };
  users.set(user.id, user);
  setUserCookie(res, user.id);

  const tokens = issueAuthTokens(user);
  return res.status(201).json({
    user: sanitizeUser(user),
    ...tokens,
    message: "registered successfully"
  });
});

// Login: verify email + password and return JWT tokens
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body || {};

  if (!isEmailLike(email)) {
    return res.status(400).json({ error: "BadRequest", message: "valid email is required" });
  }
  if (!isNonEmptyString(password)) {
    return res.status(400).json({ error: "BadRequest", message: "password is required" });
  }

  const user = findUserByEmail(email);
  if (!user) {
    return res.status(401).json({ error: "Unauthorized", message: "invalid email or password" });
  }

  const passwordOk = await bcrypt.compare(password, user.passwordHash);
  if (!passwordOk) {
    return res.status(401).json({ error: "Unauthorized", message: "invalid email or password" });
  }

  setUserCookie(res, user.id);
  const tokens = issueAuthTokens(user);
  return res.json({
    user: sanitizeUser(user),
    ...tokens,
    message: "logged in successfully"
  });
});

// Refresh access token using a valid refresh token
app.post("/api/auth/refresh", (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken || typeof refreshToken !== "string") {
    return res.status(400).json({ error: "BadRequest", message: "refreshToken is required" });
  }
  if (!refreshTokens.has(refreshToken)) {
    return res.status(401).json({ error: "Unauthorized", message: "refresh token revoked or invalid" });
  }

  try {
    const payload = jwt.verify(refreshToken, JWT_SECRET);
    if (payload.type !== "refresh") {
      return res.status(401).json({ error: "Unauthorized", message: "invalid refresh token" });
    }

    const user = users.get(payload.sub);
    if (!user) {
      revokeRefreshToken(refreshToken);
      return res.status(401).json({ error: "Unauthorized", message: "user no longer exists" });
    }

    refreshTokens.delete(refreshToken);
    const tokens = issueAuthTokens(user);
    return res.json({
      user: sanitizeUser(user),
      ...tokens,
      message: "token refreshed"
    });
  } catch (err) {
    revokeRefreshToken(refreshToken);
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Unauthorized", message: "refresh token expired" });
    }
    return res.status(401).json({ error: "Unauthorized", message: "invalid refresh token" });
  }
});

// Verify access token (for API testing)
app.get("/api/auth/verify", (req, res) => {
  return res.json({
    valid: true,
    user: sanitizeUser(req.user),
    auth: {
      sub: req.auth.sub,
      email: req.auth.email,
      exp: req.auth.exp,
      iat: req.auth.iat
    }
  });
});

// Get current logged-in user
app.get("/api/me", (req, res) => {
  return res.json({ user: sanitizeUser(req.user) });
});

// Change password
app.post("/api/auth/change-password", async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  if (!isNonEmptyString(currentPassword)) {
    return res.status(400).json({ error: "BadRequest", message: "currentPassword is required" });
  }
  if (!isValidPassword(newPassword)) {
    return res.status(400).json({
      error: "BadRequest",
      message: "newPassword must be at least 8 characters"
    });
  }

  const passwordOk = await bcrypt.compare(currentPassword, req.user.passwordHash);
  if (!passwordOk) {
    return res.status(401).json({ error: "Unauthorized", message: "current password is incorrect" });
  }

  req.user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  req.user.updatedAt = new Date().toISOString();
  users.set(req.user.id, req.user);

  return res.json({ message: "password updated successfully" });
});

// Logout: revoke refresh token and clear cookie
app.post("/api/logout", (req, res) => {
  const { refreshToken } = req.body || {};
  revokeRefreshToken(refreshToken);
  res.clearCookie("userId");
  return res.json({ message: "logged out successfully" });
});

// View stored cookies (for testing)
app.get("/api/cookies", (req, res) => {
  return res.json({
    cookies: req.cookies,
    signedCookies: req.signedCookies
  });
});

// Get user by id
app.get("/api/users/:id", (req, res) => {
  const user = users.get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: "NotFound", message: "user not found" });
  }
  return res.json({ user: sanitizeUser(user) });
});

// Update user by id (partial allowed)
app.put("/api/users/:id", async (req, res) => {
  const user = users.get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: "NotFound", message: "user not found" });
  }

  const { name, email, password } = req.body || {};

  if (name !== undefined) {
    if (!isNonEmptyString(name)) {
      return res.status(400).json({ error: "BadRequest", message: "name must be a non-empty string" });
    }
    user.name = name.trim();
  }

  if (email !== undefined) {
    if (!isEmailLike(email)) {
      return res.status(400).json({ error: "BadRequest", message: "email must be valid" });
    }
    const existing = findUserByEmail(email);
    if (existing && existing.id !== user.id) {
      return res.status(409).json({ error: "Conflict", message: "email already registered" });
    }
    user.email = email.trim().toLowerCase();
  }

  if (password !== undefined) {
    if (!isValidPassword(password)) {
      return res.status(400).json({
        error: "BadRequest",
        message: "password must be at least 8 characters"
      });
    }
    user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  }

  user.updatedAt = new Date().toISOString();
  users.set(user.id, user);

  return res.json({ user: sanitizeUser(user) });
});

// Delete user by id
app.delete("/api/users/:id", (req, res) => {
  const user = users.get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: "NotFound", message: "user not found" });
  }
  users.delete(req.params.id);
  return res.json({ message: "delete user successfully" });
});

// List orders for a user
app.get("/api/users/:id/orders", (req, res) => {
  const user = users.get(req.params.id);
  if (!user) {
    return res.status(404).json({ error: "NotFound", message: "user not found" });
  }

  const { page, limit } = parsePagination(req.query);
  const status = req.query.status;
  if (status !== undefined && !ORDER_STATUSES.includes(status)) {
    return res.status(400).json({
      error: "BadRequest",
      message: `status must be one of: ${ORDER_STATUSES.join(", ")}`
    });
  }

  let list = [...orders.values()].filter((o) => o.userId === user.id);
  if (status) list = list.filter((o) => o.status === status);
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const total = list.length;
  const start = (page - 1) * limit;
  const data = list.slice(start, start + limit).map(sanitizeOrder);

  return res.json({ orders: data, page, limit, total });
});

// Create order (new orders always start as pending)
app.post("/api/orders", (req, res) => {
  const {
    userId,
    customerName,
    customerEmail,
    items,
    shippingAddress,
    notes
  } = req.body || {};

  const status = "pending";

  if (userId !== undefined && userId !== null && !users.has(String(userId))) {
    return res.status(400).json({ error: "BadRequest", message: "userId does not exist" });
  }
  if (!isNonEmptyString(customerName)) {
    return res.status(400).json({ error: "BadRequest", message: "customerName is required" });
  }
  if (!isEmailLike(customerEmail)) {
    return res.status(400).json({ error: "BadRequest", message: "valid customerEmail is required" });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "BadRequest", message: "items must be a non-empty array" });
  }
  for (const item of items) {
    const err = validateOrderItem(item);
    if (err) return res.status(400).json({ error: "BadRequest", message: err });
  }
  if (!shippingAddress || typeof shippingAddress !== "object") {
    return res.status(400).json({ error: "BadRequest", message: "shippingAddress is required" });
  }
  const { street, city, state: addrState, zip, country } = shippingAddress;
  if (!isNonEmptyString(street) || !isNonEmptyString(city) || !isNonEmptyString(addrState) || !isNonEmptyString(zip) || !isNonEmptyString(country)) {
    return res.status(400).json({
      error: "BadRequest",
      message: "shippingAddress requires street, city, state, zip, and country"
    });
  }
  if (notes !== undefined && notes !== null && typeof notes !== "string") {
    return res.status(400).json({ error: "BadRequest", message: "notes must be a string" });
  }

  const normalizedItems = normalizeOrderItems(items);
  const now = new Date().toISOString();
  const resolvedUserId = userId != null ? String(userId) : req.user.id;
  const order = {
    id: String(nextOrderId++),
    userId: resolvedUserId,
    customerName: customerName.trim(),
    customerEmail: customerEmail.trim(),
    items: normalizedItems,
    status,
    total: calculateOrderTotal(normalizedItems),
    shippingAddress: {
      street: street.trim(),
      city: city.trim(),
      state: addrState.trim(),
      zip: zip.trim(),
      country: country.trim()
    },
    notes: notes ? notes.trim() : null,
    createdAt: now,
    updatedAt: now
  };
  orders.set(order.id, order);

  return res.status(201).json({
    order: sanitizeOrder(order),
    message: "order created successfully",
    defaultStatus: "pending"
  });
});

// List orders (optional filters: status, userId)
app.get("/api/orders", (req, res) => {
  const { page, limit } = parsePagination(req.query);
  const { status, userId } = req.query;

  if (status !== undefined && !ORDER_STATUSES.includes(status)) {
    return res.status(400).json({
      error: "BadRequest",
      message: `status must be one of: ${ORDER_STATUSES.join(", ")}`
    });
  }
  if (userId !== undefined && !users.has(String(userId))) {
    return res.status(400).json({ error: "BadRequest", message: "userId does not exist" });
  }

  let list = [...orders.values()];
  if (status) list = list.filter((o) => o.status === status);
  if (userId !== undefined) list = list.filter((o) => o.userId === String(userId));
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const total = list.length;
  const start = (page - 1) * limit;
  const data = list.slice(start, start + limit).map(sanitizeOrder);

  return res.json({ orders: data, page, limit, total });
});

// Get order by id
app.get("/api/orders/:id", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: "NotFound", message: "order not found" });
  }
  return res.json({ order: sanitizeOrder(order) });
});

// Update order by id (partial allowed)
app.put("/api/orders/:id", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: "NotFound", message: "order not found" });
  }

  const {
    userId,
    customerName,
    customerEmail,
    items,
    status,
    shippingAddress,
    notes
  } = req.body || {};

  if (userId !== undefined) {
    if (userId !== null && !users.has(String(userId))) {
      return res.status(400).json({ error: "BadRequest", message: "userId does not exist" });
    }
    order.userId = userId != null ? String(userId) : null;
  }

  if (customerName !== undefined) {
    if (!isNonEmptyString(customerName)) {
      return res.status(400).json({ error: "BadRequest", message: "customerName must be a non-empty string" });
    }
    order.customerName = customerName.trim();
  }

  if (customerEmail !== undefined) {
    if (!isEmailLike(customerEmail)) {
      return res.status(400).json({ error: "BadRequest", message: "customerEmail must be valid" });
    }
    order.customerEmail = customerEmail.trim();
  }

  if (items !== undefined) {
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "BadRequest", message: "items must be a non-empty array" });
    }
    for (const item of items) {
      const err = validateOrderItem(item);
      if (err) return res.status(400).json({ error: "BadRequest", message: err });
    }
    order.items = normalizeOrderItems(items);
    order.total = calculateOrderTotal(order.items);
  }

  if (status !== undefined) {
    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({
        error: "BadRequest",
        message: `status must be one of: ${ORDER_STATUSES.join(", ")}`
      });
    }
    order.status = status;
  }

  if (shippingAddress !== undefined) {
    if (!shippingAddress || typeof shippingAddress !== "object") {
      return res.status(400).json({ error: "BadRequest", message: "shippingAddress must be an object" });
    }
    const { street, city, state: addrState, zip, country } = shippingAddress;
    if (!isNonEmptyString(street) || !isNonEmptyString(city) || !isNonEmptyString(addrState) || !isNonEmptyString(zip) || !isNonEmptyString(country)) {
      return res.status(400).json({
        error: "BadRequest",
        message: "shippingAddress requires street, city, state, zip, and country"
      });
    }
    order.shippingAddress = {
      street: street.trim(),
      city: city.trim(),
      state: addrState.trim(),
      zip: zip.trim(),
      country: country.trim()
    };
  }

  if (notes !== undefined) {
    if (notes !== null && typeof notes !== "string") {
      return res.status(400).json({ error: "BadRequest", message: "notes must be a string or null" });
    }
    order.notes = notes ? notes.trim() : null;
  }

  order.updatedAt = new Date().toISOString();
  orders.set(order.id, order);

  return res.json({ order: sanitizeOrder(order) });
});

// Update order status only
app.patch("/api/orders/:id/status", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: "NotFound", message: "order not found" });
  }

  const { status } = req.body || {};
  if (!ORDER_STATUSES.includes(status)) {
    return res.status(400).json({
      error: "BadRequest",
      message: `status must be one of: ${ORDER_STATUSES.join(", ")}`
    });
  }

  order.status = status;
  order.updatedAt = new Date().toISOString();
  orders.set(order.id, order);

  return res.json({ order: sanitizeOrder(order) });
});

// Cancel order (sets status to cancelled)
app.post("/api/orders/:id/cancel", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: "NotFound", message: "order not found" });
  }
  if (order.status === "delivered") {
    return res.status(409).json({ error: "Conflict", message: "delivered orders cannot be cancelled" });
  }
  if (order.status === "cancelled") {
    return res.status(409).json({ error: "Conflict", message: "order is already cancelled" });
  }

  order.status = "cancelled";
  order.updatedAt = new Date().toISOString();
  orders.set(order.id, order);

  return res.json({ order: sanitizeOrder(order), message: "order cancelled" });
});

// Delete order by id
app.delete("/api/orders/:id", (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: "NotFound", message: "order not found" });
  }
  orders.delete(req.params.id);
  return res.json({ message: "your order is deleted successfully" });
});

// Basic error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "InternalServerError" });
});

const server = app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log(`API Key + JWT auth enabled for /api/* (public: register, login, refresh)`);
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Pick a different PORT in .env (or stop the other process).`);
    process.exit(1);
  }
  throw err;
});

