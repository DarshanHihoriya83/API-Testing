@echo off
title API Testing Backend - Setup
echo ========================================
echo  API Testing Backend - Setup
echo ========================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js is not installed.
    echo Download from https://nodejs.org
    pause
    exit /b 1
)

where npm >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: npm is not installed.
    pause
    exit /b 1
)

echo [1/4] Installing dependencies...
call npm install
if %ERRORLEVEL% neq 0 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
)

echo.
echo [2/4] Creating .env file...
if not exist .env (
    copy .env.example .env >nul
    echo Created .env from .env.example
    echo Edit .env and set API_KEY, JWT_SECRET before production use.
) else (
    echo .env already exists - skipped.
)

echo.
echo [3/4] Setup complete!
echo.
echo Server URL:  http://localhost:3000
echo Postman:     import postman\API-Testing.postman_collection.json
echo.
echo [4/4] Starting server (press Ctrl+C to stop)...
echo ========================================
echo.

call npm run dev

echo.
echo Server stopped.
pause
