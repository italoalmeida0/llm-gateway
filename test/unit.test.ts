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
  billingCooldownUntil,
  classifyHttpError,
  keyBlockedNow,
  keyUsable,
  liveKeyBlock,
  liveKeyClear,
  nextCooldown,
} from "../server/failover";
import { StreamMeter, estimateBodyTokens } from "../server/proxy/index";
import { estimateTokenCount } from "tokenx";
import type { ModelRow, ModelTargetRow, ProviderRow } from "../server/db";

const SECRET = "test-secret-that-is-long-enough-32+";

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
    expect(out[0]!.created).toBe(1715367049);
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
    expect(out[0]!.created).toBe(Math.floor(Date.parse("2025-11-24T00:00:00Z") / 1000));
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
          hugging_face_id: "zai-org/GLM-5.2",
          supported_parameters: ["max_tokens", "temperature"],
          supported_features: ["tools"],
          reasoning_parameters: { efforts: ["low", "high"] },
          pricing: { prompt: "0.0000004", completion: 0.000002, junk: { nested: true } },
          datacenters: [{ country_code: "US" }, { country_code: "not valid!" }, { bad: 1 }],
          openrouter: { slug: "z-ai/glm-5.2" },
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
    expect(m.pricing).toEqual({ prompt: "0.0000004", completion: "0.000002" });
    expect(m.datacenters).toEqual([{ country_code: "US" }]);
    expect(m.openrouter_slug).toBe("z-ai/glm-5.2");
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
    proto: "openai",
    name: "Alias Fast",
    description: "d",
    hugging_face_id: "org/x",
    quantization: "fp8",
    openrouter_slug: "org/x",
    always_on: 1,
    enabled: 1,
    context_length: 100_000,
    max_output_length: 4096,
    created: 1700000000,
    input_modalities: '["text","image"]',
    output_modalities: '["text"]',
    sampling_params: '["temperature"]',
    features: '["tools"]',
    reasoning_efforts: '["low","high"]',
    pricing: '{"prompt":"0.1","completion":"0.2"}',
    datacenters: '[{"country_code":"US"}]',
    source: "manual",
    created_at: 1,
    updated_at: 1,
  };

  test("renders the rich format", () => {
    const e = publicModelEntry(row, "my-provider") as any;
    expect(e.provider).toBe("my-provider");
    expect(e.id).toBe("alias-fast");
    expect(e.always_on).toBe(true);
    expect(e.name).toBe("Alias Fast");
    expect(e.reasoning_parameters).toEqual({ efforts: ["low", "high"] });
    expect(e.input_modalities).toEqual(["text", "image"]);
    expect(e.context_length).toBe(100_000);
    expect(e.max_output_length).toBe(4096);
    expect(e.pricing).toEqual({ prompt: "0.1", completion: "0.2" });
    expect(e.created).toBe(1700000000);
    expect(e.supported_sampling_parameters).toEqual(["temperature"]);
    expect(e.supported_features).toEqual(["tools"]);
    expect(e.openrouter).toEqual({ slug: "org/x" });
    expect(e.datacenters).toEqual([{ country_code: "US" }]);
  });

  test("omits unknown optional fields", () => {
    const sparse: ModelRow = {
      ...row,
      name: "",
      reasoning_efforts: null,
      pricing: null,
      datacenters: null,
      context_length: null,
      max_output_length: null,
      created: null,
      openrouter_slug: "",
    };
    const e = publicModelEntry(sparse, "p") as any;
    expect(e.name).toBe("alias-fast"); // falls back to id
    expect("reasoning_parameters" in e).toBe(false);
    expect("pricing" in e).toBe(false);
    expect("datacenters" in e).toBe(false);
    expect("context_length" in e).toBe(false);
    expect("openrouter" in e).toBe(false);
  });
});

describe("model routing with proto 'both'", () => {
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
  const mk = (id: string, proto: ModelRow["proto"]): ModelRow => ({
    id,
    provider_id: "p1",
    upstream_model: id,
    proto,
    name: "",
    description: "",
    hugging_face_id: "",
    quantization: "",
    openrouter_slug: "",
    always_on: 1,
    enabled: 1,
    context_length: null,
    max_output_length: null,
    created: null,
    input_modalities: '["text"]',
    output_modalities: '["text"]',
    sampling_params: "[]",
    features: "[]",
    reasoning_efforts: null,
    pricing: null,
    datacenters: null,
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
      ["m-both", mk("m-both", "both")],
      ["m-openai", mk("m-openai", "openai")],
      ["m-anthropic", mk("m-anthropic", "anthropic")],
    ]),
    targets: new Map([
      ["m-both", [target("m-both")]],
      ["m-openai", [target("m-openai")]],
      ["m-anthropic", [target("m-anthropic")]],
    ]),
    providers: new Map([["p1", routedProvider]]),
  };

  test("'both' resolves on either surface; single-proto stays gated", () => {
    expect(resolveModelRoute(snap, "openai", "m-both")).toMatchObject({ ok: true });
    expect(resolveModelRoute(snap, "anthropic", "m-both")).toMatchObject({ ok: true });
    expect(resolveModelRoute(snap, "anthropic", "m-openai")).toMatchObject({ ok: false, status: 404 });
    expect(resolveModelRoute(snap, "openai", "m-anthropic")).toMatchObject({ ok: false, status: 404 });
  });

  test("listings include 'both' on their own surface only", () => {
    expect(listableModels(snap, "openai").map((m) => m.id)).toEqual(["m-both", "m-openai"]);
    expect(listableModels(snap, "anthropic").map((m) => m.id)).toEqual(["m-anthropic", "m-both"]);
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
    expect(classifyHttpError(404, JSON.stringify({ error: { message: "The model `gpt-x` does not exist" } }))).toBe("transient");
  });

  test("client errors are NOT fail-able", () => {
    expect(classifyHttpError(400, JSON.stringify({ error: { message: "messages: field required" } }))).toBeNull();
    expect(classifyHttpError(404, "not found")).toBeNull();
    expect(classifyHttpError(413, "too large")).toBeNull();
    expect(classifyHttpError(422, "{}")).toBeNull();
    expect(classifyHttpError(301, "")).toBeNull();
  });
});

describe("failover: cooldowns and key usability", () => {
  test("no cooldown below the threshold, exponential after", () => {
    const t0 = Date.now();
    expect(nextCooldown(1)).toBeNull();
    expect(nextCooldown(2)).toBeNull();
    const c3 = nextCooldown(3)!;
    expect(c3).toBeGreaterThanOrEqual(t0 + 30_000);
    expect(c3).toBeLessThan(t0 + 31_000);
    const c5 = nextCooldown(5)!;
    expect(c5).toBeGreaterThanOrEqual(t0 + 120_000); // 30s * 2^2
    // capped at max
    expect(nextCooldown(20)!).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
  });

  test("billing cooldown lands on the next UTC midnight", () => {
    // 2026-01-15 10:30 UTC -> midnight of the 16th
    const at = Date.UTC(2026, 0, 15, 10, 30);
    expect(billingCooldownUntil(at)).toBe(Date.UTC(2026, 0, 16));
  });

  test("keyUsable: billing auto-retries after midnight, auth stays out", () => {
    const now = Date.now();
    expect(keyUsable({ status: "active", cooldown_until: null, exhausted_reason: null }, now)).toBe(true);
    expect(keyUsable({ status: "active", cooldown_until: now - 1, exhausted_reason: null }, now)).toBe(true);
    expect(keyUsable({ status: "active", cooldown_until: now + 10_000, exhausted_reason: null }, now)).toBe(false);
    expect(keyUsable({ status: "disabled", cooldown_until: null, exhausted_reason: null }, now)).toBe(false);
    expect(keyUsable({ status: "exhausted", cooldown_until: null, exhausted_reason: "auth" }, now)).toBe(false);
    expect(keyUsable({ status: "exhausted", cooldown_until: now + 10_000, exhausted_reason: "billing" }, now)).toBe(false);
    expect(keyUsable({ status: "exhausted", cooldown_until: now - 1, exhausted_reason: "billing" }, now)).toBe(true);
  });

  test("live overlay blocks immediately and clears", () => {
    const id = `test-${Math.random()}`;
    expect(keyBlockedNow(id)).toBe(false);
    liveKeyBlock(id, null);
    expect(keyBlockedNow(id)).toBe(true);
    liveKeyClear(id);
    expect(keyBlockedNow(id)).toBe(false);
    liveKeyBlock(id, Date.now() + 60_000);
    expect(keyBlockedNow(id)).toBe(true);
    liveKeyBlock(id, Date.now() - 1);
    expect(keyBlockedNow(id)).toBe(false);
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
    id, provider_id: "p1", upstream_model: id, proto: "openai",
    name: "", description: "", hugging_face_id: "", quantization: "", openrouter_slug: "",
    always_on: 1, enabled: 1, context_length: null, max_output_length: null, created: null,
    input_modalities: '["text"]', output_modalities: '["text"]', sampling_params: "[]",
    features: "[]", reasoning_efforts: null, pricing: null, datacenters: null,
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

  test("exhausted/cooling keys and disabled targets are skipped; empty chain → 503", () => {
    const snap: RouterSnapshot = {
      mode: "router",
      models: new Map([["m", model("m")]]),
      targets: new Map([["m", [target("m", "p1", "m", 0)]]]),
      providers: new Map([
        ["p1", { row: provider, keys: [key("k1", 0, { status: "exhausted", exhaustedReason: "auth" }), key("k2", 10, { cooldownUntil: Date.now() + 60_000 })] }],
      ]),
    };
    expect(resolveModelRoute(snap, "openai", "m")).toMatchObject({ ok: false, status: 503 });

    // billing-exhausted key whose midnight passed is usable again
    const snap2: RouterSnapshot = {
      ...snap,
      providers: new Map([
        ["p1", { row: provider, keys: [key("k1", 0, { status: "exhausted", exhaustedReason: "billing", cooldownUntil: Date.now() - 1 })] }],
      ]),
    };
    const r = resolveModelRoute(snap2, "openai", "m");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.candidates.map((c) => c.key.id)).toEqual(["k1"]);
  });

  test("passthroughCandidates walks providers by priority, skipping blocked keys", () => {
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
    // anthropic capability missing on both
    expect(passthroughCandidates(snap, "anthropic")).toEqual([]);
  });
});


describe("StreamMeter fallback (upstream never reports usage)", () => {
  const enc = new TextEncoder();

  test("openai stream: tokenx estimate of the output text — not the digit count", () => {
    const m = new StreamMeter("openai");
    // 20 chunks x 100 chars of content, no usage chunk anywhere.
    for (let i = 0; i < 20; i++) {
      m.feed(enc.encode(`data: {"model":"m1","choices":[{"delta":{"content":"${"y".repeat(100)}"}}]}\n\n`));
    }
    const r = m.result(0);
    expect(r.estimated).toBe(true);
    expect(r.inTok).toBe(0); // input estimate happens at the call site
    // Whole text (2000 chars) fits the estimation sample, so the meter must
    // land exactly on tokenx's count. The pre-fix code returned 1-2 here.
    expect(r.outTok).toBe(estimateTokenCount("y".repeat(2000)));
    expect(r.outTok).toBeGreaterThan(100); // a real order of magnitude
    expect(r.model).toBe("m1");
  });

  test("anthropic stream: text_delta is tokenx-estimated when usage events are missing", () => {
    const m = new StreamMeter("anthropic");
    m.feed(enc.encode(`event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"${"z".repeat(400)}"}}\n\n`));
    const r = m.result(0);
    expect(r.estimated).toBe(true);
    expect(r.outTok).toBe(estimateTokenCount("z".repeat(400)));
    expect(r.outTok).toBeGreaterThan(10);
  });

  test("long streams: the capped sample extrapolates to the full length", () => {
    const m = new StreamMeter("openai");
    // 8000 chars of English prose — well beyond the 2048-char sample cap.
    let stream = "";
    while (stream.length < 8000) stream += "The quick brown fox jumps over the lazy dog. ";
    stream = stream.slice(0, 8000);
    for (const chunk of stream.match(/.{1,100}/g)!) {
      m.feed(enc.encode(`data: {"model":"m1","choices":[{"delta":{"content":${JSON.stringify(chunk)}}}]}\n\n`));
    }
    const r = m.result(0);
    expect(r.estimated).toBe(true);
    // The per-char ratio of the first sample extrapolates to (at least) the
    // same order as counting the whole text — never the pre-fix ~1 token.
    const full = estimateTokenCount(stream);
    expect(r.outTok).toBeGreaterThanOrEqual(Math.floor(full * 0.9));
    expect(r.outTok).toBeLessThanOrEqual(Math.ceil(full * 1.1));
  });

  test("real usage events still win over the estimate", () => {
    const m = new StreamMeter("openai");
    m.feed(enc.encode(`data: {"model":"m1","choices":[{"delta":{"content":"${"y".repeat(100)}"}}]}\n\n`));
    m.feed(enc.encode(`data: {"usage":{"prompt_tokens":7,"completion_tokens":42}}\n\n`));
    const r = m.result(0);
    expect(r.estimated).toBe(false);
    expect(r.outTok).toBe(42);
    expect(r.inTok).toBe(7);
  });
});

describe("estimateBodyTokens (estimated input from the request body)", () => {
  test("runs tokenx over string values only — JSON keys/structure add no tokens", () => {
    const body = { model: "llm-1", messages: [{ role: "user", content: "a".repeat(400) }] };
    expect(estimateBodyTokens(body)).toBe(estimateTokenCount(`llm-1 user ${"a".repeat(400)}`));
  });

  test("never returns zero for a non-empty body", () => {
    expect(estimateBodyTokens({ model: "x" })).toBeGreaterThanOrEqual(1);
  });
});
