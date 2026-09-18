#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { $ } from "bun";

const ROOT = path.resolve(import.meta.dir, "..");

const rawVersion = process.argv[2];
if (!rawVersion || rawVersion === "--help" || rawVersion === "-h") {
  console.log(`
Usage:
  bun run release <version> [commit-message]

Examples:
  bun run release 1.1.0
  bun run release 1.2.0 "Support direct gateway-hosted binaries"
`);
  process.exit(rawVersion ? 0 : 1);
}

const version = rawVersion.replace(/^v/, "").trim();
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`[release] Error: Invalid semver version "${rawVersion}". Expected format like "1.2.0" or "v1.2.0".`);
  process.exit(1);
}

const customMsg = process.argv.slice(3).join(" ").trim();
const commitMsg = customMsg ? `Release v${version}: ${customMsg}` : `Release v${version}`;

console.log(`\n🚀 Preparing Release v${version}...`);

// 1. Check current branch
const branch = (await $`git branch --show-current`.text()).trim();
if (branch !== "main") {
  console.warn(`[release] Warning: You are on branch "${branch}", not "main".`);
}

// 2. Update package.json version
const pkgPath = path.join(ROOT, "package.json");
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  pkg.version = version;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`[release] Updated package.json version to ${version}`);
}

// 3. Build daemon binaries for all platforms
console.log(`\n📦 [1/4] Building Indirect Code daemon binaries for all platforms...`);
await $`bun ./scripts/build-indirect-all.ts ${version}`.cwd(ROOT);

// 4. Build web dashboard and populate dist/r/
console.log(`\n🌐 [2/4] Building web dashboard and staging releases to dist/r/...`);
await $`bun run build:web`.cwd(ROOT);

// 5. Run typecheck & lint gates
console.log(`\n🔍 [3/4] Running typecheck and lint gates...`);
try {
  await $`bun run typecheck`.cwd(ROOT);
  await $`bun run lint`.cwd(ROOT);
} catch (_err) {
  console.error(`\n[release] Gate check failed! Fix the issues before releasing.`);
  process.exit(1);
}

// 6. Stage, commit and push
console.log(`\n📤 [4/4] Committing and pushing to GitHub...`);
await $`git add -A`.cwd(ROOT);

// Check if anything is staged
const stagedDiff = (await $`git diff --cached --name-only`.text()).trim();
if (!stagedDiff) {
  console.log(`[release] Nothing new to commit.`);
} else {
  await $`git commit -m ${commitMsg}`.cwd(ROOT);
  console.log(`[release] Committed: "${commitMsg}"`);
  await $`git push origin main`.cwd(ROOT);
  console.log(`[release] Pushed to origin/main successfully!`);
}

console.log(`
🎉 Release v${version} published!
The VPS auto-deploy listener will detect the push, rebuild images, and serve the new binaries at:
  <gateway-url>/r/versions.json
  <gateway-url>/r/indirect-install.sh
  <gateway-url>/r/indirect-install.ps1
`);
