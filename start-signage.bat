@echo off
rem Double-click to start the Signage server. Close this window (or press Ctrl+C) to stop it.
title Signage server
cd /d "%~dp0"
if not defined PORT set PORT=8080

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)

rem Installs anything new after an update; takes a second when nothing changed.
echo Checking dependencies...
call npm.cmd install --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo.
  echo npm install failed - see the messages above.
  pause
  exit /b 1
)

echo.
echo  Admin console on this PC:  http://localhost:%PORT%/admin/
echo  From phones and screen PCs use this PC's network address:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=*" %%b in ("%%a") do echo     http://%%b:%PORT%/admin/
)
echo.
echo  Keep this window open while the screens are in use.
echo.

call npm.cmd start

echo.
echo The Signage server has stopped.
pause
