@echo off
REM ============================================================
REM  yt-dlp Web UI launcher (double-click to run)
REM  Requires: Node.js in PATH, yt-dlp.exe / yt-dlp in this folder or PATH
REM ============================================================

SET "BASE=%~dp0"
SET "PORT=8731"

where node >nul 2>nul
IF ERRORLEVEL 1 (
    echo [ERROR] Node.js not found in PATH.
    echo Install it from https://nodejs.org  then retry.
    pause
    exit /b 1
)

IF NOT EXIST "%BASE%yt-dlp.exe" IF NOT EXIST "%BASE%yt-dlp" (
    echo [WARN] yt-dlp not found in this folder, will try system PATH.
    echo        Download it from https://github.com/yt-dlp/yt-dlp/releases
)

echo ============================================================
echo   yt-dlp download UI is starting...
echo   Open in browser:  http://127.0.0.1:%PORT%
echo   Save directory:   %BASE%
echo   Keep this window OPEN. Close it to stop the service.
echo ============================================================
echo.

node "%BASE%server.js"

echo.
echo [Service stopped] Press any key to close.
pause >nul
