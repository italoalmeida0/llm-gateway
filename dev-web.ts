/**
 * Frontend dev server.
 *  - Serves the SPA through Bun's HTML imports (with the tailwind/solid plugins
 *    from bunfig.toml) with full reload on change.
 *  - Proxies /api, /v1, /openai/v1 and /anthropic/v1 to the backend (default
 *    http://localhost:3000) so the dashboard talks to the real gateway during
 *    development.
 *
 * Usage: bun ./dev-web.ts 5700
 */
import { serve } from "bun";
import path from "path";

import app from "./web/index.html";

const port = Number(Bun.argv[2] || 5700);
const API = process.env.GATEWAY_API || "http://localhost:3000";

/** Dev-only static files stay confined to the project root (no traversal,
 *  no dotfiles) — this server often listens on 0.0.0.0 on shared networks.
 *  Only frontend-ish directories are servable: server/, data/ (DB + .secret),
 *  scripts and friends must never be readable through the dev port. */
const DEV_ROOT = path.resolve(import.meta.dir);
const SERVABLE_DIRS = new Set(["web", "plugins", "dist"]);
function resolveDevFile(urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const normalized = path.normalize(decoded.replace(/^\/+/, ""));
  if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) return null;
  const segments = normalized.split(path.sep);
  if (segments.some((s) => s.startsWith("."))) return null;
  if (!SERVABLE_DIRS.has(segments[0]!)) return null;
  const full = path.join(DEV_ROOT, normalized);
  if (!full.startsWith(DEV_ROOT + path.sep)) return null;
  return full;
}

const server = serve({
  routes: { "/": app },

  async fetch(req) {
    const url = new URL(req.url);

    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/v1/") ||
      url.pathname.startsWith("/openai/v1/") ||
      url.pathname.startsWith("/anthropic/v1/")
    ) {
      const upstream = new URL(url.pathname + url.search, API);
      const headers = new Headers(req.headers);
      headers.delete("host");
      try {
        return await fetch(upstream, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
          // @ts-expect-error: Bun streaming upload
          duplex: "half",
        });
      } catch {
        return Response.json(
          { error: `dev proxy: backend unreachable at ${API} (is \`bun run dev\` running?)` },
          { status: 502 },
        );
      }
    }

    const resolved = resolveDevFile(url.pathname);
    if (!resolved) return new Response("Not found", { status: 404 });
    try {
      const file = Bun.file(resolved);
      if (!(await file.exists())) return new Response("Not found", { status: 404 });
      return new Response(file);
    } catch {
      return new Response("Internal server error", { status: 500 });
    }
  },

  development: { hmr: false, console: true },
  port,
});

console.log(`[dev-web] ${server.url}  (proxying /api,/v1,/openai/v1,/anthropic/v1 -> ${API})`);
