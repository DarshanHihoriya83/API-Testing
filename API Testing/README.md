# API Testing Backend (Node.js)

Practice API for Postman testing — users, JWT auth, and orders.

---

## Prerequisites

| Tool | Purpose | Download |
|------|---------|----------|
| **Node.js 18+** | Run the server | https://nodejs.org |
| **npm** | Install dependencies (included with Node.js) | — |
| **Postman** | Test APIs | https://www.postman.com/downloads |

Check installation in CMD:

```cmd
node -v
npm -v
```

---

## Option A — Automatic setup (Windows `.bat` file)

Use this if you want **install + start server** in one step.

### Steps

1. Open the project folder: `c:\API Testing`
2. Double-click **`setup.bat`**
3. Wait for dependencies to install
4. Server starts automatically at **http://localhost:3000**
5. Press **Ctrl+C** in the CMD window to stop the server

### What `setup.bat` does

| Step | Action |
|------|--------|
| 1 | Checks Node.js and npm are installed |
| 2 | Runs `npm install` (installs all dependencies from `package.json`) |
| 3 | Creates `.env` from `.env.example` if `.env` does not exist |
| 4 | Runs `npm run dev` and starts the API server |

### Run `.bat` from CMD (alternative)

```cmd
cd "c:\API Testing"
setup.bat
```

---

## Option B — Manual setup (CMD step by step)

Use this if you prefer running each command yourself.

### Step 1 — Open CMD and go to project folder

```cmd
cd "c:\API Testing"
```

### Step 2 — Install dependencies

```cmd
npm install
```

This reads `package.json` and installs:

| Package | Purpose |
|---------|---------|
| express | API server |
| bcryptjs | Password hashing |
| jsonwebtoken | JWT authentication |
| cookie-parser | Cookie support |
| dotenv | Environment variables |
| helmet | Security headers |
| morgan | Request logging |
| nodemon | Auto-restart during development |

Full list is also in **`requirements.txt`**.

### Step 3 — Create environment file

```cmd
copy .env.example .env
```

### Step 4 — Edit `.env` file

Open `.env` and set your values:

```env
PORT=3000
API_KEY=your-secret-api-key
COOKIE_SECRET=your-cookie-secret
JWT_SECRET=your-jwt-secret
JWT_EXPIRES_IN=1h
JWT_REFRESH_EXPIRES_IN=7d
```

### Step 5 — Start the server

**Development (auto-restart on file change):**

```cmd
npm run dev
```

**Production:**

```cmd
npm start
```

### Step 6 — Verify server is running

Open browser or CMD:

```cmd
curl http://localhost:3000/health
```

Expected response:

```json
{ "ok": true }
```

---

## Postman setup

1. Open Postman
2. **Import** → `postman/API-Testing.postman_collection.json`
3. **Import** → `postman/Local.postman_environment.json`
4. Select environment **API Testing Local**
5. Set `API_KEY` in environment to match your `.env` file
6. Run requests in this order:
   - **Create user** → saves `accessToken`, `userId`
   - **Create Orders** → saves `orderId`
   - Other APIs

---

## Authentication

Every `/api/*` request needs **both**:

1. **API key** — `x-api-key: <API_KEY>`
2. **JWT access token** — `Authorization: Bearer <accessToken>`

**Public routes (no JWT):** `POST /api/register`, `POST /api/login`, `POST /api/auth/refresh`

| Token | Default lifetime | Purpose |
|-------|------------------|---------|
| `accessToken` | 1 hour | API requests |
| `refreshToken` | 7 days | Get new access token |

### Auth flow

1. `POST /api/register` — create account → returns tokens
2. `POST /api/login` — login → returns tokens
3. Use `accessToken` on all protected routes
4. `POST /api/auth/refresh` — refresh expired token
5. `POST /api/auth/change-password` — change password
6. `POST /api/logout` — revoke refresh token

---

## API Endpoints

### Users & auth

| Method | Endpoint | Body |
|--------|----------|------|
| POST | `/api/register` | `{ name, email, password }` |
| POST | `/api/login` | `{ email, password }` |
| POST | `/api/auth/refresh` | `{ refreshToken }` |
| GET | `/api/auth/verify` | — |
| POST | `/api/auth/change-password` | `{ currentPassword, newPassword }` |
| GET | `/api/me` | — |
| POST | `/api/logout` | `{ refreshToken }` |
| GET | `/api/users/:id` | — |
| PUT | `/api/users/:id` | `{ name, email, password }` |
| DELETE | `/api/users/:id` | — |
| GET | `/api/users/:id/orders` | — |

### Orders

| Method | Endpoint | Notes |
|--------|----------|-------|
| POST | `/api/orders` | Creates order with status `pending` |
| GET | `/api/orders` | `?status=`, `?userId=`, `?page=`, `?limit=` |
| GET | `/api/orders/:id` | Get order by id |
| PUT | `/api/orders/:id` | Update order |
| PATCH | `/api/orders/:id/status` | `{ status }` |
| POST | `/api/orders/:id/cancel` | Cancel order |
| DELETE | `/api/orders/:id` | Delete order |

Order statuses: `pending`, `confirmed`, `processing`, `shipped`, `delivered`, `cancelled`

---

## Example CMD (cURL)

**Register:**

```cmd
curl -X POST http://localhost:3000/api/register ^
  -H "Content-Type: application/json" ^
  -H "x-api-key: your-api-key" ^
  -d "{\"name\":\"Darshan\",\"email\":\"darshan@example.com\",\"password\":\"secret123\"}"
```

**Login:**

```cmd
curl -X POST http://localhost:3000/api/login ^
  -H "Content-Type: application/json" ^
  -H "x-api-key: your-api-key" ^
  -d "{\"email\":\"darshan@example.com\",\"password\":\"secret123\"}"
```

**Get current user:**

```cmd
curl http://localhost:3000/api/me ^
  -H "x-api-key: your-api-key" ^
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `Port 3000 is already in use` | Stop other server or change `PORT` in `.env` |
| `Missing or invalid API key` | Add `x-api-key` header matching `.env` |
| `missing access token` | Login first, add `Authorization: Bearer <token>` |
| `npm is not recognized` | Install Node.js from https://nodejs.org |
| Register returns 401 | Restart server after code changes |

---

## Project structure

```
API Testing/
├── setup.bat              ← Auto install + run (Windows)
├── requirements.txt       ← Dependency list
├── package.json           ← npm dependencies
├── .env.example           ← Environment template
├── src/
│   └── server.js          ← API server
└── postman/
    ├── API-Testing.postman_collection.json
    └── Local.postman_environment.json
```
