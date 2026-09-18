#!/usr/bin/env bash
# Indirect Code one-line installer (Linux + macOS).
#
# Copiado do dashboard como:
#   curl -fsSL <seu-gateway>/r/indirect-install.sh \
#     | bash -s -- "<connectUrl>" [--name "my-host"]
#
# Faz: detecta OS/arch -> baixa o binário compatível mais recente ->
# instala em ~/.indirect-code/bin -> pareia (-connect) -> deixa rodando
# em segundo plano (nohup, sem prender o terminal).
set -euo pipefail

# Mirror resolution (set AFTER arg parsing below — CONNECT_URL arrives
# via argv): the gateway you're pairing with serves everything (derived
# from CONNECT_URL) — no GitHub dependency. INDIRECT_REPO_RAW overrides
# (air-gapped mirrors, dev).
DATA_DIR="${INDIRECT_DATA_DIR:-$HOME/.indirect-code}"
BIN_DIR="$DATA_DIR/bin"
LOG_FILE="$DATA_DIR/daemon.log"
PID_FILE="$DATA_DIR/daemon.pid"

CONNECT_URL=""
HOST_NAME=""

usage() {
  echo "usage: indirect-install.sh \"<gatewayUrl>\" \"<token>\" [--name <host-name>]" >&2
  echo "   or: indirect-install.sh \"<connectUrl>\" [--name <host-name>]" >&2
}

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) HOST_NAME="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; usage; exit 1 ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done

if [[ ${#POSITIONAL[@]} -eq 2 ]]; then
  arg1="${POSITIONAL[0]}"
  arg2="${POSITIONAL[1]}"
  if [[ "$arg1" =~ ^https?:// ]]; then
    gateway="${arg1%/}"
    token="$arg2"
  elif [[ "$arg2" =~ ^https?:// ]]; then
    gateway="${arg2%/}"
    token="$arg1"
  else
    echo "[indirect] invalid arguments: one argument must be the gateway URL (http:// or https://)" >&2
    exit 1
  fi
  if [[ "$gateway" == *"/api/indirect-code/connect/"* ]]; then
    CONNECT_URL="$gateway"
  else
    CONNECT_URL="${gateway}/api/indirect-code/connect/${token}"
  fi
elif [[ ${#POSITIONAL[@]} -eq 1 ]]; then
  arg="${POSITIONAL[0]}"
  if [[ "$arg" =~ ^https?:// ]]; then
    CONNECT_URL="$arg"
  else
    if [[ -n "${INDIRECT_GATEWAY:-}" ]]; then
      CONNECT_URL="${INDIRECT_GATEWAY%/}/api/indirect-code/connect/${arg}"
    else
      echo "[indirect] missing gateway URL. Usage: indirect-install.sh <gatewayUrl> <token>" >&2
      exit 1
    fi
  fi
else
  echo "[indirect] missing connection parameters." >&2
  usage; exit 1
fi

GATEWAY_BASE="$(printf '%s' "$CONNECT_URL" | sed -E 's#(https?://[^/]+).*#\1#')"
REPO_RAW="${INDIRECT_REPO_RAW:-${GATEWAY_BASE}/r}"

# --- Detect OS/arch ---
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$os" in
  linux) os="linux" ;;
  darwin) os="darwin" ;;
  *) echo "[indirect] unsupported OS: $(uname -s) (use the Windows command instead)" >&2; exit 1 ;;
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

# Export gateway & repo env vars so the launcher and daemon know their mirror
export INDIRECT_GATEWAY="$GATEWAY_BASE"
export INDIRECT_REPO_RAW="$REPO_RAW"

# --- Pair + detach (nohup: terminal stays free) ---
ARGS=(-connect "$CONNECT_URL")
[[ -n "$HOST_NAME" ]] && ARGS+=(--name "$HOST_NAME")
echo "[indirect] pairing and starting in background (log: $LOG_FILE) ..."
# shellcheck disable=SC2086
nohup "$BIN_DIR/indirect-code" "${ARGS[@]}" >>"$LOG_FILE" 2>&1 < /dev/null &
disown 2>/dev/null || true

# First start downloads the daemon binary and runtimes, so poll for the pid file.
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
