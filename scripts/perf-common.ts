/**
 * scripts/perf-common.ts — shared machinery for the performance suite
 * (perf-sim.ts and perf-tuning.ts).
 *
 * The scenario being simulated, per user per day (5 users, 1 provider):
 *   - 200 proxied LLM requests
 *   - 1_000_000 uncached input tokens  (avg 5_000/req)
 *   - 4_000_000 cached input tokens    (avg 20_000/req)
 *   -   200_000 output tokens          (avg 1_000/req)
 *   - spread across 3 models (claude-sonnet 50% / gpt-5-mini 30% / gpt-4o 20%)
 *   - ~50 audit_log rows (logins, refreshes, key reveals, edits, provider tests)
 *
 * History is backfilled straight into SQLite (same INSERT/UPSERT statements the
 * gateway itself runs — WAL mode, same pattern as scripts/seed-usage.ts), while
 * "today" traffic and every latency measurement go through the REAL HTTP
 * surface of a live gateway + fake upstream child process.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import path from "path";

export const ROOT = path.join(import.meta.dir, "..");

// ports are isolated per tool so both can even run back to back
export const GW_PORT = Number(process.env.PERF_GW_PORT || 5460);
export const UP_PORT = Number(process.env.PERF_UP_PORT || 5461);
export const UP2_PORT = Number(process.env.PERF_UP2_PORT || UP_PORT + 1);
export const GW = `http://127.0.0.1:${GW_PORT}`;
export const UP = `http://127.0.0.1:${UP_PORT}`;
export const UP2 = `http://127.0.0.1:${UP2_PORT}`;
export const UPSTREAM_KEY = "sk-fake-secret";
// failover-chain upstream keys (fake upstreams accept them via /__behavior)
export const KEY_A2 = "sk-fake-secret-a2";
export const KEY_A3 = "sk-fake-secret-a3";
export const UPSTREAM_KEY_B1 = "sk-fake-secret-b1";
export const KEY_B2 = "sk-fake-secret-b2";
export const ADMIN_PW = "perf-admin-password-1";
export const USER_PW = "perf-user-password-1";

export const NUM_USERS = Number(process.env.PERF_NUM_USERS || 5);
export const REQS_PER_USER_DAY = 200;
export const AUDIT_PER_USER_DAY = 50;
/** daily per-user token totals (averaged per request in genDayEvents) */
export const DAY_IN = 1_000_000;
export const DAY_CACHE = 4_000_000;
export const DAY_OUT = 200_000;

export const MODELS = [
  { proto: "anthropic", model: "claude-sonnet-4-5", weight: 50 },
  { proto: "openai", model: "gpt-5-mini", weight: 30 },
  { proto: "openai", model: "gpt-4o", weight: 20 },
] as const;
const TOTAL_WEIGHT = MODELS.reduce((s, m) => s + m.weight, 0);

export const MS_DAY = 86_400_000;

export function todayStartUTC(): number {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}

// ===== deterministic PRNG (results reproducible) =====

export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ===== process management =====

export function spawnProc(cmd: string, env: Record<string, string>) {
  return Bun.spawn({
    cmd: ["bun", cmd],
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: "ignore",
    stderr: "inherit",
  });
}

export interface Stack {
  gwProc: ReturnType<typeof spawnProc>;
  upProc: ReturnType<typeof spawnProc>;
  /** fallback-provider upstream (router/failover scenario); null in legacy runs */
  up2Proc: ReturnType<typeof spawnProc> | null;
  dataDir: string;
}

export function gatewayEnv(dataDir: string): Record<string, string> {
  return {
    PORT: String(GW_PORT),
    NODE_ENV: "development",
    DATA_DIR: dataDir,
    ADMIN_EMAIL: "perf-admin@example.com",
    ADMIN_PASSWORD: ADMIN_PW,
    LIMIT_IP_PER_MIN: "100000000",
    LIMIT_AUTH_PER_MIN: "100000000",
    DEFAULT_KEY_RPM: "100000000",
    DEFAULT_KEY_CONCURRENCY: "100000",
    STATIC_DIR: path.join(ROOT, "dist"),
  };
}

export async function startStack(dataDir: string, opts?: { fallbackUpstream?: boolean }): Promise<Stack> {
  mkdirSync(dataDir, { recursive: true });
  const upEnv = (port: number, key: string) => ({
    FAKE_UPSTREAM_PORT: String(port),
    FAKE_UPSTREAM_KEY: key,
    FAKE_UPSTREAM_LATENCY: "5",
  });
  const upProc = spawnProc("test/fake-upstream.ts", upEnv(UP_PORT, UPSTREAM_KEY));
  const up2Proc = opts?.fallbackUpstream
    ? spawnProc("test/fake-upstream.ts", upEnv(UP2_PORT, UPSTREAM_KEY_B1))
    : null;
  const gwProc = spawnProc("server/index.ts", gatewayEnv(dataDir));
  const waiting: Promise<void>[] = [waitFor(`${GW}/api/health`), waitForUpstream(UP, UPSTREAM_KEY)];
  if (up2Proc) waiting.push(waitForUpstream(UP2, UPSTREAM_KEY_B1));
  await Promise.all(waiting);
  return { gwProc, upProc, up2Proc, dataDir };
}

export async function stopStack(stack: Stack): Promise<void> {
  try { stack.gwProc.kill(); } catch {}
  try { stack.upProc.kill(); } catch {}
  try { stack.up2Proc?.kill(); } catch {}
  // drain so we don't leave zombies that keep ports busy
  await Promise.allSettled([
    stack.gwProc.exited,
    stack.upProc.exited,
    ...(stack.up2Proc ? [stack.up2Proc.exited] : []),
  ]);
}

export async function waitFor(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${url}`);
    await Bun.sleep(100);
  }
}

async function waitForUpstream(base: string, key: string): Promise<void> {
  await waitFor(`${base}/openai/v1/models`, 20_000).catch(async () => {
    const r = await fetch(`${base}/openai/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) throw new Error("upstream not ready");
  });
}

// ===== HTTP helpers =====

export async function api(pathname: string, body?: unknown, token?: string, method?: string) {
  const res = await fetch(`${GW}${pathname}`, {
    method: method ?? (body !== undefined ? "POST" : "GET"),
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null as any) };
}

export interface ProvisionedUser {
  id: string;
  email: string;
  accessToken: string;
  gwKey: string;
  keyId: string;
}

export async function provision(numUsers: number): Promise<{ adminToken: string; users: ProvisionedUser[] }> {
  const must = (cond: boolean, label: string, extra?: unknown) => {
    if (!cond) throw new Error(`provisioning failed at ${label}: ${JSON.stringify(extra)}`);
  };

  const login = await api("/api/auth/login", { email: "perf-admin@example.com", password: ADMIN_PW });
  must(login.status === 200, "admin login", login.json);
  const adminToken: string = login.json.accessToken;

  const p = await api(
    "/api/admin/providers",
    {
      name: "perf-provider",
      openaiBaseUrl: `${UP}/openai/v1`,
      anthropicBaseUrl: `${UP}/anthropic/v1`,
      apiKey: UPSTREAM_KEY,
    },
    adminToken,
  );
  must(p.status === 200, "create provider", p.json);

  const users: ProvisionedUser[] = [];
  for (let i = 0; i < numUsers; i++) {
    const email = `perf-user${i}@example.com`;
    const created = await api(
      "/api/admin/users",
      { email, name: `Perf User ${i}`, role: "user", sendInvite: true },
      adminToken,
    );
    must(created.status === 200, `create user ${i}`, created.json);
    const inviteToken = decodeURIComponent(String(created.json.invite.link).split("token=")[1]);
    const set = await api("/api/auth/password-reset/confirm", { token: inviteToken, password: USER_PW });
    must(set.status === 200, `set password ${i}`, set.json);
    const uLogin = await api("/api/auth/login", { email, password: USER_PW });
    must(uLogin.status === 200, `user login ${i}`, uLogin.json);
    const accessToken: string = uLogin.json.accessToken;
    const keyResp = await api("/api/keys", { name: "main" }, accessToken);
    must(keyResp.status === 200, `create key ${i}`, keyResp.json);
    users.push({
      id: created.json.user.id,
      email,
      accessToken,
      gwKey: keyResp.json.token,
      keyId: keyResp.json.key.id,
    });
  }
  return { adminToken, users };
}

/**
 * Tokens rotate/expire with the process lifetime only via refresh — but when we
 * re-attach to an existing data dir (perf-tuning measure) we must log in again.
 */
export async function relogin(numUsers: number): Promise<{ adminToken: string; users: { id: string; email: string; accessToken: string }[] }> {
  const login = await api("/api/auth/login", { email: "perf-admin@example.com", password: ADMIN_PW });
  if (login.status !== 200) throw new Error(`admin re-login failed: ${JSON.stringify(login.json)}`);
  const adminToken: string = login.json.accessToken;
  const users = [];
  for (let i = 0; i < numUsers; i++) {
    const email = `perf-user${i}@example.com`;
    const u = await api("/api/auth/login", { email, password: USER_PW });
    if (u.status !== 200) throw new Error(`user re-login failed ${i}: ${JSON.stringify(u.json)}`);
    users.push({ id: "", email, accessToken: u.json.accessToken });
  }
  return { adminToken, users };
}

// ===== router + failover provisioning (new architecture) =====

export interface RouterTopology {
  providerA: string; // primary (3 upstream keys)
  providerB: string; // fallback (2 upstream keys)
  keyA1: string;     // provider-key row ids, priority order
  keyA2: string;
  keyA3: string;
  keyB1: string;
  keyB2: string;
}

export interface RouterProvision {
  adminToken: string;
  users: ProvisionedUser[];
  topo: RouterTopology;
}

/**
 * Provision the NEW architecture: routing_mode=router, a model registry with
 * per-model cross-provider target chains, and multi-key failover per provider.
 *
 *   provider A (primary,  upstream = UP ) — keys A1,A2,A3 (priority 0,10,20)
 *   provider B (fallback, upstream = UP2) — keys B1,B2
 *   3 public models, each with targets [A(<same id>), B(fb-<id>)]
 *     → top-1 attempt keeps byte-fidelity (no model rewrite); the fallback
 *       target renames the model, exercising the router rewrite path.
 */
export async function provisionRouter(numUsers: number): Promise<RouterProvision> {
  const must = (cond: boolean, label: string, extra?: unknown) => {
    if (!cond) throw new Error(`provisioning failed at ${label}: ${JSON.stringify(extra)}`);
  };

  const login = await api("/api/auth/login", { email: "perf-admin@example.com", password: ADMIN_PW });
  must(login.status === 200, "admin login", login.json);
  const adminToken: string = login.json.accessToken;

  const mkProvider = async (name: string, base: string, key: string): Promise<{ id: string; primaryKeyId: string }> => {
    const p = await api(
      "/api/admin/providers",
      { name, openaiBaseUrl: `${base}/openai/v1`, anthropicBaseUrl: `${base}/anthropic/v1`, apiKey: key },
      adminToken,
    );
    must(p.status === 200, `create provider ${name}`, p.json);
    return {
      id: p.json.provider.id as string,
      primaryKeyId: (p.json.provider.keys as any[])[0].id as string,
    };
  };
  const addKey = async (providerId: string, apiKey: string, label: string): Promise<string> => {
    const k = await api(`/api/admin/providers/${providerId}/keys`, { apiKey, label }, adminToken);
    must(k.status === 200, `add key ${label}`, k.json);
    return k.json.key.id as string;
  };
  // extra upstream credentials are accepted by the fake providers via /__behavior
  const accept = async (base: string, secret: string) => {
    const r = await fetch(`${base}/__behavior`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret }),
    });
    if (!r.ok) throw new Error(`upstream ${base} refused secret ${secret}`);
  };

  const provA = await mkProvider("perf-primary", UP, UPSTREAM_KEY);
  const providerA = provA.id;
  const keyA1 = provA.primaryKeyId;
  await accept(UP, KEY_A2);
  await accept(UP, KEY_A3);
  const keyA2 = await addKey(providerA, KEY_A2, "secondary");
  const keyA3 = await addKey(providerA, KEY_A3, "tertiary");

  const provB = await mkProvider("perf-fallback", UP2, UPSTREAM_KEY_B1);
  const providerB = provB.id;
  const keyB1 = provB.primaryKeyId;
  await accept(UP2, KEY_B2);
  const keyB2 = await addKey(providerB, KEY_B2, "secondary");

  // model registry: 3 public models, each with an A→B failover chain
  const chain = (id: string) => [
    { providerId: providerA, upstreamModel: id },
    { providerId: providerB, upstreamModel: `fb-${id}` },
  ];
  for (const m of MODELS) {
    const created = await api(
      "/api/admin/models",
      { id: m.model, proto: m.proto, targets: chain(m.model) },
      adminToken,
    );
    must(created.status === 200, `create model ${m.model}`, created.json);
  }
  const mode = await api("/api/admin/settings", { routingMode: "router" }, adminToken, "PATCH");
  must(mode.status === 200, "set routing_mode=router", mode.json);

  const users: ProvisionedUser[] = [];
  for (let i = 0; i < numUsers; i++) {
    const email = `perf-user${i}@example.com`;
    const created = await api(
      "/api/admin/users",
      { email, name: `Perf User ${i}`, role: "user", sendInvite: true },
      adminToken,
    );
    must(created.status === 200, `create user ${i}`, created.json);
    const inviteToken = decodeURIComponent(String(created.json.invite.link).split("token=")[1]);
    const set = await api("/api/auth/password-reset/confirm", { token: inviteToken, password: USER_PW });
    must(set.status === 200, `set password ${i}`, set.json);
    const uLogin = await api("/api/auth/login", { email, password: USER_PW });
    must(uLogin.status === 200, `user login ${i}`, uLogin.json);
    const accessToken: string = uLogin.json.accessToken;
    const keyResp = await api("/api/keys", { name: "main" }, accessToken);
    must(keyResp.status === 200, `create key ${i}`, keyResp.json);
    users.push({
      id: created.json.user.id,
      email,
      accessToken,
      gwKey: keyResp.json.token,
      keyId: keyResp.json.key.id,
    });
  }
  return {
    adminToken,
    users,
    topo: { providerA, providerB, keyA1, keyA2, keyA3, keyB1, keyB2 },
  };
}

// ---- failover probe helpers ----

/** Force a fake-upstream key to fail (`failWith`) or behave normally (null). */
export async function setUpstreamFail(base: string, secret: string, failWith: { status: number; message?: string } | null): Promise<void> {
  const r = await fetch(`${base}/__behavior`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, failWith }),
  });
  if (!r.ok) throw new Error(`__behavior failed for ${secret}`);
}

/** Per-secret hit counters of a fake upstream. */
export async function upstreamHits(base: string): Promise<Record<string, number>> {
  return await (await fetch(`${base}/__hits`)).json();
}

/** Admin re-enable: wipes fail_count/cooldown/exhausted + clears the live overlay. */
export async function resetKeyState(adminToken: string, providerId: string, keyId: string): Promise<void> {
  const res = await fetch(`${GW}/api/admin/providers/${providerId}/keys/${keyId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ status: "active" }),
  });
  if (!res.ok) throw new Error(`resetKeyState failed: ${res.status}`);
}

// ---- registry growth (catalog churn over the simulated years) ----

export const CATALOG_PER_QUARTER = 2; // openrouter-style catalog additions every ~90 days

/**
 * Directly insert historical `models` + `model_targets` rows (same shape the
 * admin API writes — mirror rule included) to simulate catalog churn:
 * +CATALOG_PER_QUARTER models per 90-day quarter of the simulated past.
 */
export function backfillRegistry(
  rawDb: Database,
  providerId: string,
  daysAlready: number,
  days: number,
  existing: number,
): number {
  const insertModel = rawDb.prepare(
    `INSERT OR IGNORE INTO models
       (id, provider_id, upstream_model, proto, name, description, hugging_face_id,
        quantization, openrouter_slug, always_on, enabled, context_length,
        max_output_length, created, input_modalities, output_modalities,
        sampling_params, features, reasoning_efforts, pricing, datacenters,
        source, created_at, updated_at)
     VALUES (?, ?, ?, 'openai', ?, '', '', '', '', 0, 1, NULL, NULL, NULL,
             '["text"]', '["text"]', '[]', '[]', NULL, NULL, NULL, 'manual', ?, ?)`,
  );
  const insertTarget = rawDb.prepare(
    "INSERT OR IGNORE INTO model_targets (model_id, provider_id, upstream_model, priority, enabled, created_at) VALUES (?, ?, ?, 0, 1, ?)",
  );
  let added = 0;
  let seq = existing;
  rawDb.transaction(() => {
    for (let d = 0; d < days; d += 90) {
      const ts = todayStartUTC() - (daysAlready + d + 1) * MS_DAY;
      for (let q = 0; q < CATALOG_PER_QUARTER; q++) {
        seq++;
        const id = `catalog-model-${seq}`;
        insertModel.run(id, providerId, id, `Catalog Model ${seq}`, ts, ts);
        insertTarget.run(id, providerId, id, ts);
        added++;
      }
    }
  })();
  return added;
}

// ===== history generation =====

const AUDIT_ACTIONS = [
  ["auth.login.success", 18],
  ["auth.refresh", 14],
  ["key.revealed", 3],
  ["me.updated", 2],
  ["provider.tested", 2],
  ["key.updated", 2],
  ["auth.logout", 4],
  ["key.created", 1],
  ["key.revoked", 1],
  ["2fa.enabled", 1],
  ["password.changed", 2],
] as const;
const AUDIT_TOTAL = AUDIT_ACTIONS.reduce((s, a) => s + a[1], 0);

const STATUSES = [
  [200, 940],
  [400, 20],
  [429, 15],
  [500, 15],
  [502, 10],
] as const;
const STATUS_TOTAL = STATUSES.reduce((s, st) => s + st[1], 0);

function pickWeighted<T>(rnd: () => number, table: readonly (readonly [T, number])[]): T {
  let r = rnd() * table.reduce((s, row) => s + row[1], 0);
  for (const [v, w] of table) {
    r -= w;
    if (r <= 0) return v;
  }
  return table[0]![0];
}

interface DayEvent {
  ts: number;
  proto: string;
  model: string;
  inTok: number;
  cacheTok: number;
  outTok: number;
  latency: number;
  status: number;
  stream: number;
}

/** One user-day: REQS_PER_USER_DAY events hitting the daily token totals. */
export function genDayEvents(seed: number, dayStart: number): DayEvent[] {
  const rnd = mulberry32(seed);
  const n = REQS_PER_USER_DAY;
  // random multipliers, then normalized so daily sums are exact
  const wIn = Array.from({ length: n }, () => 0.25 + rnd() * 1.5);
  const wCache = Array.from({ length: n }, () => 0.25 + rnd() * 1.5);
  const wOut = Array.from({ length: n }, () => 0.25 + rnd() * 1.5);
  const sIn = wIn.reduce((a, b) => a + b, 0);
  const sCache = wCache.reduce((a, b) => a + b, 0);
  const sOut = wOut.reduce((a, b) => a + b, 0);

  const out: DayEvent[] = [];
  for (let i = 0; i < n; i++) {
    let r = rnd() * TOTAL_WEIGHT;
    let m: (typeof MODELS)[number] = MODELS[0];
    for (const cand of MODELS) {
      r -= cand.weight;
      if (r <= 0) { m = cand; break; }
    }
    // 07:00–22:59 UTC waking-hours spread
    const ts = dayStart + (7 + Math.floor(rnd() * 16)) * 3_600_000 + Math.floor(rnd() * 3_599_000);
    const status = pickWeighted(rnd, STATUSES as any) as number;
    const failed = status >= 400;
    out.push({
      ts,
      proto: m.proto,
      model: m.model,
      inTok: failed ? Math.floor(rnd() * 400) : Math.round((wIn[i]! / sIn) * DAY_IN),
      cacheTok: failed ? 0 : Math.round((wCache[i]! / sCache) * DAY_CACHE),
      outTok: failed ? 0 : Math.round((wOut[i]! / sOut) * DAY_OUT),
      latency: 350 + Math.floor(rnd() ** 2 * 24_000),
      status,
      stream: rnd() < 0.6 ? 1 : 0,
    });
  }
  return out;
}

/**
 * Backfill `days` more days of history, prepended BEFORE the already-simulated
 * span (older dates), so previously written rows never move.
 * `daysAlready` = days simulated so far; day dates run [today-(daysAlready+days) .. today-(daysAlready+1)].
 */
export function backfill(
  rawDb: Database,
  users: { id: string; keyId: string }[],
  adminId: string,
  daysAlready: number,
  days: number,
): void {
  const insertEvent = rawDb.prepare(
    `INSERT INTO usage_events (key_id, user_id, ts, proto, model, in_tok, cache_tok, out_tok, latency_ms, status, stream, estimated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  const upsertDaily = rawDb.prepare(
    `INSERT INTO usage_daily (key_id, user_id, date, in_tok, cache_tok, out_tok, reqs)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(key_id, date)
     DO UPDATE SET in_tok = in_tok + excluded.in_tok,
                   cache_tok = cache_tok + excluded.cache_tok,
                   out_tok = out_tok + excluded.out_tok,
                   reqs = reqs + 1`,
  );
  // per-model rollup (migration 006): the by-model dashboard and global stats
  // queries read this, NOT usage_events — history must populate it or the
  // simulation measures an empty table. Same upsert the proxy flush runs.
  const upsertModelDaily = rawDb.prepare(
    `INSERT INTO usage_model_daily (key_id, user_id, date, proto, model, in_tok, cache_tok, out_tok, reqs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(key_id, date, proto, model)
     DO UPDATE SET in_tok = in_tok + excluded.in_tok,
                   cache_tok = cache_tok + excluded.cache_tok,
                   out_tok = out_tok + excluded.out_tok,
                   reqs = reqs + 1`,
  );
  // Deepest rollup (migration 011): passthrough-style sim data carries no
  // provider dimension (empty strings) — mirrors the proxy flush upsert.
  const upsertModelProviderDaily = rawDb.prepare(
    `INSERT INTO usage_model_provider_daily (key_id, user_id, date, proto, provider_id, provider_key_id, model, upstream_model, in_tok, cache_tok, out_tok, reqs)
     VALUES (?, ?, ?, ?, '', '', ?, '', ?, ?, ?, 1)
     ON CONFLICT(key_id, date, proto, provider_id, provider_key_id, model, upstream_model)
     DO UPDATE SET in_tok = in_tok + excluded.in_tok,
                   cache_tok = cache_tok + excluded.cache_tok,
                   out_tok = out_tok + excluded.out_tok,
                   reqs = reqs + 1`,
  );
  const insertAudit = rawDb.prepare(
    "INSERT INTO audit_log (ts, actor_id, action, target, meta, ip) VALUES (?, ?, ?, ?, ?, ?)",
  );

  const t0 = performance.now();
  let written = 0;
  // One transaction PER DAY (not per whole span): at 100 users the largest
  // span would otherwise be ~22M inserts in a single transaction and the WAL
  // would balloon to tens of GB before the next checkpoint. Same rows, same
  // statements — only the commit granularity changes.
  const dayTx = rawDb.transaction((d: number) => {
    const dayStart = todayStartUTC() - (daysAlready + d + 1) * MS_DAY;
    const date = new Date(dayStart).toISOString().slice(0, 10);
    for (let u = 0; u < users.length; u++) {
      const user = users[u]!;
      const events = genDayEvents((u + 1) * 1_000_003 + (daysAlready + d) * 9_973, dayStart);
      for (const ev of events) {
        insertEvent.run(
          user.keyId, user.id, ev.ts, ev.proto, ev.model,
          ev.inTok, ev.cacheTok, ev.outTok, ev.latency, ev.status, ev.stream,
        );
        written++;
        // one upsert per request — exactly what the proxy's flush does
        upsertDaily.run(user.keyId, user.id, date, ev.inTok, ev.cacheTok, ev.outTok);
        upsertModelDaily.run(user.keyId, user.id, date, ev.proto, ev.model, ev.inTok, ev.cacheTok, ev.outTok);
        upsertModelProviderDaily.run(user.keyId, user.id, date, ev.proto, ev.model, ev.inTok, ev.cacheTok, ev.outTok);
      }
      // audit trail for the day (~AUDIT_PER_USER_DAY rows/user, admin chips in too)
      const rnd = mulberry32(42_000 + u * 7_777 + (daysAlready + d) * 31);
      for (let a = 0; a < AUDIT_PER_USER_DAY; a++) {
        const action = pickWeighted(rnd, AUDIT_ACTIONS as any) as string;
        const actor = rnd() < 0.08 ? adminId : user.id;
        const ts = dayStart + Math.floor(rnd() * MS_DAY * 0.9);
        insertAudit.run(ts, actor, action, rnd() < 0.3 ? user.keyId : null, null, `10.0.${u}.${Math.floor(rnd() * 254) + 1}`);
      }
    }
  });
  for (let d = 0; d < days; d++) dayTx(d);
  const ms = performance.now() - t0;
  console.log(
    `  [backfill] +${days} day(s): ${written.toLocaleString("en-US")} events ` +
      `(${users.length * AUDIT_PER_USER_DAY * days} audit rows) in ${(ms / 1000).toFixed(1)}s`,
  );
}

export function openRawDb(dataDir: string): Database {
  // create:true — the gateway owns schema/migrations; we only ever attach to
  // a DB it already created, but a fresh dir must not hard-fail on a race.
  const rawDb = new Database(path.join(dataDir, "gateway.db"));
  rawDb.exec("PRAGMA busy_timeout = 30000");
  return rawDb;
}

export function tableCounts(rawDb: Database) {
  const c = (t: string) => (rawDb.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as any).n as number;
  return {
    usage_events: c("usage_events"),
    usage_daily: c("usage_daily"),
    usage_model_daily: c("usage_model_daily"),
    usage_model_provider_daily: c("usage_model_provider_daily"),
    audit_log: c("audit_log"),
    sessions: c("sessions"),
    models: c("models"),
    model_targets: c("model_targets"),
    provider_keys: c("provider_keys"),
  };
}

// ===== latency measurement =====

export interface LatStats {
  n: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  mean: number;
  errors: number;
}

export function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

/** Sequential timed GETs — adaptive sample size so slow endpoints don't stall the run. */
export async function measureGet(pathname: string, token?: string): Promise<LatStats> {
  const doFetch = async () => {
    const t0 = performance.now();
    const res = await fetch(`${GW}${pathname}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    await res.arrayBuffer();
    const ms = performance.now() - t0;
    return { ms, ok: res.ok, status: res.status };
  };
  const warm = await doFetch(); // warm caches/planner; excluded from stats
  if (!warm.ok) console.warn(`  [warn] GET ${pathname} -> ${warm.status}`);
  const reps = warm.ms > 2000 ? 3 : warm.ms > 400 ? 8 : 20;
  const lat: number[] = [];
  let errors = 0;
  for (let i = 0; i < reps; i++) {
    const r = await doFetch();
    if (!r.ok) errors++;
    lat.push(r.ms);
  }
  lat.sort((a, b) => a - b);
  return {
    n: reps,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    min: lat[0]!,
    max: lat[lat.length - 1]!,
    mean: lat.reduce((a, b) => a + b, 0) / lat.length,
    errors,
  };
}

export interface ProxyStats extends LatStats {
  rps: number;
}

/** Timed parallel POSTs (real proxied chat completions through the gateway). */
export async function measureProxy(
  users: { gwKey: string }[],
  count: number,
  concurrency: number,
  stream: boolean,
): Promise<ProxyStats> {
  const lat: number[] = [];
  let errors = 0;
  let idx = 0;
  const started = performance.now();
  async function worker(w: number) {
    while (true) {
      const my = idx++;
      if (my >= count) return;
      const user = users[my % users.length]!;
      const m = MODELS[(my + w) % MODELS.length]!;
      const url =
        m.proto === "openai" ? `${GW}/v1/chat/completions` : `${GW}/v1/messages`;
      const t0 = performance.now();
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.gwKey}` },
          body: JSON.stringify({
            model: m.model,
            stream,
            messages: [{ role: "user", content: "perf probe — say hello" }],
          }),
        });
        await res.arrayBuffer();
        if (res.status >= 400) {
          errors++;
          if (errors <= 3) console.warn(`  [warn] proxy ${m.proto} -> ${res.status}`);
        }
      } catch {
        errors++;
      }
      lat.push(performance.now() - t0);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, (_, w) => worker(w)));
  const wallMs = performance.now() - started;
  lat.sort((a, b) => a - b);
  return {
    n: lat.length,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    min: lat[0]!,
    max: lat[lat.length - 1]!,
    mean: lat.reduce((a, b) => a + b, 0) / lat.length,
    errors,
    rps: (lat.length / wallMs) * 1000,
  };
}

/** Direct-to-upstream baseline (no gateway) for overhead computation. */
export async function measureDirect(count: number, concurrency: number): Promise<ProxyStats> {
  const lat: number[] = [];
  let errors = 0;
  let idx = 0;
  const started = performance.now();
  async function worker() {
    while (true) {
      const my = idx++;
      if (my >= count) return;
      const t0 = performance.now();
      try {
        const res = await fetch(`${UP}/openai/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${UPSTREAM_KEY}` },
          body: JSON.stringify({ model: "fake-llm-1", messages: [{ role: "user", content: "perf probe" }] }),
        });
        await res.arrayBuffer();
        if (res.status >= 400) errors++;
      } catch {
        errors++;
      }
      lat.push(performance.now() - t0);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const wallMs = performance.now() - started;
  lat.sort((a, b) => a - b);
  return {
    n: lat.length,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    min: lat[0]!,
    max: lat[lat.length - 1]!,
    mean: lat.reduce((a, b) => a + b, 0) / lat.length,
    errors,
    rps: (lat.length / wallMs) * 1000,
  };
}

// ===== failover probes =====
//
// The router+failover architecture adds candidate-chain walking on top of the
// old single-provider hot path. These probes measure each failover regime the
// gateway actually runs in, always restoring full health afterwards:
//
//   skipExhausted     primary key billing-exhausted → requests skip it
//                     (chain resolution cost with a dead key in the list)
//   activeFailover    primary key 500ing, state reset between requests →
//                     EVERY request pays attempt#1 + classification + retry
//   failoverBurst     primary key starts 500ing mid-flight → the first few
//                     requests pay the failover, then the key cools down
//   providerFallback  ALL provider-A keys exhausted → traffic rides the
//                     model_targets chain on provider B (model rewritten)

export interface FailoverProbes {
  skipExhausted: LatStats & { deadKeyHitsDuringMeasure: number };
  activeFailover: { n: number; mean: number; p50: number; p95: number };
  failoverBurst: LatStats;
  providerFallback: LatStats & { fallbackUpstreamHits: number };
}

export async function runFailoverProbes(
  users: { gwKey: string }[],
  adminToken: string,
  topo: RouterTopology,
): Promise<FailoverProbes> {
  const restoreAll = async () => {
    await setUpstreamFail(UP, UPSTREAM_KEY, null);
    await setUpstreamFail(UP, KEY_A2, null);
    await setUpstreamFail(UP, KEY_A3, null);
    await setUpstreamFail(UP2, UPSTREAM_KEY_B1, null);
    await setUpstreamFail(UP2, KEY_B2, null);
    for (const kid of [topo.keyA1, topo.keyA2, topo.keyA3]) {
      await resetKeyState(adminToken, topo.providerA, kid);
    }
    for (const kid of [topo.keyB1, topo.keyB2]) {
      await resetKeyState(adminToken, topo.providerB, kid);
    }
  };

  try {
    // ---- 1. dead primary key is skipped (steady state on key #2) ----
    await setUpstreamFail(UP, UPSTREAM_KEY, { status: 402, message: "insufficient_quota" });
    await measureProxy(users, 1, 1, false); // first request exhausts A1 (billing) and fails over
    const hitsBefore = await upstreamHits(UP);
    const skipExhaustedStats = await measureProxy(users, 30, 5, false);
    const hitsAfter = await upstreamHits(UP);
    const skipExhausted = {
      ...skipExhaustedStats,
      deadKeyHitsDuringMeasure:
        (hitsAfter[UPSTREAM_KEY] ?? 0) - (hitsBefore[UPSTREAM_KEY] ?? 0),
    };

    // ---- 2. every request pays a live failover (A1 500ing, state reset) ----
    await setUpstreamFail(UP, UPSTREAM_KEY, null);
    await setUpstreamFail(UP, UPSTREAM_KEY, { status: 500, message: "upstream exploded" });
    const singles: number[] = [];
    const ITER = 4; // below breakerFailThreshold (5); each success on A2 resets it anyway
    for (let i = 0; i < ITER; i++) {
      await resetKeyState(adminToken, topo.providerA, topo.keyA1);
      const one = await measureProxy(users, 1, 1, false);
      if (one.errors === 0) singles.push(one.p50);
    }
    singles.sort((a, b) => a - b);
    const activeFailover = {
      n: singles.length,
      mean: singles.reduce((a, b) => a + b, 0) / Math.max(1, singles.length),
      p50: singles.length ? pct(singles, 50) : NaN,
      p95: singles.length ? pct(singles, 95) : NaN,
    };

    // ---- 3. burst: primary starts failing mid-traffic ----
    await resetKeyState(adminToken, topo.providerA, topo.keyA1);
    const failoverBurst = await measureProxy(users, 30, 5, false);

    // ---- 4. whole provider dead → model_targets chain on provider B ----
    await setUpstreamFail(UP, UPSTREAM_KEY, { status: 402, message: "insufficient_quota" });
    await setUpstreamFail(UP, KEY_A2, { status: 402, message: "insufficient_quota" });
    await setUpstreamFail(UP, KEY_A3, { status: 402, message: "insufficient_quota" });
    await measureProxy(users, 1, 1, false); // cascade-exhausts all A keys, lands on B1
    const bHitsBefore = await upstreamHits(UP2);
    const providerFallbackStats = await measureProxy(users, 30, 5, false);
    const bHitsAfter = await upstreamHits(UP2);
    const providerFallback = {
      ...providerFallbackStats,
      fallbackUpstreamHits:
        Object.values(bHitsAfter).reduce((a, b) => a + b, 0) -
        Object.values(bHitsBefore).reduce((a, b) => a + b, 0),
    };

    await restoreAll();
    return { skipExhausted, activeFailover, failoverBurst, providerFallback };
  } catch (e) {
    await restoreAll();
    throw e;
  }
}

/** Standard dashboard/static endpoint set measured at every checkpoint. */
export interface EndpointSample {
  name: string;
  url: string;
  /** "gw" = authenticated with a gateway API key (gw_…) instead of a JWT. */
  who: "user" | "admin" | "anon" | "gw";
}

export function endpointSet(
  eventsDeepOffset: number,
  auditDeepOffset: number,
  opts?: { router?: boolean },
): EndpointSample[] {
  const base: EndpointSample[] = [
    // control: near-zero DB work, should stay flat
    { name: "me", url: "/api/me", who: "user" },
    // user dashboard
    { name: "keys.list", url: "/api/keys", who: "user" },
    { name: "usage.summary", url: "/api/usage/summary", who: "user" },
    { name: "usage.daily.14d", url: "/api/usage/daily?days=14", who: "user" },
    { name: "usage.daily.all", url: "/api/usage/daily?days=all", who: "user" },
    { name: "usage.hourly.24h", url: "/api/usage/daily?hours=24", who: "user" },
    { name: "usage.events.p1", url: "/api/usage/events?limit=25&offset=0", who: "user" },
    { name: "usage.events.deep", url: `/api/usage/events?limit=100&offset=${eventsDeepOffset}`, who: "user" },
    { name: "usage.bymodel.14d", url: "/api/usage/by-model?days=14", who: "user" },
    { name: "usage.bymodel.all", url: "/api/usage/by-model?days=all", who: "user" },
    // admin dashboard
    { name: "admin.stats.24h", url: "/api/admin/stats?hours=24", who: "admin" },
    { name: "admin.stats.14d", url: "/api/admin/stats?days=14", who: "admin" },
    { name: "admin.stats.all", url: "/api/admin/stats?days=all", who: "admin" },
    { name: "admin.audit.p1", url: "/api/admin/audit?limit=50&offset=0", who: "admin" },
    { name: "admin.audit.deep", url: `/api/admin/audit?limit=50&offset=${auditDeepOffset}`, who: "admin" },
    { name: "admin.users", url: "/api/admin/users", who: "admin" },
    { name: "admin.keys", url: "/api/admin/keys", who: "admin" },
    // SPA / frontend delivery
    { name: "static.index", url: "/", who: "anon" },
  ];
  if (opts?.router) {
    base.push(
      // router-mode surfaces: model registry + providers listing
      { name: "admin.models", url: "/api/admin/models", who: "admin" },
      { name: "admin.providers", url: "/api/admin/providers", who: "admin" },
      // /v1/models is GENERATED from the registry in router mode
      { name: "v1.models", url: "/v1/models", who: "gw" },
    );
  }
  return base;
}
