#!/usr/bin/env bash
# HomeMedia — open the LAN-hosted server in the default browser on the Mac.
# Double-click this file in Finder.
#
# Edit HOST below (or set it in the environment) to the Windows dev box's LAN IP.

set -euo pipefail

HOST="${HOMEMEDIA_HOST:-192.168.1.10}"   # ← change to your Windows LAN IP
PORT="${HOMEMEDIA_PORT:-3000}"
URL="http://${HOST}:${PORT}"

echo "HomeMedia LAN connect"
echo "  target: ${URL}"
echo

# Probe the server first so a typo gives a clear error instead of a blank page.
if ! curl -fsS --max-time 3 "${URL}/api/share/status" >/dev/null 2>&1; then
  echo "[warn] could not reach ${URL}/api/share/status"
  echo "       Is the Windows host running scripts/lan-host.bat?"
  echo "       Is the firewall allowing TCP ${PORT} inbound?"
  echo
  read -r -p "Open the URL anyway? [y/N] " ans
  case "${ans}" in
    y|Y) ;;
    *) exit 1 ;;
  esac
fi

open "${URL}"
