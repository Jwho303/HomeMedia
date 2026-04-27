@echo off
REM HomeMedia — LAN host mode for Mac Mini playback testing.
REM Builds the web bundle, binds the server to 0.0.0.0:3000, prints the LAN URL.

setlocal

REM cd to repo root (parent of this script)
cd /d "%~dp0\.."

echo.
echo === HomeMedia LAN host ===
echo.

REM --- LAN IP detection (first non-loopback IPv4) ---
set "LAN_IP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /R /C:"IPv4 Address"') do (
  if not defined LAN_IP (
    set "LAN_IP=%%a"
  )
)
REM trim leading space
if defined LAN_IP set "LAN_IP=%LAN_IP:~1%"

if not defined LAN_IP (
  echo [warn] could not detect a LAN IPv4 address — server will still start.
) else (
  echo Detected LAN IP: %LAN_IP%
  echo Mac Mini should browse to: http://%LAN_IP%:3000
)
echo.

REM --- Build web bundle every run ---
REM Vite's build is incremental (~200ms on no-op), and the cost of running a
REM stale bundle is way worse than 0.2s of startup. Always rebuild.
echo Building web bundle...
call npm run build
if errorlevel 1 (
  echo [error] build failed
  exit /b 1
)

REM --- Firewall hint ---
echo If the Mac can't connect, allow inbound TCP 3000 in Windows Defender Firewall:
echo   netsh advfirewall firewall add rule name="HomeMedia 3000" dir=in action=allow protocol=TCP localport=3000
echo.

REM --- Start server bound to all interfaces ---
set HOST=0.0.0.0
echo Starting server on 0.0.0.0:3000 (Ctrl+C to stop)...
echo.
call npm run start

endlocal
