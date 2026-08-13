/**
 * Hand-rolled cryptographic primitives on top of WebCrypto (zero deps):
 *  - PBKDF2-SHA256 password hashing (constant-time verify)
 *  - TOTP (RFC 6238) with base32 secrets
 *  - JWT HS256 sign/verify
 *  - AES-256-GCM authenticated encryption (provider keys at rest)
 *  - misc: random tokens, sha256, base64url
 *
 * Keys are derived from GATEWAY_SECRET via labeled SHA-256 so the same env
 * secret safely yields independent keys for JWT signing and DB encryption.
 */

const te = new TextEncoder();
const td = new TextDecoder();

// ===== base helpers =====

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomToken(n = 32): string {
  return Buffer.from(randomBytes(n)).toString("hex");
}

export function sha256Hex(data: string | Uint8Array): string {
  // Bun's native hashing is faster than subtle for small non-async needs,
  // but subtle keeps us runtime-portable; hashing here is off hot paths
  // except API-key lookup, so a sync native hasher is worth it.
  return new Bun.CryptoHasher("sha256").update(data as string).digest("hex");
}

export function b64uEncode(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Buffer.from(b).toString("base64url");
}

export function b64uDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

export function b64Encode(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64");
}

export function b64Decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

/** Constant-time comparison for equal-length secrets. */
export function timingSafeEq(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const ba = typeof a === "string" ? te.encode(a) : a;
  const bb = typeof b === "string" ? te.encode(b) : b;
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i]! ^ bb[i]!;
  return diff === 0;
}

async function deriveKey(label: string, secret: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", te.encode(`${label}:${secret}`));
  return new Uint8Array(digest);
}

// ===== PBKDF2 passwords =====

const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(32);
  const key = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256,
  );
  return `pbkdf2:${PBKDF2_ITERATIONS}:${b64Encode(salt)}:${b64Encode(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 2_000_000) return false;
  const salt = b64Decode(parts[2]!);
  const expected = b64Decode(parts[3]!);
  const key = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    key,
    expected.length * 8,
  );
  return timingSafeEq(new Uint8Array(bits), expected);
}

// ===== TOTP (RFC 6238 / HOTP RFC 4226) =====

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Uint8Array): string {
  let bits = 0,
    value = 0,
    out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0,
    value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

let hmacKeyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secretBytes: Uint8Array): Promise<CryptoKey> {
  const cacheKey = b64Encode(secretBytes);
  let p = hmacKeyCache.get(cacheKey);
  if (!p) {
    p = crypto.subtle.importKey(
      "raw",
      secretBytes as BufferSource,
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    if (hmacKeyCache.size > 500) hmacKeyCache = new Map(); // avoid unbounded growth
    hmacKeyCache.set(cacheKey, p);
  }
  return p;
}

async function hotp(secretBytes: Uint8Array, counter: number): Promise<string> {
  const msg = new ArrayBuffer(8);
  new DataView(msg).setUint32(4, counter, false); // big-endian 64-bit, high word 0
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secretBytes), msg));
  const offset = sig[sig.length - 1]! & 0x0f;
  const code =
    ((sig[offset]! & 0x7f) << 24) |
    ((sig[offset + 1]! & 0xff) << 16) |
    ((sig[offset + 2]! & 0xff) << 8) |
    (sig[offset + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

export async function totpAt(secret: string, timestampMs: number): Promise<string> {
  return hotp(base32Decode(secret), Math.floor(timestampMs / 1000 / 30));
}

/** Verify a 6-digit TOTP code with ±1 step tolerance. Timing-safe on success path. */
export async function totpVerify(secret: string, code: string, timestampMs = Date.now()): Promise<boolean> {
  const counter = Math.floor(timestampMs / 1000 / 30);
  const secretBytes = base32Decode(secret);
  let ok = false;
  for (const delta of [-1, 0, 1]) {
    const expected = await hotp(secretBytes, counter + delta);
    if (timingSafeEq(expected, code)) ok = true;
  }
  return ok;
}

export function totpUri(secret: string, email: string, issuer = "LLM Gateway"): string {
  return (
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`
  );
}

// ===== JWT HS256 =====

export interface JwtPayload {
  sub: string;
  jti: string;
  role?: string;
  type: "access" | "2fa";
  iat: number;
  exp: number;
  [k: string]: unknown;
}

export type JwtVerifyResult =
  | { ok: true; payload: JwtPayload }
  | { ok: false; reason: "malformed" | "signature" | "expired" };

async function hsKey(secret: string): Promise<CryptoKey> {
  const raw = await deriveKey("jwt-hs256", secret);
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function jwtSign(
  claims: Omit<JwtPayload, "iat" | "exp">,
  secret: string,
  ttlSec: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...claims, iat: now, exp: now + ttlSec } as JwtPayload;
  const head = b64uEncode(te.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64uEncode(te.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hsKey(secret), te.encode(`${head}.${body}`));
  return `${head}.${body}.${b64uEncode(sig)}`;
}

export async function jwtVerify(token: string, secret: string): Promise<JwtVerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [head, body, sig] = parts as [string, string, string];
  const expected = await crypto.subtle.sign("HMAC", await hsKey(secret), te.encode(`${head}.${body}`));
  let sigBytes: Uint8Array;
  try {
    sigBytes = b64uDecode(sig);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!timingSafeEq(new Uint8Array(expected), sigBytes)) return { ok: false, reason: "signature" };

  let payload: JwtPayload;
  try {
    payload = JSON.parse(td.decode(b64uDecode(body)));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}

// ===== AES-256-GCM (provider API keys at rest) =====

async function aesKey(secret: string): Promise<CryptoKey> {
  const raw = await deriveKey("aes-gcm", secret);
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(plain: string, secret: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    await aesKey(secret),
    te.encode(plain),
  );
  return `v1.${b64uEncode(iv)}.${b64uEncode(ct)}`;
}

export async function decryptSecret(stored: string, secret: string): Promise<string> {
  const [v, ivB64, ctB64] = stored.split(".");
  if (v !== "v1" || !ivB64 || !ctB64) throw new Error("bad encrypted blob");
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64uDecode(ivB64) as BufferSource },
    await aesKey(secret),
    b64uDecode(ctB64) as BufferSource,
  );
  return td.decode(pt);
}
