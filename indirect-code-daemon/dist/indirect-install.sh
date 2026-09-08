#!/usr/bin/env bash
# Indirect Code one-line installer (Linux + macOS).
#
# Copiado do dashboard como:
#   curl -fsSL https://raw.githubusercontent.com/italoalmeida0/llm-gateway/main/indirect-code-daemon/dist/indirect-install.sh \
#     | bash -s -- "<connectUrl>" [--name "my-host"]
#
# Faz: detecta OS/arch -> baixa o binário compatível mais recente ->
# instala em ~/.indirect-code/bin -> pareia (-connect) -> deixa rodando
# em segundo plano (nohup, sem prender o terminal).
set -euo pipefail

REPO_RAW="${INDIRECT_REPO_RAW:-https://raw.githubusercontent.com/italoalmeida0/llm-gateway/main/indirect-code-daemon/dist}"
DATA_DIR="${INDIRECT_DATA_DIR:-$HOME/.indirect-code}"
BIN_DIR="$DATA_DIR/bin"
LOG_FILE="$DATA_DIR/daemon.log"
PID_FILE="$DATA_DIR/daemon.pid"

CONNECT_URL=""
HOST_NAME=""

usage() {
  echo "usage: indirect-install.sh \"<connectUrl>\" [--name <host-name>]" >&2
  echo "  connectUrl: single-use pairing URL from the LLM Gateway dashboard (valid ~15m)" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) HOST_NAME="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown flag: $1" >&2; usage; exit 1 ;;
    *) if [[ -z "$CONNECT_URL" ]]; then CONNECT_URL="$1"; else echo "unexpected arg: $1" >&2; usage; exit 1; fi; shift ;;
  esac
done

if [[ -z "$CONNECT_URL" ]]; then
  echo "[indirect] missing <connectUrl>." >&2
  echo "[indirect] Dashboard -> Indirect Code -> Connect Host -> copy the Linux/macOS command." >&2
  usage; exit 1
fi

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

ASSET="indirect-code-${os}-${arch}"
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

# Optional checksum verify (best-effort: raw cache may lag a fresh push).
if command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1; then
  if curl -fsSL --max-time 15 "${REPO_RAW}/SHA256SUMS.txt" -o "$DATA_DIR/SHA256SUMS.txt" 2>/dev/null; then
    (cd "$BIN_DIR" && cp "$DATA_DIR/SHA256SUMS.txt" . 2>/dev/null || true
     (sha256sum -c --status <(grep " $ASSET\$" SHA256SUMS.txt) 2>/dev/null \
       || shasum -a 256 -c <(grep " $ASSET\$" SHA256SUMS.txt) >/dev/null 2>&1) \
     && echo "[indirect] checksum OK" || echo "[indirect] warning: checksum mismatch (continuing)")
  fi
fi

# --- Stop previous daemon (if any) ---
if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
    echo "[indirect] stopping previous daemon (pid $old_pid) ..."
    "$BIN_DIR/indirect-code" --stop 2>/dev/null || kill "$old_pid" 2>/dev/null || true
    sleep 1
  fi
fi

# --- Pair + detach (nohup: terminal stays free) ---
ARGS=(-connect "$CONNECT_URL")
[[ -n "$HOST_NAME" ]] && ARGS+=(--name "$HOST_NAME")
echo "[indirect] pairing and starting in background (log: $LOG_FILE) ..."
# shellcheck disable=SC2086
nohup "$BIN_DIR/indirect-code" "${ARGS[@]}" >>"$LOG_FILE" 2>&1 < /dev/null &
disown 2>/dev/null || true

sleep 2
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[indirect] daemon running in background (pid $(cat "$PID_FILE"))."
  echo "[indirect] Dashboard should show the host online in a few seconds."
  echo "[indirect] Stop locally anytime: ~/.indirect-code/bin/indirect-code --stop"
else
  echo "[indirect] started, but pid check failed — see $LOG_FILE" >&2
  tail -n 20 "$LOG_FILE" >&2 || true
  exit 1
fi
