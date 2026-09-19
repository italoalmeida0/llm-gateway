// Shared helpers for Indirect-Code E2E scripts on Windows + Linux.
//
// The crash-chaos script carries its own inline copies (it predates this
// module and already passes on both platforms — don't touch it). New and
// ported scripts (lifecycle, gateway-death, handoff) import from here so
// platform quirks live in exactly one place.
//
//   import { IS_WIN, PLAT, DAEMON_BIN, LAUNCHER_BIN, GO_BIN, buildBin, killAll, copyDir, exe } from "./indirect-e2e-win";
//   import { cdpFrontend } from "./indirect-e2e-win"; // browser phases
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const IS_WIN = process.platform === "win32";

// Platform key as used in dist/r/versions.json manifests:
// "<os>-<arch>" with os in {darwin, linux, windows}.
export const PLAT =
  `${process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux"}-${process.arch === "arm64" ? "arm64" : "amd64"}`;

// Slot binary names (daemon layout.go: slotBinName/slotLauncherName).
export const DAEMON_BIN = IS_WIN ? "indirect-code.exe" : `indirect-code-${PLAT}`;
export const LAUNCHER_BIN = IS_WIN ? "indirect-launcher.exe" : `indirect-launcher-${PLAT}`;

// Go binary: PATH on unix; on Windows resolve via `where go` at runtime
// (a remote-exec channel may not inherit the user's PATH, and hardcoded
// shim paths break across machines).
function goBin(): string {
  if (!IS_WIN) return "go";
  if (process.env.GO_BIN) return process.env.GO_BIN;
  try {
    const out = execFileSync("where", ["go"], { encoding: "utf8" });
    // `where` output ends with CRLF: trim so the path has no stray \r
    // (uv_spawn ENOENT otherwise).
    const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    if (first) return first.trim();
  } catch {}
  return "go";
}
export const GO_BIN = goBin();

// Append .exe on Windows (Go adds it automatically on `go build -o`, but
// Node's spawn/CreateProcess needs the full name to resolve the file).
export function exe(p: string): string {
  return IS_WIN && !p.endsWith(".exe") ? p + ".exe" : p;
}

// `go build -trimpath -ldflags "-s -w -X main.<vvar>=<ver>" -o <out> <pkg>`
// in the daemon dir. Returns the actual output path (with .exe on win).
export function buildBin(pkg: string, ver: string, out: string, vvar: string, daemonDir: string): string {
  const finalOut = exe(out);
  execFileSync(GO_BIN, ["build", "-trimpath", "-ldflags", `-s -w -X main.${vvar}=${ver}`, "-o", finalOut, pkg], { cwd: daemonDir, stdio: "pipe" });
  return finalOut;
}

// Recursive dir copy (node:fs only — no `cp -r`, missing on Windows).
export function copyDir(src: string, dst: string) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src)) {
    const s = join(src, e), d = join(dst, e);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

// Kill ONLY processes whose command line mentions the test work dir.
// Never kill by image name alone: on a shared machine that would murder
// the owner's REAL running daemon too (caught live on a Surface — the
// chaos run killed the production indirect-code next to the test).
export function killAll(work: string) {
  if (IS_WIN) {
    try {
      const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${work.replace(/'/g, "''")}*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }`;
      execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
    } catch {}
    return;
  }
  try {
    const out = execFileSync("ps", ["-eo", "pid,args"], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      if (line.includes(work) && !line.includes("ps -eo")) {
        const pid = parseInt(line.trim().split(/\s+/)[0], 10);
        if (pid > 0 && pid !== process.pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
      }
    }
  } catch {}
}

// SIGKILL on unix, taskkill /F on Windows (no SIGKILL there;
// proc.kill("SIGKILL") on win is just TerminateProcess anyway).
export function kill9(pid: number) {
  if (IS_WIN) {
    try { execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }); } catch {}
    return;
  }
  try { process.kill(pid, "SIGKILL"); } catch {}
}

// Spawn helper that also kills a single proc handle cross-platform.
export function killProc(p: any) {
  try {
    if (IS_WIN) kill9(p.pid);
    else p.kill("SIGKILL");
  } catch {}
}

// HOME override that works on both platforms (Go reads %USERPROFILE%
// on Windows, $HOME is ignored there — set both).
export function homeEnv(home: string): Record<string, string> {
  if (IS_WIN) return { HOME: home, USERPROFILE: home };
  return { HOME: home };
}

// ---------------------------------------------------------------------------
// Browser phases via the Bun CDP automation server (Windows).
//
// The Surface runs a persistent Bun browser server
// (bun-browser-server, default http://127.0.0.1:3000) driving real
// Chrome over native CDP — no Playwright needed. These helpers mirror
// the small Playwright subset the lifecycle frontend phase uses:
// navigate, eval (localStorage login), reload, count buttons, click
// settings, Escape, page content, console errors, close.
//
// On Linux the scripts keep using Playwright; this adapter only runs
// when BROWSER_API is set (or IS_WIN with the server reachable).
// ---------------------------------------------------------------------------

const BROWSER_API = process.env.BROWSER_API || (IS_WIN ? "http://127.0.0.1:3000" : "");

async function api(method: string, path: string, body?: any): Promise<any> {
  const r = await fetch(`${BROWSER_API}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { _raw: text, _status: r.status }; }
}

// Frontend phase driver: opens the gateway #/code UI in a fresh tab,
// logs in via localStorage JWT, counts sidebar buttons, opens Settings,
// asserts zero console errors. Returns { buttons, settingsSeen, updateSeen }.
export async function cdpFrontend(gw: string, jwt: string, log: (tag: string, msg: string) => void): Promise<{ buttons: number; settingsSeen: boolean; updateSeen: boolean }> {
  if (!BROWSER_API) throw new Error("BROWSER_API not set (no browser server)");
  const st: any = await api("GET", "/api/status");
  log("frontend", `browser server: ${st?.browser?.name || "?"} headless=${st?.headless} tabs=${st?.openTabsCount}`);
  const tab: any = await api("POST", "/api/tabs", { url: `${gw}/#/code` });
  if (!tab?.id) throw new Error(`tab open failed: ${JSON.stringify(tab).slice(0, 200)}`);
  const id = tab.id;
  try {
    await api("POST", `/api/tabs/${id}/navigate`, { url: `${gw}/#/code`, waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 4000));
    await api("POST", `/api/tabs/${id}/eval`, { script: `localStorage.setItem("llmgw-access", ${JSON.stringify(jwt)})` });
    await api("POST", `/api/tabs/${id}/navigate`, { url: `${gw}/#/code`, waitUntil: "load" });
    await new Promise((r) => setTimeout(r, 5000));
    const q: any = await api("GET", `/api/tabs/${id}/query?selector=${encodeURIComponent("aside button")}&limit=50`);
    const buttons = Array.isArray(q) ? q.length : (q?.elements?.length ?? q?.count ?? 0);
    log("frontend", `sidebar buttons: ${buttons}`);
    // Settings modal: click the first settings-ish button, read content.
    const settingsClick: any = await api("POST", `/api/tabs/${id}/click`, { selector: 'button[aria-label*="ettings"]' });
    if (!settingsClick?.success) {
      await api("POST", `/api/tabs/${id}/click`, { selector: "aside button" });
    }
    await new Promise((r) => setTimeout(r, 2000));
    const content: any = await api("GET", `/api/tabs/${id}/content?type=html`);
    const html = typeof content === "string" ? content : (content?.html ?? content?._raw ?? "");
    const settingsSeen = /Daemon|daemon/.test(html);
    const updateSeen = /pdate/.test(html);
    log("frontend", `settings open: ${settingsSeen}, update text present: ${updateSeen}`);
    await api("POST", `/api/tabs/${id}/key`, { key: "Escape" }).catch(() => ({}));
    const consoleLog: any = await api("GET", `/api/tabs/${id}/console`);
    const errs = Array.isArray(consoleLog)
      ? consoleLog.filter((m: any) => /error/i.test(m?.type || m?.level || ""))
      : [];
    if (errs.length > 0) throw new Error(`console errors: ${errs.slice(0, 3).map((e: any) => JSON.stringify(e).slice(0, 200)).join("; ")}`);
    log("frontend", "zero console errors, host switch + settings OK");
    return { buttons, settingsSeen, updateSeen };
  } finally {
    await api("DELETE", `/api/tabs/${id}`).catch(() => ({}));
  }
}

// Minimal snapshot/click/type helpers (for future settings-click phases).
export const cdp = { api };
export { spawn };
