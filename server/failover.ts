import { LIMITS } from "./config";

/**
 * Upstream failover classification.
 *
 * When the proxy has more than one candidate to serve a request (the
 * provider's ordered upstream keys, and/or the model's ordered routing
 * targets), every upstream failure is classified before deciding whether the
 * request moves on to the next candidate:
 *
 *   billing     out of credits / quota exhausted (HTTP 402, or an
 *               "insufficient_quota"-style error in any 4xx) → the key is
 *               marked `exhausted` and auto-retried after midnight UTC
 *               (daily free tiers refill then); manual re-enable works too.
 *   auth        the key itself was rejected (401/403 with no billing hint)
 *               → `exhausted` permanently, until an admin re-enables it.
 *   rate_limit  a 429 without quota hints → transient: consecutive-failure
 *   transient   counter + exponential cooldown (5xx, 408, network, timeout).
 *   null        a plain client error (400 invalid request, 413, ...) → the
 *               response is delivered to the client as-is; every other
 *               candidate would reject it identically, so no failover.
 *
 * Everything here is a pure function of (status, error body peek) so it can
 * be unit-tested without HTTP.
 */

export type FailClass = "billing" | "auth" | "rate_limit" | "transient" | "model_not_found";

/** Quota/billing phrases seen across OpenAI, Anthropic and OpenRouter-style
 *  providers (matched against a ≤16KB error-body peek, case-insensitive). */
const BILLING_RE =
  /insufficient_?quota|insufficient[ _-]credits?|credit balance|out of credits|billing|payment[ _-]required|quota[ _-]exceeded|exceeded your (current )?quota|account is not active/i;

/** 404 is fail-able when it means "this provider doesn't have the model"
 *  (classic cross-provider fallback trigger), not a bad URL of ours. */
const MODEL_NOT_FOUND_RE = /model[ '"]?.*\bnot found|no such model|unknown model|does not exist|model_not_found/i;

/**
 * Map an upstream HTTP failure to a failover class, or null for client
 * errors that must be passed through untouched. `bodyPeek` is the (capped)
 * error body; only its first KB matters for the regexes.
 */
export function classifyHttpError(status: number, bodyPeek: string): FailClass | null {
  const hint = bodyPeek.slice(0, 4096);

  if (status === 402) return "billing";
  if (status === 401 || status === 403) return BILLING_RE.test(hint) ? "billing" : "auth";
  if (status === 429) return BILLING_RE.test(hint) ? "billing" : "rate_limit";
  if (status === 400) return BILLING_RE.test(hint) ? "billing" : null;
  if (status === 404) {
    if (BILLING_RE.test(hint)) return "billing";
    if (MODEL_NOT_FOUND_RE.test(hint)) return "model_not_found";
    return null;
  }
  if (status === 408 || status >= 500) return "transient";
  return null;
}

/** Cooldown for consecutive transient/rate-limit failures: nothing until
 *  the threshold, then base * 2^extra capped at max. Success resets the
 *  counter, so intermittent blips never escalate. */
export function nextCooldown(failCount: number): number | null {
  if (failCount < LIMITS.providerFailThreshold) return null;
  const extra = failCount - LIMITS.providerFailThreshold;
  const ms = LIMITS.providerCooldownBaseMs * 2 ** Math.min(extra, 8);
  return Date.now() + Math.min(ms, LIMITS.providerCooldownMaxMs);
}

/** Billing-exhausted keys auto-retry at the next UTC midnight (free-tier
 *  quotas typically refill daily); until then they stay out of rotation. */
export function billingCooldownUntil(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
}

/** Is this provider key currently usable? Billing-exhausted keys re-enter
 *  rotation automatically once their cooldown (next UTC midnight) lapses;
 *  auth-exhausted keys stay out until an admin re-enables them. */
export function keyUsable(
  k: { status: string; cooldown_until: number | null; exhausted_reason: string | null },
  now = Date.now(),
): boolean {
  if (k.status === "disabled") return false;
  if (k.status === "exhausted") {
    if (k.exhausted_reason === "billing" && k.cooldown_until !== null) {
      return k.cooldown_until <= now;
    }
    return false;
  }
  return k.cooldown_until === null || k.cooldown_until <= now;
}

// ===== freshest in-memory overlay =====
// The router snapshot rides on a 5s cache; a key that just proved dead must
// stop being tried IMMEDIATELY (next request, next attempt), not after the
// TTL. This overlay is written together with the DB updates in the proxy and
// cleared by admin key mutations (re-enable / rotate / delete / reorder).
// `until` null = blocked indefinitely (auth exhaustion), else a timestamp.

const liveKeys = new Map<string, { until: number | null }>();

export function liveKeyBlock(keyId: string, until: number | null): void {
  liveKeys.set(keyId, { until });
}

export function liveKeyClear(keyId: string): void {
  liveKeys.delete(keyId);
}

export function keyBlockedNow(keyId: string): boolean {
  const l = liveKeys.get(keyId);
  if (!l) return false;
  return l.until === null || l.until > Date.now();
}
