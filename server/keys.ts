import { GATEWAY_SECRET } from "./config";
import { db, type ApiKeyRow } from "./db";
import { encryptSecret, randomToken, sha256Hex } from "./crypto";
import { getKeySpend } from "./usage";
import { dropKeyLimiter } from "./ratelimit";
import { gridPage, type ColSpec } from "./gridql";

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

export function checkKeyAvailability(
  key: ApiKeyRow,
  now = Date.now(),
  spend?: { today: number; total: number },
): KeyCheck {
  if (key.status === "revoked") return { ok: false, reason: "revoked" };
  if (key.status === "exhausted") return { ok: false, reason: "exhausted" };
  if (key.expires_at !== null && key.expires_at <= now) return { ok: false, reason: "expired" };

  const s = spend ?? getKeySpend(key.id);
  if (key.daily_limit !== null && s.today >= key.daily_limit) {
    return { ok: false, reason: "daily_limit" };
  }
  if (key.total_limit !== null && s.total >= key.total_limit) {
    return { ok: false, reason: "total_limit" };
  }
  return { ok: true };
}

export function publicKey(row: ApiKeyRow, userEmail?: string, spend?: { today: number; total: number }) {
  const s = spend ?? getKeySpend(row.id);
  const availability = checkKeyAvailability(row, Date.now(), s);
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
    // Budgets cap output tokens, so these counters are output-only too.
    outputToday: s.today,
    outputTotal: s.total,
    revealable: !!row.token_enc,
  };
}

/**
 * Server-driven key listing (AG Grid blocks). userId narrows to one owner
 * (null = admin/global). The output-token counters become SQL columns via
 * correlated subqueries so they're sortable/filterable alongside the rest.
 */
export function queryKeys(
  userId: string | null,
  grid: { limit: number; offset: number; sort?: Array<{ colId: string; sort: string }>; filters?: Record<string, { filterType?: string; type?: string; filter?: unknown; filterTo?: unknown }> },
): { keys: ReturnType<typeof publicKey>[]; total: number } {
  const sourceSql = userId
    ? `SELECT k.*, u.email AS userEmail,
              COALESCE((SELECT out_tok FROM usage_daily WHERE key_id = k.id AND date = date('now')), 0) AS _out_today,
              COALESCE((SELECT SUM(out_tok) FROM usage_daily WHERE key_id = k.id), 0) AS _out_total
       FROM api_keys k LEFT JOIN users u ON u.id = k.user_id WHERE k.user_id = ?`
    : `SELECT k.*, u.email AS userEmail,
              COALESCE((SELECT out_tok FROM usage_daily WHERE key_id = k.id AND date = date('now')), 0) AS _out_today,
              COALESCE((SELECT SUM(out_tok) FROM usage_daily WHERE key_id = k.id), 0) AS _out_total
       FROM api_keys k LEFT JOIN users u ON u.id = k.user_id`;
  const baseSql = `
    SELECT q.*,
           CASE
             WHEN q.status = 'revoked' THEN 'revoked'
             WHEN q.status = 'exhausted' THEN 'exhausted'
             WHEN q.expires_at IS NOT NULL AND q.expires_at <= CAST(strftime('%s', 'now') AS INTEGER) * 1000 THEN 'expired'
             WHEN q.daily_limit IS NOT NULL AND q._out_today >= q.daily_limit THEN 'daily_limit'
             WHEN q.total_limit IS NOT NULL AND q._out_total >= q.total_limit THEN 'total_limit'
             ELSE 'active'
           END AS effective_status
    FROM (${sourceSql}) q`;
  const cols: Record<string, ColSpec> = {
    name: { col: "name" },
    userEmail: { col: "userEmail" },
    status: { col: "effective_status" },
    prefix: { col: "prefix" },
    outputToday: { col: "_out_today", kind: "number" },
    outputTotal: { col: "_out_total", kind: "number" },
    expiresAt: { col: "expires_at", kind: "number" },
    lastUsedAt: { col: "last_used_at", kind: "number" },
    rpm: { col: "rpm", kind: "number" },
    createdAt: { col: "created_at", kind: "number" },
  };
  const { rows, total } = gridPage({
    baseSql,
    baseParams: userId ? [userId] : [],
    cols,
    grid,
    defaultOrder: "created_at DESC",
    tieBreak: "id DESC",
  });
  const keys = (rows as Array<ApiKeyRow & { userEmail?: string; _out_today: number; _out_total: number; effective_status: ReturnType<typeof publicKey>["status"] }>).map(
    (r) => ({ ...publicKey(r, r.userEmail ?? undefined, { today: r._out_today, total: r._out_total }), status: r.effective_status }),
  );
  return { keys, total };
}
