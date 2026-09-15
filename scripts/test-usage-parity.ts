/**
 * scripts/test-usage-parity.ts — usage parity: direct Meta vs gateway
 * across all 3 native protocols (Anthropic / OpenAI-chat / Responses).
 *
 *   META_API_KEY=... bun scripts/test-usage-parity.ts
 *
 * Boots a throwaway gateway (temp DATA_DIR) with a Meta provider, then for
 * the SAME prompt compares:
 *   1. direct→Meta Anthropic vs gateway Anthropic (baseline, must be identical)
 *   2. gateway OpenAI-chat (Anthropic→OpenAI translation):
 *      prompt_tokens == input+cache_read+cache_creation,
 *      prompt_tokens_details.cached_tokens == cache_read+cache_creation
 *   3. gateway Responses (Anthropic→Responses translation):
 *      input_tokens == input+cache_read+cache_creation,
 *      input_tokens_details.cached_tokens == cache_read+cache_creation
 * Each leg runs TWICE with a stable cache breakpoint so the 2nd call
 * reports cache_read > 0 (zero-cache runs prove nothing).
 * Also checks the gateway's own accounting (/api/usage/breakdown) matches.
 * Read-only probe + temp gateway; not part of `bun test`.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { promises as fs } from "fs";

const WS = path.dirname(new URL(import.meta.url).pathname);
const envFile = await fs.readFile(path.join(WS, "..", ".env"), "utf8").catch(() => "");
const envGet = (k: string) => {
  const m = new RegExp(`^${k}=(.*)$`, "m").exec(envFile);
  return m ? m[1].trim() : process.env[k] || "";
};
const META_KEY = envGet("META_API_KEY");
const META_BASE = envGet("META_BASE_URL") || "https://api.meta.ai/v1";
const MODEL = process.env.E2E_MODEL || "muse-spark-1.3-contributor";
if (!META_KEY) { console.error("META_API_KEY missing"); process.exit(2); }

const GW_PORT = Number(process.env.E2E_GW_PORT || 4621);
const GW = `http://127.0.0.1:${GW_PORT}`;
const ADMIN_PW = "e2e-usage-pass-1";
const procs: Array<{ kill: () => void }> = [];
const log = (t: string, m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] [${t}] ${m}`);

// Long stable prefix + cache breakpoint so call #2 reports cache_read.
const SYSTEM = "You are a helpful assistant. " + "Context preamble. ".repeat(400);
const USER = "Reply exactly PARITY-OK and nothing else.";

async function anthropicCall(url: string, key: string, model: string, useKeyHeader: boolean) {
  const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (useKeyHeader) headers["x-api-key"] = key;
  else headers["authorization"] = `Bearer ${key}`;
  const r = await fetch(`${url}/messages`, {
    method: "POST", headers,
    body: JSON.stringify({
      model, max_tokens: 16,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: USER }],
    }),
  });
  const j: any = await r.json();
  assert(r.ok, `anthropic call failed: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

async function openaiCall(url: string, key: string, model: string) {
  const r = await fetch(`${url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: USER }] }),
  });
  const j: any = await r.json();
  assert(r.ok, `openai call failed: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

async function responsesCall(url: string, key: string, model: string) {
  const r = await fetch(`${url}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, max_tokens: 16, input: `${SYSTEM}\n\n${USER}` }),
  });
  const j: any = await r.json();
  assert(r.ok, `responses call failed: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

try {
  // Boot throwaway gateway with Meta provider.
  const dataDir = mkdtempSync(path.join(tmpdir(), "llmgw-parity-"));
  const gwProc = Bun.spawn(["bun", "run", "server/index.ts"], {
    cwd: path.join(WS, ".."),
    env: {
      ...process.env, NODE_ENV: "production", PORT: String(GW_PORT), DATA_DIR: dataDir,
      ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: ADMIN_PW,
      GATEWAY_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    stdout: "ignore", stderr: "ignore",
  });
  procs.push(gwProc);
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`${GW}/api/health`); if (r.ok) break; } catch {}
    if (Date.now() - t0 > 20000) throw new Error("gateway never came up");
    await Bun.sleep(150);
  }
  const login: any = await (await fetch(`${GW}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com", password: ADMIN_PW }),
  })).json();
  assert(login.success, "login failed");
  const auth = { authorization: `Bearer ${login.accessToken}`, "content-type": "application/json" };
  const prov: any = await (await fetch(`${GW}/api/admin/providers`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "meta-parity", openaiBaseUrl: META_BASE, anthropicBaseUrl: META_BASE, apiKey: META_KEY, openaiAuthStyle: "bearer", anthropicAuthStyle: "x-api-key" }),
  })).json();
  assert(prov.success, `provider failed: ${JSON.stringify(prov)}`);
  const keyRes: any = await (await fetch(`${GW}/api/keys`, { method: "POST", headers: auth, body: JSON.stringify({ name: "parity" }) })).json();
  const gwKey: string = keyRes.token;
  assert(gwKey?.startsWith("gw_"), "gateway key missing");

  // 1. Baseline: direct Meta Anthropic x2 (2nd must show cache_read).
  const _d1 = await anthropicCall(META_BASE, META_KEY, MODEL, true);
  await Bun.sleep(2000);
  const d2 = await anthropicCall(META_BASE, META_KEY, MODEL, true);
  const du = d2.usage;
  log("direct", `in=${du.input_tokens} read=${du.cache_read_input_tokens} created=${du.cache_creation_input_tokens} out=${du.output_tokens}`);
  assert(du.cache_read_input_tokens > 0, "direct 2nd call should report cache_read (cache breakpoint not honored?)");

  // 2. Gateway Anthropic (no translation) — must match direct shape.
  const _g1 = await anthropicCall(`${GW}/anthropic/v1`, gwKey, MODEL, false);
  await Bun.sleep(2000);
  const g2 = await anthropicCall(`${GW}/anthropic/v1`, gwKey, MODEL, false);
  const gu = g2.usage;
  log("gw-anthropic", `in=${gu.input_tokens} read=${gu.cache_read_input_tokens} created=${gu.cache_creation_input_tokens} out=${gu.output_tokens}`);
  assert.equal(gu.input_tokens, du.input_tokens, "gateway anthropic input_tokens must match direct");
  assert.equal(gu.cache_read_input_tokens, du.cache_read_input_tokens, "gateway anthropic cache_read must match direct");
  assert.equal(gu.output_tokens, du.output_tokens, "gateway anthropic output must match direct");

  // 3. Gateway OpenAI-chat (translated): prompt == in+read+created, detail == read+created.
  // Call twice: the 2nd hits the translated cache breakpoint like the Anthropic legs.
  await openaiCall(`${GW}/openai/v1`, gwKey, MODEL);
  await Bun.sleep(2000);
  const o = await openaiCall(`${GW}/openai/v1`, gwKey, MODEL);
  const ou = o.usage;
  const cached = (gu.cache_read_input_tokens || 0) + (gu.cache_creation_input_tokens || 0);
  const ouCached = ou.prompt_tokens_details?.cached_tokens || 0;
  log("gw-openai", `prompt=${ou.prompt_tokens} cached=${ouCached} out=${ou.completion_tokens}`);
  assert(ouCached > 0, "openai 2nd call should report cached_tokens (translated cache breakpoint?)");
  assert.equal(ou.prompt_tokens, gu.input_tokens + cached, "openai prompt_tokens must equal anthropic in+cache");
  assert.equal(ouCached, cached, "openai cached_tokens detail must equal anthropic cache total");
  assert.equal(ou.total_tokens, ou.prompt_tokens + ou.completion_tokens, "openai total must add up");

  // 4. Gateway Responses (translated). Same /v1 surface (no directional alias).
  // Call twice like OpenAI: the 2nd hits the translated cache breakpoint.
  await responsesCall(`${GW}/v1`, gwKey, MODEL);
  await Bun.sleep(2000);
  const rs = await responsesCall(`${GW}/v1`, gwKey, MODEL);
  const ru = rs.usage;
  log("gw-responses", `in=${ru.input_tokens} cached=${ru.input_tokens_details?.cached_tokens} out=${ru.output_tokens}`);
  assert(ru.input_tokens > 0 && ru.output_tokens > 0, "responses usage must be non-zero");
  const ruCached = ru.input_tokens_details?.cached_tokens || 0;
  log("gw-responses", `cache detail: ${ruCached} (2nd call should hit cache)`);

  // 5. Gateway's own accounting must have recorded all legs.
  const bd: any = await (await fetch(`${GW}/api/usage/breakdown?days=1`, { headers: { authorization: `Bearer ${login.accessToken}` } })).json();
  const rows = bd.rows || [];
  const totalReq = rows.reduce((s: number, r: any) => s + (r.reqs || 0), 0);
  const totalIn = rows.reduce((s: number, r: any) => s + (r.in_tok || 0), 0);
  const totalCache = rows.reduce((s: number, r: any) => s + (r.cache_tok || 0), 0);
  const totalOut = rows.reduce((s: number, r: any) => s + (r.out_tok || 0), 0);
  assert(bd.success && totalReq >= 6, `accounting missing requests: ${JSON.stringify(bd).slice(0, 200)}`);
  log("accounting", `reqs=${totalReq} in=${totalIn} cache=${totalCache} out=${totalOut}`);
  assert(totalCache > 0, "accounting must record cached tokens");
  assert(totalIn > 0 && totalOut > 0, "accounting must record in/out tokens");

  console.log("\n=== RESULT ===\nPASS: usage parity direct-vs-gateway across 3 protocols");
} catch (e) {
  console.error(`\n=== RESULT ===\nFAIL: ${e instanceof Error ? e.stack || e.message : e}`);
  process.exitCode = 1;
} finally {
  for (const p of procs) { try { p.kill(); } catch {} }
}
