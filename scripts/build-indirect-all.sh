#!/usr/bin/env bash
# Build all Indirect Code daemon binaries into indirect-code-daemon/dist/.
# Run from the repo root:  bash scripts/build-indirect-all.sh
# Then commit dist/ so the install scripts can curl from raw.githubusercontent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON_DIR="$ROOT/indirect-code-daemon"
OUT="$DAEMON_DIR/dist"
mkdir -p "$OUT"
# Version: MANUAL — bump indirect-code-daemon/dist/versions.json (daemon.version)
# before building a release, or pass INDIRECT_VERSION=x. The build stamps
# this version into the daemon (-X main.daemonVersion) and regenerates the
# manifest with it, so binary + manifest always agree. Do NOT auto-bump
# (timestamps etc.): every build must be reproducible for a given version.
# NOTE: cmd/launcher is its own main package (no daemonVersion var), so
# launcher builds use plain LDFLAGS; only the daemon gets the stamp.
VERSION="${INDIRECT_VERSION:-$(python3 -c 'import json, os; print(json.load(open(os.path.join("'"$OUT"'", "versions.json")))["daemon"]["version"])' 2>/dev/null || echo "1.0.0")}"
echo "==> Building Indirect Code v${VERSION}"

# Keep binaries small: ~100MB total for 6 targets matters in git history.
LDFLAGS="-s -w"
DAEMON_LDFLAGS="-s -w -X main.daemonVersion=${VERSION}"
LAUNCHER_LDFLAGS="-s -w -X main.launcherVersion=${VERSION}"
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
  echo "==> $name (daemon)"
  (cd "$DAEMON_DIR" && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "$DAEMON_LDFLAGS" -o "dist/$name" ./cmd/daemon)
  lname="indirect-launcher-${goos}-${goarch}"
  [[ "$goos" == "windows" ]] && lname="${lname}.exe"
  echo "==> $lname (launcher)"
  (cd "$DAEMON_DIR" && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -ldflags "$LAUNCHER_LDFLAGS" -o "dist/$lname" ./cmd/launcher)
  # Versioned copies (immutable URLs): update downloads these first, so CDN
  # cache can never serve stale bytes for a version. Floating names stay
  # for install.sh (first install = latest, no version known).
  vname="indirect-code-${goos}-${goarch}-v${VERSION}"
  vlname="indirect-launcher-${goos}-${goarch}-v${VERSION}"
  [[ "$goos" == "windows" ]] && { vname="${vname}.exe"; vlname="${vlname}.exe"; }
  cp "$OUT/$name" "$OUT/$vname"
  cp "$OUT/$lname" "$OUT/$vlname"
done

# Keep only current + previous versioned copies (git history would explode:
# ~12MB x 2 binaries x 2 names x 6 platforms per release).
python3 - "$OUT" "$VERSION" <<'PYEOF'
import json, os, re, sys
out, version = sys.argv[1], sys.argv[2]
# prune versioned copies except current + previous
vers = set()
for fn in os.listdir(out):
    m = re.search(r'-v(\d+\.\d+\.\d+)(\.exe)?$', fn)
    if m:
        vers.add(m.group(1))
def vkey(v):
    return tuple(int(x) for x in v.split('.'))
keep = set(sorted(vers, key=vkey)[-2:]) | {version}
for fn in os.listdir(out):
    m = re.search(r'-v(\d+\.\d+\.\d+)(\.exe)?$', fn)
    if m and m.group(1) not in keep:
        os.remove(os.path.join(out, fn))
        print("pruned", fn)
PYEOF

(cd "$OUT" && sha256sum indirect-code-* indirect-launcher-* > SHA256SUMS.txt)

# versions.json: self-update manifest (daemon + launcher check this).
python3 - "$OUT" "$VERSION" <<'PYEOF'
import json, os, sys
out, version = sys.argv[1], sys.argv[2]
sums = {}
with open(os.path.join(out, "SHA256SUMS.txt")) as f:
    for line in f:
        parts = line.split()
        if len(parts) == 2:
            sums[parts[1]] = parts[0]
def assets(prefix):
    return {fn[len(prefix)+1:].removesuffix(".exe"): fn
            for fn in sorted(sums) if fn.startswith(prefix + "-") and "-v" not in fn}
def assets_versioned(prefix, version):
    return {fn[len(prefix)+1:].removesuffix(".exe"): fn
            for fn in sorted(sums) if fn.startswith(prefix + "-") and fn.endswith(f"-v{version}") or fn.endswith(f"-v{version}.exe")}
manifest = {
    "daemon": {"version": version, "assets": assets("indirect-code"), "assetsVersioned": assets_versioned("indirect-code", version), "sums": sums},
    "launcher": {"version": version, "assets": assets("indirect-launcher"), "assetsVersioned": assets_versioned("indirect-launcher", version), "sums": sums},
}
with open(os.path.join(out, "versions.json"), "w") as f:
    json.dump(manifest, f, indent=2)
print("==> versions.json:", version)
PYEOF
echo "==> sizes:"; ls -lh "$OUT"
