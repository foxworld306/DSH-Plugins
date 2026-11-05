@echo off
rem ---------------------------------------------------------------------------
rem  dsh-office-docs-win one-click install (Windows).
rem  Double-click this file. It finds Node.js even when only the packaged DSH
rem  desktop app is installed (that app ships node.exe in its resources), then
rem  installs the plugin into the DSH profile.
rem  No admin rights, no Python, no registry writes. Re-running is safe.
rem  All user-facing text is printed by install.mjs (UTF-8 safe).
rem ---------------------------------------------------------------------------
setlocal
chcp 65001 >nul 2>nul
cd /d "%~dp0"

set "NODE_EXE="
for /f "delims=" %%P in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%P"

set "CANDIDATE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE if exist "%CANDIDATE%" set "NODE_EXE=%CANDIDATE%"

if not defined NODE_EXE goto :nonode

echo    Node: %NODE_EXE%
"%NODE_EXE%" "%~dp0install.mjs"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo    Installer exited with code %RC%. Send the text above to the maintainer.
if "%RC%"=="0" echo    Done. You can close this window.
pause
exit /b %RC%

:nonode
echo.
echo    [xx] Node.js not found on PATH and no packaged DSH install was found.
echo         If you use the DSH desktop app, install through its UI instead:
echo           sidebar - Plugins - Install - pick this folder:
echo           %~dp0
echo.
pause
exit /b 1
