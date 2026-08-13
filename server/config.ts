import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "fs";
import path from "path";

/**
 * Central configuration. Everything comes from env, all optional knobs have
 * safe defaults. GATEWAY_SECRET is the only hard requirement in production;
 * in dev it is generated once and persisted under DATA_DIR/.secret.
 */

export const NODE_ENV = process.env.NODE_ENV || "production";
export const IS_PROD = NODE_ENV === "production";
export const PORT = Number(process.env.PORT || 3000);
export const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dir, "..", "data");
export const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
export const TRUST_PROXY = process.env.TRUST_PROXY === "true";
export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";

export const SMTP = {
  host: process.env.SMTP_HOST || "",
  port: Number(process.env.SMTP_PORT || 587),
  user: process.env.SMTP_USER || "",
  pass: process.env.SMTP_PASS || "",
  from: process.env.SMTP_FROM || "LLM Gateway <no-reply@localhost>",
  secure: process.env.SMTP_SECURE === "true",
};
export const SMTP_ENABLED = !!SMTP.host;

export const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

// ===== Secret bootstrap =====

function loadSecret(): string {
  const envSecret = process.env.GATEWAY_SECRET || "";
  if (envSecret && envSecret.length >= 32) return envSecret;

  if (IS_PROD) {
    console.error(
      "[BOOT] FATAL: GATEWAY_SECRET is missing or shorter than 32 chars in production.\n" +
        "       Generate one with: openssl rand -hex 32",
    );
    process.exit(1);
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const secretFile = path.join(DATA_DIR, ".secret");
  if (existsSync(secretFile)) return readFileSync(secretFile, "utf8").trim();

  const generated = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  writeFileSync(secretFile, generated);
  try {
    chmodSync(secretFile, 0o600);
  } catch {}
  console.warn(`[BOOT] dev mode: generated GATEWAY_SECRET and stored it in ${secretFile}`);
  return generated;
}

export const GATEWAY_SECRET = loadSecret();

// ===== Limits (tunable via env for stress tests) =====

export const LIMITS = {
  /** body caps */
  authBodyBytes: Number(process.env.LIMIT_AUTH_BODY_BYTES || 16 * 1024),
  apiBodyBytes: Number(process.env.LIMIT_API_BODY_BYTES || 256 * 1024),
  proxyBodyBytes: Number(process.env.LIMIT_PROXY_BODY_BYTES || 4 * 1024 * 1024),

  /** global per-IP token bucket */
  ipPerMin: Number(process.env.LIMIT_IP_PER_MIN || 600),
  /** stricter buckets for credential endpoints */
  authPerMinPerIp: Number(process.env.LIMIT_AUTH_PER_MIN || 30),
  resetPer10MinPerIp: Number(process.env.LIMIT_RESET_PER_10MIN || 5),

  /** brute force: N failures in window -> lockout (per account) */
  loginFailWindowMs: 15 * 60 * 1000,
  loginFailMax: 10,
  loginLockoutMs: 15 * 60 * 1000,
  /**
   * Password-spray guard per source IP. Deliberately much higher than the
   * per-account threshold: IPs are shared (family, NAT, CGNAT, company
   * egress), so this bucket must stop sprays without letting a handful of
   * typos block everyone behind the same address.
   */
  loginIpFailMax: Number(process.env.LIMIT_LOGIN_IP_FAIL_MAX || 50),

  /** defaults applied when a key leaves them empty */
  defaultKeyRpm: Number(process.env.DEFAULT_KEY_RPM || 120),
  defaultKeyConcurrency: Number(process.env.DEFAULT_KEY_CONCURRENCY || 8),

  /** upstream behavior */
  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 120_000),
  upstreamNonStreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_NONSTREAM_MS || 60_000),
  breakerFailThreshold: 5,
  breakerOpenMs: 30_000,

  /** JWT / sessions */
  accessTokenTtlSec: 12 * 3600,
  refreshTokenTtlMs: 30 * 24 * 3600 * 1000, // sliding
  refreshAbsoluteTtlMs: 180 * 24 * 3600 * 1000,
  twoFaTempTtlSec: 5 * 60,
  passwordTokenTtlMs: 24 * 3600 * 1000, // invite + reset links
};

mkdirSync(DATA_DIR, { recursive: true });
