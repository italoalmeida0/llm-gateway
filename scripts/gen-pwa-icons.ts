#!/usr/bin/env bun
/**
 * One-shot PWA icon generator: rasterizes web/public SVGs into the PNG icon
 * set (icon-192/512 + maskable-512 + apple-touch-icon) via headless Chromium
 * screenshot. No runtime dependency — run manually after touching the source
 * SVGs, then commit the PNGs.
 *
 * Usage: bun scripts/gen-pwa-icons.ts
 */
import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, "..", "web", "public");

const CHROME =
  process.env.CHROMIUM_PATH ??
  `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;

interface Shot {
  src: string;
  file: string;
  size: number;
  /** padding fraction of the canvas kept as background (maskable safe zone) */
  padFrac: number;
  bg: string;
}

const SHOTS: Shot[] = [
  { src: "indirect-icon.svg", file: "icon-192.png", size: 192, padFrac: 0, bg: "#111315" },
  { src: "indirect-icon.svg", file: "icon-512.png", size: 512, padFrac: 0, bg: "#111315" },
  // Maskable: artwork shrunk into the ~80% safe zone over the dark tile.
  { src: "indirect-icon.svg", file: "maskable-512.png", size: 512, padFrac: 0.1, bg: "#111315" },
  { src: "indirect-icon.svg", file: "apple-touch-icon.png", size: 180, padFrac: 0, bg: "#111315" },
];

async function shot(s: Shot): Promise<void> {
  const srcPath = path.join(PUB, s.src);
  if (!existsSync(srcPath)) throw new Error(`missing ${srcPath}`);
  const svg = await Bun.file(srcPath).text();
  const inner = (s.padFrac * 100).toFixed(0);
  const html = `<!doctype html><html><body style="margin:0;background:${s.bg}"><div style="width:${s.size}px;height:${s.size}px;display:flex;align-items:center;justify-content:center;background:${s.bg}"><div style="width:calc(${s.size}px - 2*${s.size * s.padFrac}px);height:calc(${s.size}px - 2*${s.size * s.padFrac}px)">PLACEHOLDER</div></div></body></html>`.replace(
    "PLACEHOLDER",
    svg.replace(/width="[^"]*"|height="[^"]*"/g, "").replace("<svg", `<svg width="100%" height="100%"`),
  );
  void inner;
  const tmpDir = path.join(PUB, ".icon-gen");
  mkdirSync(tmpDir, { recursive: true });
  const tmpHtml = path.join(tmpDir, `${s.file}.html`);
  writeFileSync(tmpHtml, html);
  const out = path.join(tmpDir, `${s.file}`);
  const proc = Bun.spawnSync({
    cmd: [
      CHROME,
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      `--window-size=${s.size},${s.size}`,
      `--screenshot=${out}`,
      `file://${tmpHtml}`,
    ],
    stdout: "ignore",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) throw new Error(`chromium screenshot failed for ${s.file}`);
  const { rmSync, cpSync } = await import("fs");
  cpSync(out, path.join(PUB, s.file));
  rmSync(tmpDir, { recursive: true, force: true });
  console.log(`[pwa-icons] ${s.file} (${s.size}x${s.size})`);
}

for (const s of SHOTS) await shot(s);
console.log("[pwa-icons] done");
