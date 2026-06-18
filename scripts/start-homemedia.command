#!/usr/bin/env bash
# ============================================================
#  HomeMedia — one-click start for Mac.
#  Double-click this file in Finder. The first time, it
#  automatically downloads anything it needs (Node.js, ffmpeg)
#  into a local .runtime folder — nothing is installed on your
#  system. Then it starts HomeMedia and prints the address to
#  open.
#
#  (First time only: macOS may ask permission to run it. If it
#   refuses, right-click the file -> Open -> Open.)
# ============================================================

set -uo pipefail

# cd to repo root (parent of this script's folder)
cd "$(dirname "$0")/.." || exit 1

RUNTIME_DIR="$PWD/.runtime"
NODE_VERSION="20.18.1"

echo
echo "============================================"
echo "   Starting HomeMedia..."
echo "============================================"
echo

mkdir -p "$RUNTIME_DIR"

# Map uname arch to Node's naming.
case "$(uname -m)" in
  arm64) NODE_ARCH="arm64" ;;
  x86_64) NODE_ARCH="x64" ;;
  *) NODE_ARCH="x64" ;;
esac

echo "Checking requirements..."

# ---------------- Node.js ----------------
if ! command -v node >/dev/null 2>&1; then
  NODE_NAME="node-v${NODE_VERSION}-darwin-${NODE_ARCH}"
  NODE_DIR="$RUNTIME_DIR/$NODE_NAME"
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    echo "[setup] Node.js not found - fetching a portable copy (one time)..."
    curl -fSL "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_NAME}.tar.gz" \
      -o "$RUNTIME_DIR/node.tar.gz" \
      && tar -xzf "$RUNTIME_DIR/node.tar.gz" -C "$RUNTIME_DIR" \
      && rm -f "$RUNTIME_DIR/node.tar.gz"
    if [ ! -x "$NODE_DIR/bin/node" ]; then
      echo "[!] Could not download Node.js automatically."
      echo "    Install it from https://nodejs.org and run this file again."
      read -r -p "Press Return to close."
      exit 1
    fi
  fi
  export PATH="$NODE_DIR/bin:$PATH"
fi

# ---------------- ffmpeg / ffprobe ----------------
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  FF_DIR="$RUNTIME_DIR/ffmpeg"
  mkdir -p "$FF_DIR"
  if [ ! -x "$FF_DIR/ffmpeg" ] || [ ! -x "$FF_DIR/ffprobe" ]; then
    echo "[setup] ffmpeg not found - fetching a portable copy (one time)..."
    # evermeet.cx publishes maintained static Mac builds of ffmpeg/ffprobe.
    curl -fSL "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip" -o "$FF_DIR/ffmpeg.zip" \
      && unzip -o -q "$FF_DIR/ffmpeg.zip" -d "$FF_DIR" && rm -f "$FF_DIR/ffmpeg.zip"
    curl -fSL "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip" -o "$FF_DIR/ffprobe.zip" \
      && unzip -o -q "$FF_DIR/ffprobe.zip" -d "$FF_DIR" && rm -f "$FF_DIR/ffprobe.zip"
    chmod +x "$FF_DIR/ffmpeg" "$FF_DIR/ffprobe" 2>/dev/null || true
  fi
  if [ ! -x "$FF_DIR/ffmpeg" ]; then
    echo "[!] Could not download ffmpeg automatically."
    echo "    Install it (e.g. 'brew install ffmpeg') and run this file again."
    read -r -p "Press Return to close."
    exit 1
  fi
  export PATH="$FF_DIR:$PATH"
fi

# --- Install dependencies the first time (node_modules missing) ---
if [ ! -d "node_modules" ]; then
  echo "First-time setup: installing components. This can take a few minutes..."
  echo
  if ! npm install; then
    echo "[!] Setup failed. Please try running this file again."
    read -r -p "Press Return to close."
    exit 1
  fi
  echo
fi

# --- Build the app (fast on repeat runs) ---
echo "Preparing the app..."
if ! npm run build; then
  echo "[!] Build failed."
  read -r -p "Press Return to close."
  exit 1
fi

# --- Detect this computer's network address ---
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"

echo
echo "============================================"
echo "   HomeMedia is starting."
echo
echo "   On THIS computer, open:"
echo "       http://localhost:3000"
if [ -n "${LAN_IP}" ]; then
  echo
  echo "   On a phone, tablet, or TV on the same"
  echo "   Wi-Fi, open:"
  echo "       http://${LAN_IP}:3000"
fi
echo
echo "   Leave this window open while you watch."
echo "   Close it (or press Ctrl+C) to stop."
echo "============================================"
echo

# --- Start the server, reachable from other devices on the network ---
export HOST=0.0.0.0
npm run start
