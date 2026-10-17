@echo off
rem Makes the Signage server start automatically when this PC boots (no login
rem needed) and restart if it ever stops. Asks for administrator rights.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1"
pause
