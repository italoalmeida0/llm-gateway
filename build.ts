process.env.NODE_ENV = "production";

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
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
  // Daemon releases into dist/r/ (public static: <gateway>/r/...).
  // Gateway-first updates/installs with zero new endpoints — static.ts
  // already hardens traversal/MIME/cache. No GitHub dependency.
  {
    const staged = path.join(ROOT, "web", "public", "r");
    const daemonDist = path.join(ROOT, "indirect-code-daemon", "dist");
    const dest = path.join(distDir, "r");
    mkdirSync(dest, { recursive: true });

    let rCount = 0;
    const copied = new Set<string>();

    if (existsSync(staged)) {
      for (const f of readdirSync(staged)) {
        if (/^(indirect-(code|launcher)-|versions\.json|SHA256SUMS\.txt|indirect-install\.)/.test(f)) {
          cpSync(path.join(staged, f), path.join(dest, f));
          copied.add(f);
          rCount++;
        }
      }
    }

    if (existsSync(daemonDist)) {
      for (const f of readdirSync(daemonDist)) {
        if (!copied.has(f) && /^(indirect-(code|launcher)-|versions\.json|SHA256SUMS\.txt|indirect-install\.)/.test(f)) {
          cpSync(path.join(daemonDist, f), path.join(dest, f));
          rCount++;
        }
      }
    }

    if (rCount > 0) {
      console.log(`[build] daemon releases -> dist/r/ (${rCount} files)`);
    }
  }

  // Web Push Service Worker (vanilla, outside the bundle): must be served
  // from the site root so its scope covers the whole dashboard.
  const swSrc = path.join(ROOT, "web", "push-sw.js");
  if (existsSync(swSrc)) {
    cpSync(swSrc, path.join(distDir, "push-sw.js"));
    console.log("[build] push-sw.js -> dist/ (turn-end push for closed tabs)");
  }

  // PWA install surface: Bun's HTML bundler resolves <link href> as build
  // inputs, so the manifest/apple-touch links live behind a <!--PWA-HEAD-->
  // placeholder in web/index.html and are injected here (same absolute
  // paths the dev server serves from web/public/).
  {
    const { readFileSync, writeFileSync } = await import("fs");
    const distHtml = path.join(distDir, "index.html");
    const pwaHead = [
      '<link rel="manifest" href="/manifest.webmanifest" />',
      '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />',
    ].join("\n    ");
    const html = readFileSync(distHtml, "utf-8");
    if (!html.includes("<!--PWA-HEAD-->")) {
      console.error("[build] PWA placeholder missing in dist/index.html");
      process.exit(1);
    }
    writeFileSync(distHtml, html.replace("<!--PWA-HEAD-->", pwaHead));
    console.log("[build] PWA head injected into dist/index.html");
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
