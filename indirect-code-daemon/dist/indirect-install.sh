#!/usr/bin/env bash
# Indirect Code installer (Linux/macOS).
# Usage: curl -fsSL <gateway>/r/indirect-install.sh | bash -s -- <gateway-url> <token>
#
# The script does the MINIMUM to boot the launcher; the launcher owns the
# house (repairs broken installs, adopts stray state, picks the active
# slot). Worst case — even a broken update — a manual reinstall recovers
# to bootable.
#
# Layout (canonical):
#   ~/.indirect-code/
#     brain/  slots/{active,slot-a,slot-b}/  logs/  external/
#
# Output contract: quiet on success (one line per step, "done" at the end).
# Full detail always lands in logs/install.log; errors print what failed
# and where the log is.
set -euo pipefail

GW="${1:?usage: indirect-install.sh <gateway-url> <token>}"
TOK="${2:?usage: indirect-install.sh <gateway-url> <token>}"
GW="${GW%/}"

ROOT="$HOME/.indirect-code"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"
ILOG="$LOGS/install.log"
# Console stays quiet; everything is tee'd to the log.
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
ASSET="indirect-launcher-$GOOS-$GOARCH"
ok

have() { command -v "$1" >/dev/null 2>&1; }
fetch() { # fetch <url> <dest>
  if have curl; then curl -fsSL --retry 3 "$1" -o "$2"
  elif have wget; then wget -qO "$2" "$1"
  else fail "need curl or wget to download the launcher"; fi
}

# 1. Discover the active slot: slots/active wins; else the slot with a
#    live daemon.pid; else the freshest slot; else slot-a (fresh install).
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

# 2. Stop the running daemon (if any) so binaries can be replaced.
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

# 3. Download the launcher into the ACTIVE slot (fixed name, no -v copies).
step "Downloading launcher"
SLOTDIR="$ROOT/slots/slot-$ACTIVE"
mkdir -p "$SLOTDIR/bin" "$LOGS" "$ROOT/brain" "$ROOT/external"
TMP="$(mktemp "$SLOTDIR/bin/.launcher-XXXXXX")"
trap 'rm -f "$TMP"' EXIT
fetch "$GW/r/$ASSET?u=install-$(date +%s)" "$TMP" || fail "could not download $ASSET from $GW"
chmod +x "$TMP"
"$TMP" --version 2>&1 | grep -q "launcher" || fail "downloaded file is not a launcher (bad gateway response?)"
mv -f "$TMP" "$SLOTDIR/bin/$ASSET"
trap - EXIT
ok

# 4. Hand over: the launcher repairs the rest, fetches the daemon,
#    migrates storage, verifies, and boots.
echo "Starting ..."
CONNECT_URL="$GW/api/indirect-code/connect/$TOK"
exec "$SLOTDIR/bin/$ASSET" -connect "$CONNECT_URL"
