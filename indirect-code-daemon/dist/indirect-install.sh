#!/usr/bin/env bash
# Indirect Code installer (Linux/macOS).
# Usage: curl -fsSL <gateway>/r/indirect-install.sh | bash -s -- <gateway-url> <token>

set -euo pipefail

GW="${1:?usage: indirect-install.sh <gateway-url> <token> [host-name]}"
TOK="${2:?usage: indirect-install.sh <gateway-url> <token> [host-name]}"
HOST_NAME="${3:-$(hostname 2>/dev/null || echo "")}"
GW="${GW%/}"

ROOT="$HOME/.indirect-code"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"
ILOG="$LOGS/install.log"

exec > >(tee -a "$ILOG") 2>&1

step() { printf '%s ... ' "$1"; }
ok() { echo "done"; }
fail() { echo "FAILED"; echo "Error: $1" >&2; echo "See $ILOG for details." >&2; exit 1; }

step "Preparing"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$OS" in
  linux) GOOS=linux ;;
  darwin) GOOS=darwin ;;
  *) fail "unsupported OS: $OS" ;;
esac
case "$ARCH" in
  x86_64|amd64) GOARCH=amd64 ;;
  arm64|aarch64) GOARCH=arm64 ;;
  *) fail "unsupported arch: $ARCH" ;;
esac
ASSET="indirect-code-$GOOS-$GOARCH"
ok

have() { command -v "$1" >/dev/null 2>&1; }
fetch() { 
  if have curl; then curl -fsSL --retry 3 "$1" -o "$2"
  elif have wget; then wget -qO "$2" "$1"
  else fail "need curl or wget to download the app"; fi
}

ACTIVE=""
if [ -f "$ROOT/slots/active" ]; then
  ACTIVE="$(tr -d ' \n\r' < "$ROOT/slots/active" | grep -o '[ab]' | head -n1 || true)"
fi
if [ -z "$ACTIVE" ]; then
  for s in a b; do
    PIDF="$ROOT/slots/slot-$s/daemon.pid"
    if [ -f "$PIDF" ]; then
      PID="$(tr -d ' \n\r' < "$PIDF" || true)"
      if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then ACTIVE="$s"; break; fi
    fi
  done
fi
if [ -z "$ACTIVE" ]; then
  NEWEST=""; NEWTIME=0
  for s in a b; do
    D="$ROOT/slots/slot-$s"
    if [ -d "$D" ]; then
      T="$(stat -c %Y "$D/sessions" 2>/dev/null || stat -f %m "$D/sessions" 2>/dev/null || stat -c %Y "$D" 2>/dev/null || stat -f %m "$D" 2>/dev/null || echo 0)"
      if [ "$T" -gt "$NEWTIME" ]; then NEWTIME="$T"; NEWEST="$s"; fi
    fi
  done
  ACTIVE="${NEWEST:-a}"
fi


for s in "$ACTIVE" a b; do
  PIDF="$ROOT/slots/slot-$s/daemon.pid"
  [ -f "$PIDF" ] || continue
  PID="$(tr -d ' \n\r' < "$PIDF" || true)"
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 25); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
    kill -9 "$PID" 2>/dev/null || true
  fi
done

step "Downloading app"
SLOTDIR="$ROOT/slots/slot-$ACTIVE"
mkdir -p "$SLOTDIR/bin" "$LOGS" "$ROOT/brain" "$ROOT/external"
TMP="$(mktemp "$SLOTDIR/bin/.app-XXXXXX")"
trap 'rm -f "$TMP"' EXIT
fetch "$GW/r/$ASSET?u=install-$(date +%s)" "$TMP" || fail "could not download $ASSET from $GW"
chmod +x "$TMP"
"$TMP" --version 2>&1 | grep -q "boot" || fail "downloaded file is not the app (bad gateway response?)"
mv -f "$TMP" "$SLOTDIR/bin/$ASSET"
trap - EXIT
ok


echo "Starting ..."
CONNECT_ARGS=(-connect "$GW/api/indirect-code/connect/$TOK")
[ -n "$HOST_NAME" ] && CONNECT_ARGS+=(--name "$HOST_NAME")

nohup "$SLOTDIR/bin/$ASSET" "${CONNECT_ARGS[@]}" >>"$LOGS/daemon.log" 2>&1 < /dev/null &
disown 2>/dev/null || true
echo "done"
echo "Running in the background - the dashboard shows this host online in a few seconds."
