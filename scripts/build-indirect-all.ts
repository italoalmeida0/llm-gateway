#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
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

const daemonLdflags = `-s -w -X main.Version=${version} -X main.launcherVersion=${version}`;

const TARGETS = [
  { goos: "linux", goarch: "amd64" },
  { goos: "linux", goarch: "arm64" },
  { goos: "darwin", goarch: "amd64" },
  { goos: "darwin", goarch: "arm64" },
  { goos: "windows", goarch: "amd64" },
  { goos: "windows", goarch: "arm64" },
];

for (const { goos, goarch } of TARGETS) {
  const ext = goos === "windows" ? ".exe" : "";
  const name = `indirect-code-${goos}-${goarch}${ext}`;

  // ONE multi-call binary per target (boot + worker roles, see cmd/daemon
  // main.go) — launcher and daemon used to be two builds.
  console.log(`==> ${name} (multi-call: boot + worker)`);
  await $`go build -trimpath -ldflags ${daemonLdflags} -o ${path.join(OUT, name)} ./cmd/daemon`
    .cwd(DAEMON_DIR)
    .env({ ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch });
}

// 2. Prune any deprecated versioned copies and legacy launcher duplicates
// (the multi-call binary replaced the separate launcher artifact).
for (const fn of readdirSync(OUT)) {
  if (/-v\d+\.\d+\.\d+/.test(fn) || fn.startsWith("indirect-launcher-")) {
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

// 4. Generate versions.json manifest. ONE artifact (the multi-call
// binary), ONE field: `daemon` carries the app assets — the update
// protocol has no separate launcher concept.
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

const manifest = {
  daemon: {
    version,
    assets: getAssets("indirect-code"),
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
