import { describe, expect, test } from "bun:test";

import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  hashPassword,
  jwtSign,
  jwtVerify,
  newTotpSecret,
  randomBytes,
  timingSafeEq,
  totpAt,
  totpVerify,
  verifyPassword,
} from "../server/crypto";
import { checkKeyAvailability } from "../server/keys";
import {
  listableModels,
  parseUpstreamModels,
  passthroughCandidates,
  publicModelEntry,
  resolveModelRoute,
  type RoutedKey,
  type RoutedProvider,
  type RouterSnapshot,
} from "../server/models";
import {
  classifyHttpError,
  keyUsable,
  stickyClear,
  stickyClearAll,
  stickyGet,
  stickySet,
} from "../server/failover";
import { estimateBodyTokens } from "../server/proxy/index";
import { IRStreamTranslator } from "../server/proxy/gateway-ir";
import { countTextTokens, kvClear, kvSnapshotCached, splitKvInput } from "../server/tokens";
import type { ModelRow, ModelTargetRow, ProviderRow } from "../server/db";
import { buildGridWhere } from "../server/gridql";
import { normalizePricing, normalizePricingValue, pricingColumns } from "../server/pricing";

const SECRET = "test-secret-that-is-long-enough-32+";

describe("AG Grid server-side filter translation", () => {
  test("translates native date filter models into UTC day ranges", () => {
    const result = buildGridWhere(
      {
        ts: {
          filterType: "date",
          type: "inRange",
          dateFrom: "2026-08-18 00:00:00",
          dateTo: "2026-08-19 00:00:00",
        },
      },
      { ts: { col: "e.ts", kind: "date" } },
    );
    expect(result.clauses).toEqual(["e.ts >= ? AND e.ts < ?"]);
    expect(result.params).toEqual([
      Date.UTC(2026, 7, 18),
      Date.UTC(2026, 7, 20),
    ]);
  });

  test("supports multiple native conditions with their operator", () => {
    const result = buildGridWhere(
      {
        requests: {
          filterType: "number",
          operator: "OR",
          conditions: [
            { filterType: "number", type: "greaterThan", filter: 100 },
            { filterType: "number", type: "equals", filter: 0 },
          ],
        },
      },
      { requests: { col: "reqs", kind: "number" } },
    );
    expect(result.clauses).toEqual(["(reqs > ? OR reqs = ?)"]);
    expect(result.params).toEqual([100, 0]);
  });

  test("datetime filter: epoch-ms bounds map to inclusive range predicates", () => {
    const cols = { ts: { col: "e.ts", kind: "date" as const } };
    const both = buildGridWhere({ ts: { filterType: "datetime", from: 1000, to: 2000 } }, cols);
    expect(both.clauses).toEqual(["e.ts >= ? AND e.ts <= ?"]);
    expect(both.params).toEqual([1000, 2000]);
    expect(buildGridWhere({ ts: { filterType: "datetime", from: 1000, to: null } }, cols).clauses).toEqual(["e.ts >= ?"]);
    expect(buildGridWhere({ ts: { filterType: "datetime", from: null, to: 2000 } }, cols).clauses).toEqual(["e.ts <= ?"]);
    // Number(null) === 0 trap: null bounds must NOT become 0
    expect(buildGridWhere({ ts: { filterType: "datetime", from: null, to: null } }, cols).clauses).toEqual([]);
    expect(buildGridWhere({ ts: { filterType: "datetime", from: "abc", to: "2026-08-19" } }, cols).clauses).toEqual([]);
  });
});

describe("model pricing normalization", () => {
  test("cleans provider labels and derives the real pricing columns", () => {
    const pricing = normalizePricing({
      prompt: "$0.000001 per token",
      input_cache_reads: "USD 0.0000001",
      input_cache_writes: 2e-7,
      completion: "0.000002",
    });
    expect(pricing).toEqual({
      prompt: 0.000001,
      input_cache_reads: 0.0000001,
      input_cache_writes: 0.0000002,
      completion: 0.000002,
    });
    expect(pricingColumns(pricing)).toEqual({
      input: 0.000001,
      inputCache: 0.0000001,
      inputCacheWrite: 0.0000002,
      output: 0.000002,
    });
  });

  test("scientific notation survives instead of collapsing into wrong digits", () => {
    expect(normalizePricingValue("4.5e-7")).toBe(4.5e-7);
    expect(normalizePricingValue("1E-8")).toBe(1e-8);
    expect(normalizePricingValue("$4.5e-7")).toBe(4.5e-7);
    expect(normalizePricing({ prompt: "4.5e-7", completion: "$0.000003" })).toEqual({
      prompt: 4.5e-7,
      completion: 0.000003,
    });
    expect(normalizePricingValue("USD 0.000002")).toBe(0.000002);
    expect(normalizePricingValue("junk")).toBeNull();
  });
});

describe("TOTP (RFC 6238 vectors, SHA-1, 6-digit truncation)", () => {
  // RFC 6238 Appendix B: ASCII secret "12345678901234567890" -> base32
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const vectors: Array<[number, string]> = [
    [59_000, "287082"],       // 94287082 mod 1e6
    [1111111109_000, "081804"],
    [1111111111_000, "050471"],
    [1234567890_000, "005924"],
    [2000000000_000, "279037"],
  ];

  for (const [ts, expected] of vectors) {
    test(`T=${ts}`, async () => {
      expect(await totpAt(secret, ts)).toBe(expected);
    });
  }

  test("accepts current code, rejects garbage", async () => {
    const s = newTotpSecret();
    const now = Date.now();
    const code = await totpAt(s, now);
    expect(await totpVerify(s, code, now)).toBe(true);
    expect(await totpVerify(s, "000000", now)).toBe(false);
  });
});

describe("base32", () => {
  test("roundtrip", () => {
    const raw = randomBytes(20);
    expect(base32Encode(base32Decode(base32Encode(raw)))).toBe(base32Encode(raw));
  });
});

describe("passwords (PBKDF2)", () => {
  test("roundtrip", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("pbkdf2:100000:")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPassword("wrong password!!", hash)).toBe(false);
  });

  test("rejects malformed stored hash", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
  });
});

describe("JWT HS256", () => {
  test("sign + verify roundtrip", async () => {
    const token = await jwtSign({ sub: "u1", jti: "j1", type: "access", role: "user" }, SECRET, 60);
    const res = await jwtVerify(token, SECRET);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payload.sub).toBe("u1");
      expect(res.payload.type).toBe("access");
    }
  });

  test("expired token rejected", async () => {
    const token = await jwtSign({ sub: "u1", jti: "j1", type: "access" }, SECRET, -10);
    const res = await jwtVerify(token, SECRET);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("expired");
  });

  test("tampered signature rejected", async () => {
    const token = await jwtSign({ sub: "u1", jti: "j1", type: "access" }, SECRET, 60);
    const [h, b] = token.split(".");
    const res = await jwtVerify(`${h}.${b}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, SECRET);
    expect(res.ok).toBe(false);
  });

  test("wrong key rejected", async () => {
    const token = await jwtSign({ sub: "u1", jti: "j1", type: "access" }, SECRET, 60);
    const res = await jwtVerify(token, "different-secret-32-bytes-long-enough!!");
    expect(res.ok).toBe(false);
  });

  test("malformed rejected", async () => {
    expect((await jwtVerify("garbage", SECRET)).ok).toBe(false);
    expect((await jwtVerify("a.b.c", SECRET)).ok).toBe(false);
  });
});

describe("AES-256-GCM", () => {
  test("roundtrip", async () => {
    const blob = await encryptSecret("sk-super-secret-upstream-key", SECRET);
    expect(blob).not.toContain("sk-super-secret-upstream-key");
    expect(await decryptSecret(blob, SECRET)).toBe("sk-super-secret-upstream-key");
  });

  test("tamper detected", async () => {
    const blob = await encryptSecret("hello", SECRET);
    const parts = blob.split(".");
    const ct = Buffer.from(parts[2]!, "base64url");
    ct[0] = ct[0]! ^ 1;
    parts[2] = ct.toString("base64url");
    await expect(decryptSecret(parts.join("."), SECRET)).rejects.toThrow();
  });
});

describe("timingSafeEq", () => {
  test("equal + different", () => {
    expect(timingSafeEq("abc", "abc")).toBe(true);
    expect(timingSafeEq("abc", "abd")).toBe(false);
    expect(timingSafeEq("abc", "abcd")).toBe(false);
  });
});

describe("key availability logic", () => {
  const base = {
    id: "k1", user_id: "u1", name: "t", prefix: "gw_", hash: "x",
    created_at: Date.now(), expires_at: null, daily_limit: null,
    total_limit: null, rpm: null, status: "active" as const,
    last_used_at: null, last_used_ip: null, token_enc: null,
  };

  test("active key passes", () => {
    expect(checkKeyAvailability(base).ok).toBe(true);
  });
  test("revoked fails", () => {
    const r = checkKeyAvailability({ ...base, status: "revoked" });
    expect(r).toEqual({ ok: false, reason: "revoked" });
  });
  test("expired fails", () => {
    const r = checkKeyAvailability({ ...base, expires_at: Date.now() - 1000 });
    expect(r).toEqual({ ok: false, reason: "expired" });
  });
});

describe("model sync payload parsing", () => {
  test("plain OpenAI shape", () => {
    const out = parseUpstreamModels({
      object: "list",
      data: [
        { id: "gpt-4o", object: "model", created: 1715367049, owned_by: "openai" },
        { id: "gpt-4o-mini", object: "model", created: 1721172741, owned_by: "openai" },
      ],
    });
    expect(out.map((m) => m.id)).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(out[0]!.input_modalities).toEqual(["text"]);
    expect(out[0]!.pricing).toBeNull();
  });

  test("Anthropic shape (display_name + ISO created_at)", () => {
    const out = parseUpstreamModels({
      data: [
        { type: "model", id: "claude-opus-4-5", display_name: "Claude Opus 4.5", created_at: "2025-11-24T00:00:00Z" },
      ],
      has_more: false,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("claude-opus-4-5");
    expect(out[0]!.name).toBe("Claude Opus 4.5");
  });

  test("rich OpenRouter-style shape", () => {
    const out = parseUpstreamModels({
      data: [
        {
          id: "hf:zai-org/GLM-5.2",
          name: "GLM-5.2",
          description: "A model",
          context_length: 202752,
          max_completion_tokens: 131072,
          supported_parameters: ["max_tokens", "temperature"],
          supported_features: ["tools"],
          reasoning_parameters: { efforts: ["low", "high"] },
          pricing: { prompt: "$0.0000004 per token", completion: "USD 0.000002", junk: { nested: true } },
          architecture: { modality: "text+image->text" },
        },
      ],
    });
    expect(out).toHaveLength(1);
    const m = out[0]!;
    expect(m.context_length).toBe(202752);
    expect(m.max_output_length).toBe(131072);
    expect(m.sampling_params).toEqual(["max_tokens", "temperature"]);
    expect(m.features).toEqual(["tools"]);
    expect(m.reasoning_efforts).toEqual(["low", "high"]);
    expect(m.pricing).toEqual({ prompt: 0.0000004, completion: 0.000002 });
    expect(m.input_modalities).toEqual(["text", "image"]);
    expect(m.output_modalities).toEqual(["text"]);
  });

  test("skips junk and caps garbage", () => {
    const out = parseUpstreamModels({
      data: [{ id: "" }, { id: "has space" }, { no_id: true }, null, { id: "ok" }],
    });
    expect(out.map((m) => m.id)).toEqual(["ok"]);
    expect(parseUpstreamModels({ data: "nope" })).toEqual([]);
    expect(parseUpstreamModels(null)).toEqual([]);
  });
});

describe("public /v1/models registry entry", () => {
  const row: ModelRow = {
    id: "alias-fast",
    provider_id: "p1",
    upstream_model: "real-id",
    name: "Alias Fast",
    description: "d",
    enabled: 1,
    context_length: 100_000,
    max_output_length: 4096,
    input_modalities: '["text","image"]',
    output_modalities: '["text"]',
    sampling_params: '["temperature"]',
    features: '["tools"]',
    reasoning_efforts: '["low","high"]',
    tool_call_mode: "native",
    pricing: '{"prompt":"0.1","completion":"0.2"}',
    pricing_input: 0.1,
    pricing_input_cache: null,
    pricing_input_cache_write: null,
    pricing_output: 0.2,
    source: "manual",
    created_at: 1,
    updated_at: 1,
  };

  test("renders the rich format", () => {
    const e = publicModelEntry(row, "my-provider") as any;
    expect(e.provider).toBe("my-provider");
    expect(e.id).toBe("alias-fast");
    expect(e.name).toBe("Alias Fast");
    expect(e.reasoning_parameters).toEqual({ efforts: ["low", "high"] });
    expect(e.input_modalities).toEqual(["text", "image"]);
    expect(e.context_length).toBe(100_000);
    expect(e.max_output_length).toBe(4096);
    expect(e.pricing).toEqual({ prompt: 0.1, completion: 0.2 });
    // Reasoning models never advertise temperature (reasoning-only
    // upstreams like gpt-5.6-luna reject the param outright).
    expect(e.supported_sampling_parameters).toEqual([]);
    expect(e.supported_features).toEqual(["tools"]);
    expect(e.limit).toEqual({ context: 100_000, output: 4096 });
  });

  test("omits unknown optional fields, defaults context to 256k", () => {
    const sparse: ModelRow = {
      ...row,
      name: "",
      reasoning_efforts: null,
      pricing: null,
      context_length: null,
      max_output_length: null,
      pricing_input: null,
      pricing_input_cache: null,
      pricing_input_cache_write: null,
      pricing_output: null,
    };
    const e = publicModelEntry(sparse, "p") as any;
    expect(e.name).toBe("alias-fast"); // falls back to id
    expect("reasoning_parameters" in e).toBe(false);
    expect("pricing" in e).toBe(false);
    expect("context_length" in e).toBe(false);
    expect(e.limit).toEqual({ context: 262_144, output: 65_536 });
  });
});

describe("model routing without registry protos", () => {
  const provider = {
    id: "p1",
    name: "dual",
    openai_base_url: "http://x/openai/v1",
    anthropic_base_url: "http://x/anthropic/v1",
    api_key_enc: "enc",
    enabled: 1,
    priority: 100,
    created_at: 1,
    openai_auth_style: "bearer",
    anthropic_auth_style: "x-api-key",
  } as ProviderRow;
  const mk = (id: string): ModelRow => ({
    id,
    provider_id: "p1",
    upstream_model: id,
    name: "",
    description: "",
    enabled: 1,
    context_length: null,
    max_output_length: null,
    input_modalities: '["text"]',
    output_modalities: '["text"]',
    sampling_params: "[]",
    features: "[]",
    reasoning_efforts: null,
    tool_call_mode: "native",
    pricing: null,
    pricing_input: null,
    pricing_input_cache: null,
    pricing_input_cache_write: null,
    pricing_output: null,
    source: "auto",
    created_at: 1,
    updated_at: 1,
  });
  const target = (modelId: string, providerId = "p1"): ModelTargetRow => ({
    model_id: modelId,
    provider_id: providerId,
    upstream_model: modelId,
    priority: 0,
    enabled: 1,
    created_at: 1,
  });
  const routedProvider: RoutedProvider = {
    row: provider,
    keys: [
      { id: "k1", key: "secret", label: "primary", priority: 0, status: "active", cooldownUntil: null, exhaustedReason: null },
    ],
  };
  const snap: RouterSnapshot = {
    mode: "router",
    models: new Map([
      ["m-a", mk("m-a")],
      ["m-b", mk("m-b")],
    ]),
    targets: new Map([
      ["m-a", [target("m-a")]],
      ["m-b", [target("m-b")]],
    ]),
    providers: new Map([["p1", routedProvider]]),
  };

  test("every registered model resolves on both surfaces", () => {
    expect(resolveModelRoute(snap, "openai", "m-a")).toMatchObject({ ok: true });
    expect(resolveModelRoute(snap, "anthropic", "m-a")).toMatchObject({ ok: true });
    expect(resolveModelRoute(snap, "openai", "missing")).toMatchObject({ ok: false, status: 404 });
    expect(resolveModelRoute(snap, "anthropic", "missing")).toMatchObject({ ok: false, status: 404 });
  });

  test("listings cover every enabled model on both surfaces", () => {
    expect(listableModels(snap, "openai").map((m) => m.id)).toEqual(["m-a", "m-b"]);
    expect(listableModels(snap, "anthropic").map((m) => m.id)).toEqual(["m-a", "m-b"]);
  });
});

describe("failover: upstream error classification", () => {
  const quota429 = JSON.stringify({ error: { message: "You exceeded your current quota, please check your plan and billing details", type: "insufficient_quota", code: "insufficient_quota" } });
  const rate429 = JSON.stringify({ error: { message: "Rate limit reached for requests", type: "tokens" } });
  const credit402 = JSON.stringify({ error: { message: "Insufficient credits. Add more at https://openrouter.ai/credits", code: 402 } });

  test("billing detection (402 or quota hints in any 4xx)", () => {
    expect(classifyHttpError(402, credit402)).toBe("billing");
    expect(classifyHttpError(402, "")).toBe("billing"); // status alone suffices
    expect(classifyHttpError(429, quota429)).toBe("billing");
    expect(classifyHttpError(400, JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API" } }))).toBe("billing");
    expect(classifyHttpError(403, JSON.stringify({ error: { message: "account is not active, insufficient credits" } }))).toBe("billing");
  });

  test("auth rejection (401/403 without billing hints)", () => {
    expect(classifyHttpError(401, JSON.stringify({ error: { message: "Incorrect API key provided" } }))).toBe("auth");
    expect(classifyHttpError(403, JSON.stringify({ error: { message: "Forbidden" } }))).toBe("auth");
  });

  test("transients: plain 429, 5xx, 408, upstream 404 'model not found'", () => {
    expect(classifyHttpError(429, rate429)).toBe("rate_limit");
    expect(classifyHttpError(500, "internal error")).toBe("transient");
    expect(classifyHttpError(502, "bad gateway")).toBe("transient");
    expect(classifyHttpError(408, "")).toBe("transient");
    expect(classifyHttpError(404, JSON.stringify({ error: { message: "The model `gpt-x` does not exist" } }))).toBe("model_not_found");
  });

  test("client errors are NOT fail-able", () => {
    expect(classifyHttpError(400, JSON.stringify({ error: { message: "messages: field required" } }))).toBeNull();
    expect(classifyHttpError(404, "not found")).toBeNull();
    expect(classifyHttpError(413, "too large")).toBeNull();
    expect(classifyHttpError(422, "{}")).toBeNull();
    expect(classifyHttpError(301, "")).toBeNull();
  });
});

describe("failover: no-skip policy and sticky winner", () => {
  test("nothing is auto-skipped: only an explicit disabled key is unusable", () => {
    expect(keyUsable({ status: "active" })).toBe(true);
    expect(keyUsable({ status: "exhausted" })).toBe(true);
    // Legacy rows can still carry these columns — they no longer gate.
    expect(keyUsable({ status: "active", cooldown_until: Date.now() + 10_000, exhausted_reason: null })).toBe(true);
    expect(
      keyUsable({ status: "exhausted", cooldown_until: Date.now() + 10_000, exhausted_reason: "billing" }),
    ).toBe(true);
    expect(keyUsable({ status: "disabled" })).toBe(false);
  });

  test("sticky winner: set/get TTL, overwrite, targeted + global clear", () => {
    const lane = `test-lane-${Math.random()}`;
    expect(stickyGet(lane)).toBeNull();
    const w = { providerId: "p", keyId: "k", upstreamModel: "m", via: "openai" };
    stickySet(lane, w);
    expect(stickyGet(lane)).toEqual(w);
    // Sliding TTL: a second success refreshes the same winner.
    stickySet(lane, { ...w, keyId: "k2" });
    expect(stickyGet(lane)?.keyId).toBe("k2");
    stickyClear(lane);
    expect(stickyGet(lane)).toBeNull();
    // Expired entries read as missing.
    stickySet(lane, w, Date.now() - 11 * 60_000);
    expect(stickyGet(lane)).toBeNull();
    // Global clear (admin mutations) drops every lane.
    stickySet(lane, w);
    stickySet(`${lane}-2`, w);
    stickyClearAll();
    expect(stickyGet(lane)).toBeNull();
    expect(stickyGet(`${lane}-2`)).toBeNull();
  });
});

describe("failover: candidate chains", () => {
  const provider = {
    id: "p1", name: "p1",
    openai_base_url: "http://x/openai/v1", anthropic_base_url: null,
    api_key_enc: "enc", enabled: 1, priority: 100, created_at: 1,
    openai_auth_style: "bearer", anthropic_auth_style: "x-api-key",
  } as ProviderRow;
  const key = (id: string, priority: number, over: Partial<RoutedKey> = {}): RoutedKey => ({
    id, key: `secret-${id}`, label: id, priority, status: "active", cooldownUntil: null, exhaustedReason: null, ...over,
  });
  const model = (id: string): ModelRow => ({
    id, provider_id: "p1", upstream_model: id,
    name: "", description: "",
    enabled: 1, context_length: null, max_output_length: null,
    input_modalities: '["text"]', output_modalities: '["text"]', sampling_params: "[]",
    features: "[]", reasoning_efforts: null, tool_call_mode: "native", pricing: null,
    pricing_input: null, pricing_input_cache: null, pricing_input_cache_write: null, pricing_output: null,
    source: "manual", created_at: 1, updated_at: 1,
  });
  const target = (modelId: string, providerId: string, upstream: string, priority: number, enabled = 1): ModelTargetRow =>
    ({ model_id: modelId, provider_id: providerId, upstream_model: upstream, priority, enabled, created_at: 1 });

  test("resolveModelRoute flattens targets × usable keys in priority order", () => {
    const p2 = { ...provider, id: "p2", name: "p2" } as ProviderRow;
    const snap: RouterSnapshot = {
      mode: "router",
      models: new Map([["m", model("m")]]),
      targets: new Map([
        ["m", [target("m", "p1", "m-on-p1", 0), target("m", "p2", "m-on-p2", 10)]],
      ]),
      providers: new Map([
        ["p1", { row: provider, keys: [key("k1", 0), key("k2", 10)] }],
        ["p2", { row: p2, keys: [key("k3", 0)] }],
      ]),
    };
    const r = resolveModelRoute(snap, "openai", "m");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates.map((c) => c.key.id)).toEqual(["k1", "k2", "k3"]);
    expect(r.candidates[2]!.upstreamModel).toBe("m-on-p2");
  });

  test("disabled keys are skipped; legacy exhausted/cooldown rows are still tried; empty chain → 503", () => {
    const snap: RouterSnapshot = {
      mode: "router",
      models: new Map([["m", model("m")]]),
      targets: new Map([["m", [target("m", "p1", "m", 0)]]]),
      providers: new Map([
        ["p1", { row: provider, keys: [key("k1", 0, { status: "disabled" }), key("k2", 10)] }],
      ]),
    };
    const onlyK2 = resolveModelRoute(snap, "openai", "m");
    expect(onlyK2.ok).toBe(true);
    if (onlyK2.ok) expect(onlyK2.candidates.map((c) => c.key.id)).toEqual(["k2"]);

    // legacy exhausted/cooldown columns no longer gate: the key is tried
    const snap2: RouterSnapshot = {
      ...snap,
      providers: new Map([
        ["p1", { row: provider, keys: [key("k1", 0, { status: "exhausted", exhaustedReason: "billing", cooldownUntil: Date.now() + 60_000 })] }],
      ]),
    };
    const r = resolveModelRoute(snap2, "openai", "m");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.candidates.map((c) => c.key.id)).toEqual(["k1"]);
  });

  test("passthroughCandidates walks providers by priority, skipping disabled keys", () => {
    const p2 = { ...provider, id: "p2", name: "p2", priority: 200 } as ProviderRow;
    const snap: RouterSnapshot = {
      mode: "passthrough",
      models: new Map(),
      targets: new Map(),
      providers: new Map([
        ["p1", { row: provider, keys: [key("k1", 0, { status: "disabled" }), key("k2", 10)] }],
        ["p2", { row: p2, keys: [key("k3", 0)] }],
      ]),
    };
    expect(passthroughCandidates(snap, "openai").map((c) => c.key.id)).toEqual(["k2", "k3"]);
    // anthropic capability missing on both → served translated via the bridge
    const tr = passthroughCandidates(snap, "anthropic");
    expect(tr.map((c) => c.key.id)).toEqual(["k2", "k3"]);
    expect(tr.every((c) => c.translated)).toBe(true);
  });

  test("anthropic request on an OpenAI-only provider resolves as translated", () => {
    const snap: RouterSnapshot = {
      mode: "router",
      models: new Map([["m", model("m")]]),
      targets: new Map([["m", [target("m", "p1", "m", 0)]]]),
      providers: new Map([["p1", { row: provider, keys: [key("k1", 0)] }]]),
    };
    // no registry gate: the model resolves on both surfaces
    const r = resolveModelRoute(snap, "anthropic", "m");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.candidates.map((c) => c.key.id)).toEqual(["k1"]);
      expect(r.candidates[0]!.translated).toBe(true);
    }
    // openai surface on the same provider stays direct
    const r2 = resolveModelRoute(snap, "openai", "m");
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.candidates[0]!.translated).toBe(false);
  });

  test("listableModels shows every enabled model on both surfaces", () => {
    const snap: RouterSnapshot = {
      mode: "router",
      models: new Map([
        ["m-a", model("m-a")],
        ["m-b", model("m-b")],
      ]),
      targets: new Map([
        ["m-a", [target("m-a", "p1", "m-a", 0)]],
        ["m-b", [target("m-b", "p1", "m-b", 0)]],
      ]),
      providers: new Map([["p1", { row: provider, keys: [key("k1", 0)] }]]),
    };
    // provider is OpenAI-only: everything is servable translated on anthropic
    expect(listableModels(snap, "anthropic").map((m) => m.id)).toEqual(["m-a", "m-b"]);
    expect(listableModels(snap, "openai").map((m) => m.id)).toEqual(["m-a", "m-b"]);
  });
});


describe("IRStreamTranslator fallback (upstream never reports usage)", () => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const collect = (t: InstanceType<typeof IRStreamTranslator>, lines: string[]): string => {
    let out = "";
    for (const line of lines) for (const p of t.feed(enc.encode(line))) out += dec.decode(p);
    for (const p of t.flush()) out += dec.decode(p);
    return out;
  };

  test("openai stream: btdby4 estimate of the output text — not the digit count", () => {
    const t = new IRStreamTranslator("openai", "openai", "m1");
    // 20 chunks x 100 chars of content, no usage chunk anywhere.
    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`data: {"model":"m1","choices":[{"delta":{"content":"${"y".repeat(100)}"}}]}\n\n`);
    }
    const out = collect(t, lines);
    expect(out).toContain("y".repeat(10));
    const r = t.result();
    expect(r.estimated).toBe(true);
    expect(r.inTok).toBe(0); // input estimate happens at the call site
    // Whole text (2000 chars) fits the estimation sample, so the translator
    // must land exactly on btdby4's count.
    expect(r.outTok).toBe(countTextTokens("y".repeat(2000)));
    expect(r.outTok).toBeGreaterThan(100); // a real order of magnitude
  });

  test("anthropic stream: text_delta is btdby4-estimated when usage events are missing", () => {
    const t = new IRStreamTranslator("anthropic", "anthropic", "m");
    const out = collect(t, [
      `event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"${"z".repeat(400)}"}}\n\n`,
    ]);
    expect(out).toContain("z".repeat(10));
    const r = t.result();
    expect(r.estimated).toBe(true);
    expect(r.outTok).toBe(countTextTokens("z".repeat(400)));
    expect(r.outTok).toBeGreaterThan(10);
  });

  test("long streams: the capped sample extrapolates to the full length", () => {
    const t = new IRStreamTranslator("openai", "openai", "m1");
    // 8000 chars of English prose — well beyond the 2048-char sample cap.
    let stream = "";
    while (stream.length < 8000) stream += "The quick brown fox jumps over the lazy dog. ";
    stream = stream.slice(0, 8000);
    const lines = [];
    for (const chunk of stream.match(/.{1,100}/g)!) {
      lines.push(`data: {"model":"m1","choices":[{"delta":{"content":${JSON.stringify(chunk)}}}]}\n\n`);
    }
    collect(t, lines);
    const r = t.result();
    expect(r.estimated).toBe(true);
    // The per-char ratio of the first sample extrapolates to (at least) the
    // same order as counting the whole text.
    const full = countTextTokens(stream);
    expect(r.outTok).toBeGreaterThanOrEqual(Math.floor(full * 0.9));
    expect(r.outTok).toBeLessThanOrEqual(Math.ceil(full * 1.1));
  });

  test("real usage events still win over the estimate", () => {
    const t = new IRStreamTranslator("openai", "openai", "m1");
    collect(t, [
      `data: {"model":"m1","choices":[{"delta":{"content":"${"y".repeat(100)}"}}]}\n\n`,
      `data: {"usage":{"prompt_tokens":7,"completion_tokens":42}}\n\n`,
    ]);
    const r = t.result();
    expect(r.estimated).toBe(false);
    expect(r.outTok).toBe(42);
    expect(r.inTok).toBe(7);
  });
});

describe("estimateBodyTokens (estimated input from the request body)", () => {
  test("runs the per-protocol btdby4 counter over the wire shape (framing included)", () => {
    const body = { model: "llm-1", messages: [{ role: "user", content: "a".repeat(400) }] };
    // btdby4 counts the real wire shape (role tags, framing) — ~62 for this
    // body — not just the raw string values.
    expect(estimateBodyTokens(body, "openai")).toBeGreaterThan(50);
    expect(estimateBodyTokens(body, "openai")).toBeLessThan(120);
  });

  test("never returns zero for a non-empty body", () => {
    expect(estimateBodyTokens({ model: "x" })).toBeGreaterThanOrEqual(1);
  });
});

describe("btdby4 KV cache (egress-side prefix simulation)", () => {
  const chatBody = (messages: unknown[]) => JSON.stringify({ model: "m", messages });
  const msg = (text: string) => [{ role: "user", content: text }];

  test("first turn is all fresh, extended prefix hits cache, new prompt misses", () => {
    kvClear("kv-unit-a");
    const t1 = `zero-usage probe base ${"a".repeat(600)}`;
    const t2 = `${t1} tail ${"b".repeat(60)}`;
    // Extended as a second block: common prefix ~= whole first turn.
    const s1 = splitKvInput(chatBody(msg(t1)), "openai", "kv-unit-a");
    expect(s1.cacheTok).toBe(0);
    expect(s1.inTok).toBe(s1.total);
    const s2 = splitKvInput(chatBody([msg(t1)[0], { role: "user", content: `tail ${"b".repeat(60)}` }]), "openai", "kv-unit-a");
    expect(s2.cacheTok).toBeGreaterThan(0);
    expect(s2.inTok).toBeLessThan(s1.inTok); // only the tail is fresh
    expect(s2.inTok + s2.cacheTok).toBe(s2.total);
    // Brand-new prompt: no cache.
    const s3 = splitKvInput(chatBody(msg("totally different prompt here")), "openai", "kv-unit-a");
    expect(s3.cacheTok).toBe(0);
    expect(t2.length).toBeGreaterThan(t1.length);
  });

  test("cache is isolated per namespace (key/model/lane)", () => {
    kvClear("kv-unit-b1");
    kvClear("kv-unit-b2");
    const body = chatBody(msg("same body everywhere"));
    const first = splitKvInput(body, "openai", "kv-unit-b1");
    expect(first.cacheTok).toBe(0);
    // Same body, different namespace: separate run, no cache.
    const other = splitKvInput(body, "openai", "kv-unit-b2");
    expect(other.cacheTok).toBe(0);
    // Same namespace: cache hit.
    const same = splitKvInput(body, "openai", "kv-unit-b1");
    expect(same.cacheTok).toBe(same.total);
    expect(same.inTok).toBe(0);
  });

  test("per-protocol isolation is built into the provider", () => {
    kvClear("kv-unit-c");
    const body = chatBody(msg("same body everywhere"));
    splitKvInput(body, "openai", "kv-unit-c");
    // Same namespace, other protocol: separate run, no cache.
    const other = splitKvInput(body, "anthropic", "kv-unit-c");
    expect(other.cacheTok).toBe(0);
  });

  test("wasm failure falls back to the body total (never a zero lie)", () => {
    // Unparseable JSON: the TotalQuick counters throw inside the wasm,
    // so splitKvInput degrades to countRequestJson's 1-token floor.
    const s = splitKvInput("{{{not json", "openai", "kv-unit-d");
    expect(s).toEqual({ inTok: 1, cacheTok: 0, total: 1, hit: false });
  });

  test("snapshot memoizes kvStats for 60s (dashboard chip cache)", () => {
    kvClear("kv-unit-snap");
    splitKvInput(chatBody(msg("snapshot probe")), "openai", "kv-unit-snap");
    const a = kvSnapshotCached();
    expect(a.max_bytes).toBeGreaterThan(0);
    expect(a.ttl_seconds).toBe(600);
    expect(a.captured_at).toBeGreaterThan(0);
    expect(a.stale).toBe(false);
    // Second read within the window reuses the memoized object.
    const b = kvSnapshotCached();
    expect(b.captured_at).toBe(a.captured_at);
    expect(b.bytes).toBe(a.bytes);
  });

});
