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

import app from "./web/index.html";

const port = Number(Bun.argv[2] || 5700);
const API = process.env.GATEWAY_API || "http://localhost:3000";

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

    try {
      const file = Bun.file(`.${decodeURIComponent(url.pathname)}`);
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
