import { LIMITS } from "./config";

/**
 * In-memory token-bucket rate limiters + brute-force tracker.
 * Single-process by design (the gateway is a single Bun process); counters
 * reset on restart, which is acceptable for availability controls.
 */

interface Bucket {
  tokens: number;
  resetAt: number;
}

class TokenBucket {
  private buckets = new Map<string, Bucket>();
  constructor(
    private maxTokens: number,
    private windowMs: number,
  ) {
    const sweep = setInterval(() => this.sweep(), Math.min(windowMs, 60_000));
    sweep.unref();
  }

  /** Returns the retry-after (seconds) when limited, or 0 when allowed. */
  hit(key: string, cost = 1): number {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { tokens: this.maxTokens, resetAt: now + this.windowMs };
      this.buckets.set(key, b);
    }
    if (b.tokens < cost) {
      return Math.max(1, Math.ceil((b.resetAt - now) / 1000));
    }
    b.tokens -= cost;
    return 0;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
    // Hard cap: under active flooding, never let the map grow unbounded.
    if (this.buckets.size > 50_000) this.buckets.clear();
  }
}

// ===== Named limiters =====

let ipLimiter = new TokenBucket(600, 60_000);
let authLimiter = new TokenBucket(30, 60_000);
let resetLimiter = new TokenBucket(5, 10 * 60_000);

/** Per-API-key limiters are created per key id and GC'd with the map. */
const keyRpmLimiters = new Map<string, TokenBucket>();

export function keyRpmHit(keyId: string, rpm: number): number {
  let l = keyRpmLimiters.get(keyId);
  if (!l) {
    l = new TokenBucket(rpm, 60_000);
    keyRpmLimiters.set(keyId, l);
    if (keyRpmLimiters.size > 10_000) keyRpmLimiters.clear();
  }
  return l.hit("");
}

export function dropKeyLimiter(keyId: string): void {
  keyRpmLimiters.delete(keyId);
}

export function configureLimits(opts: { ipPerMin?: number; authPerMin?: number; resetPer10Min?: number }) {
  if (opts.ipPerMin) ipLimiter = new TokenBucket(opts.ipPerMin, 60_000);
  if (opts.authPerMin) authLimiter = new TokenBucket(opts.authPerMin, 60_000);
  if (opts.resetPer10Min) resetLimiter = new TokenBucket(opts.resetPer10Min, 10 * 60_000);
}

export const limits = {
  ipPerMin: (ip: string) => ipLimiter.hit(ip),
  authPerMin: (ip: string) => authLimiter.hit(ip),
  resetPer10Min: (ip: string) => resetLimiter.hit(ip),
};

// ===== Brute-force tracker (login + TOTP failures) =====

interface FailRecord {
  count: number;
  windowStart: number;
  lockedUntil: number;
}

const failures = new Map<string, FailRecord>();
const failSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, r] of failures) {
    if (r.lockedUntil < now && r.windowStart + 15 * 60_000 < now) failures.delete(k);
  }
  if (failures.size > 50_000) failures.clear();
}, 60_000);
failSweep.unref();

const FAIL_WINDOW_MS = LIMITS.loginFailWindowMs;
const FAIL_MAX = LIMITS.loginFailMax;
const LOCKOUT_MS = LIMITS.loginLockoutMs;

/** Returns lock seconds remaining (0 = not locked). Does NOT record a failure. */
export function bruteforceLocked(scope: string): number {
  const r = failures.get(scope);
  if (!r) return 0;
  const now = Date.now();
  if (r.lockedUntil > now) return Math.ceil((r.lockedUntil - now) / 1000);
  if (r.windowStart + FAIL_WINDOW_MS < now) failures.delete(scope);
  return 0;
}

/**
 * Record a failure. `max` overrides the lock threshold: per-IP scopes use a
 * much higher bar than per-account ones, because a shared IP (family, NAT,
   * CGNAT, corporate egress) must never be one person's 10 typos away from a
 * collective login outage.
 */
export function bruteforceFail(scope: string, max = FAIL_MAX): void {
  const now = Date.now();
  let r = failures.get(scope);
  if (!r || r.windowStart + FAIL_WINDOW_MS < now) {
    r = { count: 0, windowStart: now, lockedUntil: 0 };
    failures.set(scope, r);
  }
  r.count++;
  if (r.count >= max) {
    r.lockedUntil = now + LOCKOUT_MS;
    r.count = 0;
    r.windowStart = now;
  }
}

export function bruteforceClear(scope: string): void {
  failures.delete(scope);
}

// ===== TOTP anti-replay (a valid code may be used only once) =====

const usedTotpCodes = new Map<string, number>();
const totpSweep = setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of usedTotpCodes) if (exp < now) usedTotpCodes.delete(k);
  if (usedTotpCodes.size > 50_000) usedTotpCodes.clear();
}, 60_000);
totpSweep.unref();

/** Returns false if this exact code digest was already consumed recently. */
export function consumeTotpCode(digest: string): boolean {
  if (usedTotpCodes.has(digest)) return false;
  usedTotpCodes.set(digest, Date.now() + 90_000);
  return true;
}

// ===== Proxy concurrency control (per API key + global upstream) =====

const keyConcurrency = new Map<string, number>();
let totalUpstreamInFlight = 0;

export function acquireUpstreamSlot(keyId: string, perKeyMax: number, globalMax = 256): boolean {
  if (totalUpstreamInFlight >= globalMax) return false;
  const cur = keyConcurrency.get(keyId) ?? 0;
  if (cur >= perKeyMax) return false;
  keyConcurrency.set(keyId, cur + 1);
  totalUpstreamInFlight++;
  return true;
}

export function releaseUpstreamSlot(keyId: string): void {
  const cur = keyConcurrency.get(keyId) ?? 0;
  if (cur <= 1) keyConcurrency.delete(keyId);
  else keyConcurrency.set(keyId, cur - 1);
  totalUpstreamInFlight = Math.max(0, totalUpstreamInFlight - 1);
}
