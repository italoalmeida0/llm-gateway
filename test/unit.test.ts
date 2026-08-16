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
  publicModelEntry,
  resolveModelRoute,
  type RouterSnapshot,
} from "../server/models";
import type { ModelRow, ProviderRow } from "../server/db";

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
  const snap: RouterSnapshot = {
    mode: "router",
    models: new Map([
      ["m-both", mk("m-both", "both")],
      ["m-openai", mk("m-openai", "openai")],
      ["m-anthropic", mk("m-anthropic", "anthropic")],
    ]),
    providers: new Map([["p1", { row: provider, key: "k" }]]),
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

