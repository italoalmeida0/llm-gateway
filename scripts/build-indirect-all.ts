#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { $ } from "bun";

const ROOT = path.resolve(import.meta.dir, "..");
const DAEMON_DIR = path.join(ROOT, "indirect-code-daemon");
const OUT = path.join(DAEMON_DIR, "dist");
mkdirSync(OUT, { recursive: true });

// 1. Version resolution: env override -> CLI arg -> versions.json -> package.json -> 1.0.0
let version = process.env.INDIRECT_VERSION || process.argv[2];
if (!version) {
  const versionsJsonPath = path.join(OUT, "versions.json");
  try {
    const data = JSON.parse(readFileSync(versionsJsonPath, "utf-8"));
    version = data?.daemon?.version;
  } catch {}
}
if (!version) {
  const pkgPath = path.join(ROOT, "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    version = pkg.version;
  } catch {}
}
version = (version || "1.0.0").replace(/^v/, "").trim();

console.log(`==> Building Indirect Code v${version}`);

const daemonLdflags = `-s -w -X main.daemonVersion=${version}`;
const launcherLdflags = `-s -w -X main.launcherVersion=${version}`;

const TARGETS = [
  { goos: "linux", goarch: "amd64" },
  { goos: "linux", goarch: "arm64" },
  { goos: "darwin", goarch: "amd64" },
  { goos: "darwin", goarch: "arm64" },
  { goos: "windows", goarch: "amd64" },
  { goos: "windows", goarch: "arm64" },
];

for (const { goos, goarch } of TARGETS) {
  const isWin = goos === "windows";
  const ext = isWin ? ".exe" : "";
  const name = `indirect-code-${goos}-${goarch}${ext}`;
  const lname = `indirect-launcher-${goos}-${goarch}${ext}`;

  console.log(`==> ${name} (daemon)`);
  await $`go build -trimpath -ldflags ${daemonLdflags} -o ${path.join(OUT, name)} ./cmd/daemon`
    .cwd(DAEMON_DIR)
    .env({ ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch });

  console.log(`==> ${lname} (launcher)`);
  await $`go build -trimpath -ldflags ${launcherLdflags} -o ${path.join(OUT, lname)} ./cmd/launcher`
    .cwd(DAEMON_DIR)
    .env({ ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch });

  const vname = `indirect-code-${goos}-${goarch}-v${version}${ext}`;
  const vlname = `indirect-launcher-${goos}-${goarch}-v${version}${ext}`;

  copyFileSync(path.join(OUT, name), path.join(OUT, vname));
  copyFileSync(path.join(OUT, lname), path.join(OUT, vlname));
}

// 2. Prune older versioned copies (keep current + previous)
const vers = new Set<string>();
const files = readdirSync(OUT);
for (const fn of files) {
  const m = fn.match(/-v(\d+\.\d+\.\d+)(\.exe)?$/);
  if (m) vers.add(m[1]);
}

function parseSemver(v: string): number[] {
  return v.split(".").map(Number);
}

const sortedVers = Array.from(vers).sort((a, b) => {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
});

const keep = new Set([...sortedVers.slice(-2), version]);
for (const fn of readdirSync(OUT)) {
  const m = fn.match(/-v(\d+\.\d+\.\d+)(\.exe)?$/);
  if (m && !keep.has(m[1])) {
    rmSync(path.join(OUT, fn), { force: true });
    console.log(`pruned ${fn}`);
  }
}

// 3. Compute SHA256 sums natively
const sums: Record<string, string> = {};
const allFiles = readdirSync(OUT).sort();
const sumsLines: string[] = [];

for (const fn of allFiles) {
  if (fn.startsWith("indirect-code-") || fn.startsWith("indirect-launcher-")) {
    const content = readFileSync(path.join(OUT, fn));
    const hash = createHash("sha256").update(content).digest("hex");
    sums[fn] = hash;
    sumsLines.push(`${hash}  ${fn}`);
  }
}

writeFileSync(path.join(OUT, "SHA256SUMS.txt"), sumsLines.join("\n") + "\n");

// 4. Generate versions.json manifest
function getAssets(prefix: string) {
  const res: Record<string, string> = {};
  for (const fn of Object.keys(sums).sort()) {
    if (fn.startsWith(prefix + "-") && !fn.includes("-v")) {
      const key = fn.slice(prefix.length + 1).replace(/\.exe$/, "");
      res[key] = fn;
    }
  }
  return res;
}

function getAssetsVersioned(prefix: string, ver: string) {
  const res: Record<string, string> = {};
  for (const fn of Object.keys(sums).sort()) {
    if (fn.startsWith(prefix + "-") && (fn.endsWith(`-v${ver}`) || fn.endsWith(`-v${ver}.exe`))) {
      const key = fn.slice(prefix.length + 1).replace(/\.exe$/, "");
      res[key] = fn;
    }
  }
  return res;
}

const manifest = {
  daemon: {
    version,
    assets: getAssets("indirect-code"),
    assetsVersioned: getAssetsVersioned("indirect-code", version),
    sums,
  },
  launcher: {
    version,
    assets: getAssets("indirect-launcher"),
    assetsVersioned: getAssetsVersioned("indirect-launcher", version),
    sums,
  },
};

writeFileSync(path.join(OUT, "versions.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("==> versions.json:", version);

// 5. Sizes summary
console.log("==> sizes:");
for (const fn of readdirSync(OUT)) {
  const st = statSync(path.join(OUT, fn));
  const mb = (st.size / (1024 * 1024)).toFixed(1);
  console.log(`  ${fn.padEnd(45)} ${mb.padStart(6)} MB`);
}
