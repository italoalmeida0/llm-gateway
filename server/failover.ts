import { LIMITS } from "./config";

/**
 * Upstream failover classification + sticky-winner ordering.
 *
 * Policy: the gateway NEVER removes a key from rotation automatically.
 * Every upstream failure is classified only to decide whether the request
 * moves on to the next candidate WITHIN that same request:
 *
 *   billing     out of credits / quota exhausted (HTTP 402, or an
 *               "insufficient_quota"-style error in any 4xx) → fail over
 *               to the next candidate; the real error reaches the client
 *               when every candidate fails.
 *   auth        the key itself was rejected (401/403 with no billing hint)
 *               → fail over to the next candidate (401/403 is sometimes a
 *               transient moderation/geoblock rejection, not a dead key).
 *   rate_limit  a 429 without quota hints → fail over to the next
 *   transient   candidate (5xx, 408, network, timeout).
 *   null        a plain client error (400 invalid request, 413, ...) → the
 *               response is delivered to the client as-is; every other
 *               candidate would reject it identically, so no failover.
 *
 * The only skip that still exists is `status = 'disabled'` — an explicit
 * admin choice via PATCH /api/admin/... (`keyUsable`). Billing/auth/
 * transient failures are only OBSERVABILITY (audit-logged by the proxy)
 * plus a short-lived in-memory ordering hint (sticky winner, below) —
 * the client owns backoff/retry and always receives the real upstream
 * error (with Retry-After forwarded when the provider sends one).
 *
 * Sticky winner: serving N keys in strict priority order means every
 * request re-tries a known-bad key first until it recovers. Instead the
 * proxy remembers, per routing lane, which candidate answered last:
 * subsequent requests try that winner FIRST (TTL 10min, sliding, global,
 * in-memory only). A failed winner is dropped mid-request (the loop
 * already continues to the next candidate) and a full sweep failure
 * clears the lane so nothing stays pinned to a dead candidate. Expiry
 * (inactivity) or admin-driven candidate changes also restart from
 * priority order. classifyHttpError stays a pure function of
 * (status, error body peek) so it can be unit-tested without HTTP.
 */

export type FailClass = "billing" | "auth" | "rate_limit" | "transient" | "model_not_found";

/** Quota/billing phrases seen across OpenAI, Anthropic and OpenRouter-style
 *  providers (matched against a ≤16KB error-body peek, case-insensitive). */
const BILLING_RE =
  /insufficient_?quota|insufficient[ _-]credits?|credit balance|out of credits|out[ _-]of[ _-]budget|available balance|billing|payment[ _-]required|quota[ _-]exceeded|exceeded your (current )?quota|account is not active|(monthly[ _-])?usage[ _-]limit|(?:go|free)usagelimiterror/i;

/** 404 is fail-able when it means "this provider doesn't have the model"
 *  (classic cross-provider fallback trigger), not a bad URL of ours. */
// Wrong-provider affinity misses surface as provider-specific rejections:
// synthetic "hf: prefix" / "not a valid model ID", openrouter "No endpoints
// found". All mean "this provider can't serve that id" -> try the next
// candidate (same as model_not_found), never deliver as client error —
// and never touch key state: the key is healthy, it correctly rejected
// an id it doesn't serve.
export const MODEL_NOT_FOUND_RE =
  /model[ '"]?.*\bnot found|no such model|unknown model|does not exist|model_not_found|not a valid model ID|hf: ?prefix|No endpoints found/i;

/**
 * Map an upstream HTTP failure to a failover class, or null for client
 * errors that must be passed through untouched. `bodyPeek` is the (capped)
 * error body; only its first KB matters for the regexes.
 */
export function classifyHttpError(status: number, bodyPeek: string): FailClass | null {
  const hint = bodyPeek.slice(0, 4096);

  if (status === 402) return "billing";
  if (status === 401 || status === 403) return BILLING_RE.test(hint) ? "billing" : "auth";
  if (status === 429) {
    if (/retry[- ]?(?:in|after)|retrydelay|rate[- ]?limits/i.test(hint)) return "rate_limit";
    return BILLING_RE.test(hint) ? "billing" : "rate_limit";
  }
  if (status === 400) return BILLING_RE.test(hint) ? "billing" : null;
  if (status === 404) {
    if (BILLING_RE.test(hint)) return "billing";
    if (MODEL_NOT_FOUND_RE.test(hint)) return "model_not_found";
    return null;
  }
  if (status === 408 || status >= 500) return "transient";
  return null;
}

/** Legacy (no-skip policy): consecutive-failure cooldowns are gone —
 *  kept as a no-op so older call sites/tests fail loudly at import time
 *  instead of silently changing behavior. Do not use. */
export function nextCooldown(_failCount: number): number | null {
  return null;
}

/** Legacy (no-skip policy): midnight auto-retry no longer exists — keys
 *  never leave rotation, so there is nothing to retry. Kept for import
 *  compatibility only. */
export function billingCooldownUntil(_now = Date.now()): number {
  return _now;
}

/** Is this provider key currently usable? Only an explicit admin
 *  `disabled` removes a key from rotation — billing/auth/transient
 *  failures never do (the client owns backoff; see module header). */
export function keyUsable(
  k: { status: string; cooldown_until?: number | null; exhausted_reason?: string | null },
): boolean {
  return k.status !== "disabled";
}

// ===== sticky winner (in-memory last-good ordering hint) =====
// Key insight: with no automatic skip, strict priority order would re-try
// a known-bad key FIRST on every request. The sticky winner remembers per
// routing lane which candidate answered last, so the hot path is 1 attempt
// in steady state. Memory-only (restart = priority order), TTL sliding on
// every success, cleared on full-sweep failure (never pin a dead winner).

export interface StickyWinner {
  providerId: string;
  keyId: string;
  upstreamModel: string;
  via: string;
}

const stickyLanes = new Map<string, { winner: StickyWinner; expiresAt: number }>();

function stickyTtlMs(): number {
  return LIMITS.keyStickyTtlMs;
}

export function stickyGet(lane: string, now = Date.now()): StickyWinner | null {
  const e = stickyLanes.get(lane);
  if (!e) return null;
  if (e.expiresAt <= now) {
    stickyLanes.delete(lane);
    return null;
  }
  return e.winner;
}

export function stickySet(lane: string, winner: StickyWinner, now = Date.now()): void {
  stickyLanes.set(lane, { winner, expiresAt: now + stickyTtlMs() });
}

export function stickyClear(lane: string): void {
  stickyLanes.delete(lane);
}

export function stickyClearAll(): void {
  stickyLanes.clear();
}
