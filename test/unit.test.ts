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
