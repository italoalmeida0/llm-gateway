process.env.NODE_ENV = "production";

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import tailwindPlugin from "./plugins/tailwind-plugin";
import solidPlugin from "./plugins/solid-plugin";
import iconifyPlugin from "./plugins/iconify-solid-plugin";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(ROOT, "dist");

async function build() {
  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  console.log("[build] Bundling dashboard SPA...");
  const result = await Bun.build({
    entrypoints: [path.join(ROOT, "web", "index.html")],
    outdir: distDir,
    target: "browser",
    minify: true,
    // No source maps in the published bundle: dist/ is served to the public
    // internet; a linked .map would expose the whole frontend source.
    sourcemap: "none",
    plugins: [iconifyPlugin, tailwindPlugin, solidPlugin],
  });

  if (!result.success) {
    console.error("[build] failed:");
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  // History normalize worker (standalone, outside the SPA bundle): the
  // transcript instantiates it via a static URL so large history blocks
  // parse off the main thread.
  console.log("[build] Bundling history worker...");
  const workerResult = await Bun.build({
    entrypoints: [path.join(ROOT, "web", "src", "indirect-code", "transcript", "history-worker.ts")],
    outdir: path.join(distDir, "workers"),
    target: "browser",
    minify: true,
    sourcemap: "none",
    plugins: [solidPlugin],
  });
  if (!workerResult.success) {
    console.error("[build] worker failed:");
    for (const log of workerResult.logs) console.error(log);
    process.exit(1);
  }

  // Static legal pages + any other public assets (served as-is by the backend).
  if (existsSync(path.join(ROOT, "web", "public"))) {
    cpSync(path.join(ROOT, "web", "public"), distDir, { recursive: true });
  }
  // Daemon releases staged by build-indirect-all.sh in web/public/r/ are
  // MOVED (not copied) to dist/r/: no 319MB duplication, no committed
  // staging dir. Absent in normal dev builds (skipped silently).
  {
    const staged = path.join(ROOT, "web", "public", "r");
    const dest = path.join(distDir, "r");
    if (existsSync(staged)) {
      mkdirSync(distDir, { recursive: true });
      rmSync(dest, { recursive: true, force: true });
      // renameSync = instant move on same device; fallback to copy.
      try {
        renameSync(staged, dest);
      } catch {
        cpSync(staged, dest, { recursive: true });
        rmSync(staged, { recursive: true, force: true });
      }
      console.log("[build] daemon releases moved web/public/r -> dist/r/");
    }
  }

  // Web Push Service Worker (vanilla, outside the bundle): must be served
  // from the site root so its scope covers the whole dashboard.
  const swSrc = path.join(ROOT, "web", "push-sw.js");
  if (existsSync(swSrc)) {
    cpSync(swSrc, path.join(distDir, "push-sw.js"));
    console.log("[build] push-sw.js -> dist/ (turn-end push for closed tabs)");
  }

  // pandoc.wasm (58MB office-to-markdown engine): copied from the reference
  // checkout when present; office conversion degrades gracefully without it.
  const pandocSrc = path.join(ROOT, "remote-code-ref", "chatbot", "pandoc.wasm");
  if (existsSync(pandocSrc)) {
    cpSync(pandocSrc, path.join(distDir, "pandoc.wasm"));
    console.log("[build] pandoc.wasm -> dist/ (office conversion enabled)");
  } else {
    console.log("[build] pandoc.wasm not found, office conversion disabled");
  }


  console.log(`[build] OK -> dist/ (${result.outputs.length} outputs)`);
  process.exit(0);
}

build();
