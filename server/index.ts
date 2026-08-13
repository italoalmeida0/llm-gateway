import { PORT, IS_PROD, ADMIN_EMAIL, ADMIN_PASSWORD, LIMITS, DATA_DIR } from "./config";
import { configureLimits, limits } from "./ratelimit";
import { db, audit } from "./db";
import { hashPassword, randomToken } from "./crypto";
import { ApiError, baseHeaders, clientIp, err, json } from "./http";
import { handleAuthRoute } from "./routes/auth";
import { handleMeRoute } from "./routes/me";
import { handleKeysRoute } from "./routes/keys";
import { handleUsageRoute } from "./routes/usage";
import { handleAdminRoute } from "./routes/admin";
import { handleProxy } from "./proxy/index";
import { serveStatic } from "./static";
import { flushUsage } from "./usage";

/**
 * Entry point. One Bun process serves:
 *   /v1/*   -> LLM proxy (OpenAI + Anthropic compatible)
 *   /openai/v1/*, /anthropic/v1/* -> same proxy, protocol forced by the prefix
 *   /api/*  -> dashboard REST API
 *   /*      -> built SPA + legal pages (path-traversal safe)
 */

configureLimits({
  ipPerMin: LIMITS.ipPerMin,
  authPerMin: LIMITS.authPerMinPerIp,
  resetPer10Min: LIMITS.resetPer10MinPerIp,
});

// ===== First-admin bootstrap =====

async function bootstrapAdmin(): Promise<void> {
  const count = db.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get()!.n;
  if (count > 0) return;

  let password = ADMIN_PASSWORD;
  if (!password) {
    password = `gw-${randomToken(10)}`;
    console.log("\n==============================================================");
    console.log("[BOOT] First admin created");
    console.log(`[BOOT]   email:    ${ADMIN_EMAIL}`);
    console.log(`[BOOT]   password: ${password}`);
    console.log("[BOOT] Change it immediately after first login.");
    console.log("==============================================================\n");
  } else if (password.length < 10) {
    console.error("[BOOT] FATAL: ADMIN_PASSWORD must be at least 10 characters");
    process.exit(1);
  }

  const hash = await hashPassword(password);
  db.prepare(
    "INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, 'admin', ?, ?)",
  ).run(randomToken(12), ADMIN_EMAIL.toLowerCase(), "Administrator", hash, Date.now());
  audit("admin.bootstrapped", { target: ADMIN_EMAIL });
}

await bootstrapAdmin();

// ===== Housekeeping sweeps =====

const sweep = setInterval(() => {
  const now = Date.now();
  db.prepare("DELETE FROM sessions WHERE abs_expires_at < ?").run(now);
  db.prepare("UPDATE sessions SET revoked = 1 WHERE expires_at < ? AND revoked = 0").run(now);
  db.prepare("DELETE FROM password_tokens WHERE expires_at < ? OR used_at IS NOT NULL AND used_at < ?").run(now, now - 3600_000);
}, 15 * 60_000);
sweep.unref();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`\n[BOOT] ${sig} received, flushing usage buffers...`);
    try {
      flushUsage();
    } catch {}
    process.exit(0);
  });
}

// ===== Request routing =====

async function route(req: Request, server: any): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Cheap rejects before anything else.
  if (path.includes("..")) return err(400, "bad path", req);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: baseHeaders(req) });
  }

  // Health is public but still subject to the global bucket below.
  if (path === "/api/health") {
    return json({ ok: true, ts: Date.now() }, { req });
  }

  // Global per-IP bucket — first line of DoS defense.
  const ip = clientIp(req, server);
  const retry = limits.ipPerMin(ip);
  if (retry > 0) return err(429, `rate limit exceeded, retry in ${retry}s`, req);

  if (
    path.startsWith("/v1/") ||
    path === "/v1" ||
    path.startsWith("/openai/v1/") ||
    path === "/openai/v1" ||
    path.startsWith("/anthropic/v1/") ||
    path === "/anthropic/v1"
  ) {
    return handleProxy(req, url, server);
  }

  if (path.startsWith("/api/")) {
    const viaAuth = await handleAuthRoute(path, req, server);
    if (viaAuth) return viaAuth;
    const viaMe = await handleMeRoute(path, req);
    if (viaMe) return viaMe;
    const viaKeys = await handleKeysRoute(path, req);
    if (viaKeys) return viaKeys;
    const viaUsage = await handleUsageRoute(path, req, url);
    if (viaUsage) return viaUsage;
    const viaAdmin = await handleAdminRoute(path, req, url);
    if (viaAdmin) return viaAdmin;
    return err(404, "not found", req);
  }

  if (req.method === "GET" || req.method === "HEAD") {
    const staticResp = serveStatic(req, path);
    if (staticResp) return staticResp;
  }

  return err(404, "not found", req);
}

import type { Server } from "bun";

const server: Server<undefined> = Bun.serve({
  port: PORT,
  hostname: process.env.HOST || "0.0.0.0",
  maxRequestBodySize: LIMITS.proxyBodyBytes + 64 * 1024,
  /**
   * Bun applies idleTimeout to IN-FLIGHT responses too — a paused SSE stream
   * (model thinking, no bytes flowing) counts as idle. With a short timeout
   * the socket dies mid-turn and clients retry, re-running tool actions.
   * Kept well above LIMITS.proxyStreamIdleMs (240 > 180s), under Bun's 255s
   * ceiling.
   */
  idleTimeout: 240,

  async fetch(req): Promise<Response> {
    try {
      return await route(req, server);
    } catch (e) {
      if (e instanceof ApiError) return err(e.status, e.message, req, e.code);
      console.error(`[HTTP] unhandled error on ${req.method} ${new URL(req.url).pathname}:`, e);
      return err(500, "internal error", req);
    }
  },
});

console.log(`[BOOT] llm-gateway listening on http://${server.hostname}:${server.port} (${IS_PROD ? "prod" : "dev"})`);
console.log(`[BOOT] data dir: ${DATA_DIR}`);

export { server };
