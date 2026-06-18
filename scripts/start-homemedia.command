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
NODE_VERSION="22.23.0"      # Node 22 LTS (undici 8 needs >=22.19)
MIN_NODE_MAJOR=22          # minimum acceptable system Node
MIN_NODE_MINOR=19

# True when the Node currently on PATH is new enough. A too-old Node (e.g. 20.x)
# crashes at startup because undici 8 uses APIs added in Node 22.19, so we treat
# an outdated system Node the same as a missing one and fetch the portable copy.
node_is_recent_enough() {
  command -v node >/dev/null 2>&1 || return 1
  local v maj min
  v="$(node --version 2>/dev/null)"; v="${v#v}"
  maj="${v%%.*}"; min="${v#*.}"; min="${min%%.*}"
  [ -n "$maj" ] && [ -n "$min" ] || return 1
  if [ "$maj" -gt "$MIN_NODE_MAJOR" ]; then return 0; fi
  if [ "$maj" -eq "$MIN_NODE_MAJOR" ] && [ "$min" -ge "$MIN_NODE_MINOR" ]; then return 0; fi
  echo "[setup] Found Node v$v, but HomeMedia needs v$MIN_NODE_MAJOR.$MIN_NODE_MINOR or newer."
  return 1
}

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

echo "[Step 1 of 4] Checking requirements (Node.js + ffmpeg)"
echo "   First run downloads about 100 MB and may take a couple of minutes."
echo

# ---------------- Node.js ----------------
# Fetch a portable Node when none is on PATH OR the system Node is too old.
echo "   --- Step 1 of 2: Node.js ---"
if ! node_is_recent_enough; then
  NODE_NAME="node-v${NODE_VERSION}-darwin-${NODE_ARCH}"
  NODE_DIR="$RUNTIME_DIR/$NODE_NAME"
  if [ ! -x "$NODE_DIR/bin/node" ]; then
    echo "   not on this Mac - fetching a portable copy (one time)..."
    echo "   downloading Node.js ${NODE_VERSION} ..."
    # -# shows a live progress bar so a slow download doesn't look frozen.
    curl -fSL -# "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_NAME}.tar.gz" \
      -o "$RUNTIME_DIR/node.tar.gz" \
      && echo "   extracting..." \
      && tar -xzf "$RUNTIME_DIR/node.tar.gz" -C "$RUNTIME_DIR" \
      && rm -f "$RUNTIME_DIR/node.tar.gz"
    if [ ! -x "$NODE_DIR/bin/node" ]; then
      echo "[!] Could not download Node.js automatically."
      echo "    Install it from https://nodejs.org and run this file again."
      read -r -p "Press Return to close."
      exit 1
    fi
    echo "   Node.js ready."
  else
    echo "   using the copy already downloaded in .runtime/."
  fi
  export PATH="$NODE_DIR/bin:$PATH"
else
  echo "   already installed - good to go."
fi

# ---------------- ffmpeg / ffprobe ----------------
echo
echo "   --- Step 2 of 2: ffmpeg (for video playback) ---"
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  FF_DIR="$RUNTIME_DIR/ffmpeg"
  mkdir -p "$FF_DIR"
  if [ ! -x "$FF_DIR/ffmpeg" ] || [ ! -x "$FF_DIR/ffprobe" ]; then
    echo "   not on this Mac - fetching a portable copy (one time)..."
    # evermeet.cx publishes maintained static Mac builds of ffmpeg/ffprobe.
    echo "   downloading ffmpeg ..."
    curl -fSL -# "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip" -o "$FF_DIR/ffmpeg.zip" \
      && unzip -o -q "$FF_DIR/ffmpeg.zip" -d "$FF_DIR" && rm -f "$FF_DIR/ffmpeg.zip"
    echo "   downloading ffprobe ..."
    curl -fSL -# "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip" -o "$FF_DIR/ffprobe.zip" \
      && unzip -o -q "$FF_DIR/ffprobe.zip" -d "$FF_DIR" && rm -f "$FF_DIR/ffprobe.zip"
    chmod +x "$FF_DIR/ffmpeg" "$FF_DIR/ffprobe" 2>/dev/null || true
  fi
  if [ ! -x "$FF_DIR/ffmpeg" ]; then
    echo "[!] Could not download ffmpeg automatically."
    echo "    Install it (e.g. 'brew install ffmpeg') and run this file again."
    read -r -p "Press Return to close."
    exit 1
  fi
  echo "   ffmpeg ready."
  export PATH="$FF_DIR:$PATH"
else
  echo "   already installed - good to go."
fi
echo "   [Step 1 of 4] done."
echo

# --- Install dependencies the first time (node_modules missing) ---
echo "[Step 2 of 4] Installing app components"
if [ ! -d "node_modules" ]; then
  echo "   First-time setup - this can take a few minutes. Please wait..."
  echo
  if ! npm install; then
    echo "[!] Setup failed. Please try running this file again."
    read -r -p "Press Return to close."
    exit 1
  fi
else
  echo "   Already installed - skipping."
fi
echo "   [Step 2 of 4] done."
echo

# --- Build the app (fast on repeat runs) ---
echo "[Step 3 of 4] Preparing the app"
if ! npm run build; then
  echo "[!] Build failed."
  read -r -p "Press Return to close."
  exit 1
fi
echo "   [Step 3 of 4] done."

# --- Detect this computer's network address ---
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"

echo
echo "============================================"
echo "   [Step 4 of 4] HomeMedia is starting."
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
STATUS=$?

# Keep the window open after the server stops so any error above stays
# readable instead of the Terminal window closing on its own.
echo
echo "============================================"
if [ "$STATUS" -ne 0 ]; then
  echo "   [!] HomeMedia stopped unexpectedly."
  echo "       The error is shown above. Please copy"
  echo "       it when asking for help."
else
  echo "   HomeMedia has stopped."
fi
echo "============================================"
read -r -p "Press Return to close."
