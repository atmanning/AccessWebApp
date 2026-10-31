@echo off
rem Starts Access Web on this PC and opens it in your browser.
rem Close this window (or press Ctrl+C) to stop it. See docs\INSTALL-LOCAL.md.
setlocal
cd /d "%~dp0"
title Access Web

if not exist "server\dist\server\src\index.js" goto notbuilt
if not exist "web\dist\index.html" goto notbuilt
where node >nul 2>nul || (echo Node.js isn't installed or isn't on PATH. See docs\INSTALL-LOCAL.md. & pause & exit /b 1)

set NODE_ENV=production
rem Plain http on this PC, so the login cookie must not require https.
set SECURE_COOKIES=false
if "%PORT%"=="" set PORT=3000
rem 127.0.0.1 = only this PC can open it. Use 0.0.0.0 to share it on your network.
if "%HOST%"=="" set HOST=127.0.0.1
rem Allow MySQL servers on this PC or your local network.
if "%ALLOW_PRIVATE_DB_HOSTS%"=="" set ALLOW_PRIVATE_DB_HOSTS=true
if "%DATA_DIR%"=="" set DATA_DIR=%~dp0data

where java >nul 2>nul || echo Note: Java isn't installed, so Access .accdb import and export won't work. Everything else will.
if not exist "exporter\target\access-exporter.jar" echo Note: the Access exporter isn't built (npm run build:exporter), so .accdb import and export won't work.

echo Starting Access Web on http://localhost:%PORT%  (data folder: %DATA_DIR%)
rem Open the browser a moment after the server starts.
start "" /b cmd /c "ping -n 4 127.0.0.1 >nul & start "" http://localhost:%PORT%"
node server\dist\server\src\index.js
echo.
echo Access Web stopped.
pause
exit /b

:notbuilt
echo Access Web hasn't been built yet. In this folder run:
echo     npm ci
echo     npm run build
echo     npm run build:exporter
echo See docs\INSTALL-LOCAL.md for details.
pause
exit /b 1
