import { GATEWAY_SECRET } from "./config";
import { db, type ApiKeyRow } from "./db";
import { encryptSecret, randomToken, sha256Hex } from "./crypto";
import { getKeySpend } from "./usage";
import { dropKeyLimiter } from "./ratelimit";

/**
 * API key domain logic shared by user routes, admin routes and the proxy.
 *
 * Tokens look like `gw_lMk...` (48 hex chars of entropy). The SHA-256 hash is
 * the proxy lookup key; an AES-encrypted copy (token_enc) lets the owner (or
 * an admin) reveal/copy the token later — every reveal is audit-logged.
 */

export function generateKey(): { token: string; prefix: string; hash: string } {
  const token = `gw_${randomToken(24)}`;
  return { token, prefix: token.slice(0, 12), hash: sha256Hex(token) };
}

export interface CreateKeyOptions {
  name: string;
  expiresAt?: number | null;
  dailyLimit?: number | null;
  totalLimit?: number | null;
  rpm?: number | null;
}

export async function createKey(userId: string, opts: CreateKeyOptions): Promise<{ row: ApiKeyRow; token: string }> {
  const { token, prefix, hash } = generateKey();
  const id = randomToken(12);
  const tokenEnc = await encryptSecret(token, GATEWAY_SECRET);
  db.prepare(
    `INSERT INTO api_keys (id, user_id, name, prefix, hash, created_at, expires_at, daily_limit, total_limit, rpm, status, token_enc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).run(
    id,
    userId,
    opts.name.slice(0, 64),
    prefix,
    hash,
    Date.now(),
    opts.expiresAt ?? null,
    opts.dailyLimit ?? null,
    opts.totalLimit ?? null,
    opts.rpm ?? null,
    tokenEnc,
  );
  return { row: db.prepare<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE id = ?").get(id)!, token };
}

export function revokeKey(keyId: string): void {
  db.prepare("UPDATE api_keys SET status = 'revoked' WHERE id = ?").run(keyId);
  dropKeyLimiter(keyId);
}

/**
 * Effective availability of a key, evaluated at request time. A key whose
 * daily budget is spent recovers automatically at 00:00 UTC without any
 * state flip; total budget exhaustion flips `status` permanently.
 */
export type KeyCheck =
  | { ok: true }
  | { ok: false; reason: "revoked" | "exhausted" | "expired" | "daily_limit" | "total_limit" };

export function checkKeyAvailability(key: ApiKeyRow, now = Date.now()): KeyCheck {
  if (key.status === "revoked") return { ok: false, reason: "revoked" };
  if (key.status === "exhausted") return { ok: false, reason: "exhausted" };
  if (key.expires_at !== null && key.expires_at <= now) return { ok: false, reason: "expired" };

  const spend = getKeySpend(key.id);
  if (key.daily_limit !== null && spend.today >= key.daily_limit) {
    return { ok: false, reason: "daily_limit" };
  }
  if (key.total_limit !== null && spend.total >= key.total_limit) {
    return { ok: false, reason: "total_limit" };
  }
  return { ok: true };
}

export function publicKey(row: ApiKeyRow, userEmail?: string) {
  const spend = getKeySpend(row.id);
  const availability = checkKeyAvailability(row);
  return {
    id: row.id,
    userId: row.user_id,
    userEmail,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    dailyLimit: row.daily_limit,
    totalLimit: row.total_limit,
    rpm: row.rpm,
    status: availability.ok ? "active" : availability.reason,
    lastUsedAt: row.last_used_at,
    usageToday: spend.today,
    usageTotal: spend.total,
    revealable: !!row.token_enc,
  };
}
