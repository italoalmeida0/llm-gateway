process.env.NODE_ENV = "production";

import { cpSync, existsSync, mkdirSync, rmSync } from "fs";
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

  // Static legal pages + any other public assets (served as-is by the backend).
  if (existsSync(path.join(ROOT, "web", "public"))) {
    cpSync(path.join(ROOT, "web", "public"), distDir, { recursive: true });
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
