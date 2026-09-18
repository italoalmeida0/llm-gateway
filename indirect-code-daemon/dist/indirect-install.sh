#!/usr/bin/env bash
# Indirect Code installer (Linux + macOS).
# Usage:
#   curl -fsSL <gatewayUrl>/r/indirect-install.sh | bash -s -- <gatewayUrl> <token>
set -euo pipefail

if [[ $# -lt 2 || -z "${1:-}" || -z "${2:-}" ]]; then
  echo "[indirect] usage: indirect-install.sh <gatewayUrl> <token>" >&2
  exit 1
fi

GATEWAY="${1%/}"
TOKEN="$2"
CONNECT_URL="${GATEWAY}/api/indirect-code/connect/${TOKEN}"
REPO_RAW="${GATEWAY}/r"

DATA_DIR="$HOME/.indirect-code"
BIN_DIR="$DATA_DIR/bin"
LOG_FILE="$DATA_DIR/daemon.log"
PID_FILE="$DATA_DIR/daemon.pid"

# --- Detect OS/arch ---
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$os" in
  linux|darwin) ;;
  *) echo "[indirect] unsupported OS: $(uname -s) (use the Windows PowerShell command instead)" >&2; exit 1 ;;
esac

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch="amd64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) echo "[indirect] unsupported arch: $arch (supported: amd64, arm64)" >&2; exit 1 ;;
esac

ASSET="indirect-launcher-${os}-${arch}"
URL="${REPO_RAW}/${ASSET}"

mkdir -p "$BIN_DIR" "$DATA_DIR"
chmod 700 "$DATA_DIR" 2>/dev/null || true

echo "[indirect] downloading $ASSET ..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL --retry 3 "$URL" -o "$BIN_DIR/indirect-code.tmp"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$BIN_DIR/indirect-code.tmp" "$URL"
else
  echo "[indirect] need curl or wget" >&2; exit 1
fi
mv "$BIN_DIR/indirect-code.tmp" "$BIN_DIR/indirect-code"
chmod +x "$BIN_DIR/indirect-code"

# --- Stop previous daemon (if any) ---
if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "[indirect] stopping previous daemon (pid $old_pid) ..."
    "$BIN_DIR/indirect-code" --stop 2>/dev/null || kill "$old_pid" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi
pkill -f "$BIN_DIR/indirect-code" 2>/dev/null || true
rm -f "$PID_FILE"

export INDIRECT_GATEWAY="$GATEWAY"
export INDIRECT_REPO_RAW="$REPO_RAW"

echo "[indirect] pairing and starting in background (log: $LOG_FILE) ..."
nohup "$BIN_DIR/indirect-code" -connect "$CONNECT_URL" >>"$LOG_FILE" 2>&1 < /dev/null &
disown 2>/dev/null || true

# Poll for daemon pid (first start downloads daemon binary + runtimes)
daemon_pid=""
for ((i = 0; i < 45; i++)); do
  sleep 1
  if [[ -f "$PID_FILE" ]]; then
    candidate="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$candidate" ]] && kill -0 "$candidate" 2>/dev/null; then
      daemon_pid="$candidate"
      break
    fi
  fi
done

if [[ -n "$daemon_pid" ]]; then
  echo "[indirect] daemon running in background (pid $daemon_pid)."
  echo "[indirect] Dashboard should show the host online in a few seconds."
  echo "[indirect] Stop locally anytime: ~/.indirect-code/bin/indirect-code --stop"
else
  echo "[indirect] started, but pid check failed — see $LOG_FILE" >&2
  tail -n 20 "$LOG_FILE" >&2 || true
  exit 1
fi
