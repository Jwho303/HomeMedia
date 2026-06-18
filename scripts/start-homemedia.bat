@echo off
REM ============================================================
REM  HomeMedia — one-click start for Windows.
REM  Double-click this file. The first time, it automatically
REM  downloads anything it needs (Node.js, ffmpeg) into a local
REM  .runtime folder — nothing is installed on your system and
REM  no admin rights are required. Then it starts HomeMedia and
REM  prints the address to open.
REM ============================================================

setlocal enabledelayedexpansion

REM --- Disable console "QuickEdit" mode. Otherwise a single accidental click
REM     inside the window enters text-selection mode and FREEZES the running
REM     process until a key is pressed, which looks exactly like a hang. ---
reg add "HKCU\Console" /v QuickEdit /t REG_DWORD /d 0 /f >nul 2>&1

REM cd to repo root (parent of this script's folder)
cd /d "%~dp0\.."

echo.
echo ============================================
echo    Starting HomeMedia...
echo ============================================
echo.

REM --- Make sure Node + ffmpeg are available (fetch if missing) ---
echo [Step 1 of 4] Checking requirements (Node.js + ffmpeg)
echo    First run downloads about 100 MB and may take a couple of minutes.
echo    Tip: do NOT click inside this window while it works - that can pause it.
echo.
for /f "usebackq tokens=1,* delims==" %%a in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bootstrap.ps1"`) do (
  if "%%a"=="PATHADD" set "PATH=%%b;!PATH!"
)
if errorlevel 1 (
  echo [!] Could not prepare the requirements automatically.
  echo     Please install Node.js from https://nodejs.org and try again.
  pause
  exit /b 1
)
echo    [Step 1 of 4] done.
echo.

REM --- Install dependencies the first time (node_modules missing) ---
echo [Step 2 of 4] Installing app components
if not exist "node_modules" (
  echo    First-time setup - this can take a few minutes. Please wait...
  echo.
  call npm install
  if errorlevel 1 (
    echo [!] Setup failed. Please try running this file again.
    pause
    exit /b 1
  )
) else (
  echo    Already installed - skipping.
)
echo    [Step 2 of 4] done.
echo.

REM --- Build the app (fast on repeat runs) ---
echo [Step 3 of 4] Preparing the app
call npm run build
if errorlevel 1 (
  echo [!] Build failed.
  pause
  exit /b 1
)
echo    [Step 3 of 4] done.
echo.

REM --- Detect this computer's network address ---
set "LAN_IP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /R /C:"IPv4 Address"') do (
  if not defined LAN_IP set "LAN_IP=%%a"
)
if defined LAN_IP set "LAN_IP=%LAN_IP:~1%"

echo.
echo ============================================
echo    [Step 4 of 4] HomeMedia is starting.
echo.
echo    On THIS computer, open:
echo        http://localhost:3000
if defined LAN_IP (
  echo.
  echo    On a phone, tablet, or TV on the same
  echo    Wi-Fi, open:
  echo        http://%LAN_IP%:3000
)
echo.
echo    Leave this window open while you watch.
echo    Close it (or press Ctrl+C) to stop.
echo ============================================
echo.

REM --- Start the server, reachable from other devices on the network ---
set HOST=0.0.0.0
call npm run start
set "EXITCODE=%ERRORLEVEL%"

REM --- Always keep the window open after the server stops, so the user can
REM     read what happened instead of the window vanishing on its own. The
REM     message depends on whether it stopped cleanly or because of an error. ---
echo.
echo ============================================
if not "%EXITCODE%"=="0" (
  echo    [!] HomeMedia stopped unexpectedly.
  echo        The error is shown above. Please copy
  echo        it when asking for help.
) else (
  echo    HomeMedia has stopped.
)
echo ============================================
pause

endlocal
