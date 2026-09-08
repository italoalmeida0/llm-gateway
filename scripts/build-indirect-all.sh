#!/usr/bin/env bash
# Build all Indirect Code daemon binaries into indirect-code-daemon/dist/.
# Run from the repo root:  bash scripts/build-indirect-all.sh
# Then commit dist/ so the install scripts can curl from raw.githubusercontent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON_DIR="$ROOT/indirect-code-daemon"
OUT="$DAEMON_DIR/dist"
mkdir -p "$OUT"

# Keep binaries small: ~100MB total for 6 targets matters in git history.
LDFLAGS="-s -w"
TARGETS=(
  "linux amd64"
  "linux arm64"
  "darwin amd64"
  "darwin arm64"
  "windows amd64"
  "windows arm64"
)

for target in "${TARGETS[@]}"; do
  set -- $target
  goos="$1"; goarch="$2"
  name="indirect-code-${goos}-${goarch}"
  [[ "$goos" == "windows" ]] && name="${name}.exe"
  echo "==> $name"
  (cd "$DAEMON_DIR" && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "$LDFLAGS" -o "dist/$name" ./cmd/daemon)
done

(cd "$OUT" && sha256sum indirect-code-* > SHA256SUMS.txt)
echo "==> sizes:"; ls -lh "$OUT"
