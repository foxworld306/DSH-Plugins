@echo off
rem ---------------------------------------------------------------------------
rem  One-click install for dsh-plugin-outlook-owa (Windows).
rem  Double-click this file. It installs the plugin into the DSH web profile,
rem  adds the config entry, and opens a browser window for the OWA login.
rem  Re-running is safe.
rem ---------------------------------------------------------------------------
setlocal
chcp 65001 >nul 2>nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [xx] Node.js not found.
  echo        Install Node.js 20 or newer from https://nodejs.org/ and run this again.
  echo.
  pause
  exit /b 1
)

node "%~dp0install.mjs"
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo   Installer exited with code %RC%. See the messages above.
) else (
  echo   Done. You can close this window.
)
pause
exit /b %RC%
