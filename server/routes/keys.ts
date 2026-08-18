import { LIMITS, GATEWAY_SECRET } from "../config";
import { db, audit, type ApiKeyRow } from "../db";
import { requireAuth } from "../auth";
import { createKey, publicKey, queryKeys, revokeKey } from "../keys";
import { decryptSecret } from "../crypto";
import { parseGridQuery } from "../gridql";
import { clientIp, err, ok, readJsonBody, v } from "../http";

const MAX_KEYS_PER_USER = 50;
const MAX_TTL_MS = 10 * 365 * 24 * 3600 * 1000;

function ownKey(userId: string, keyId: string): ApiKeyRow | null {
  const row = db
    .prepare<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE id = ?")
    .get(keyId);
  if (!row || row.user_id !== userId) return null;
  return row;
}

/** /api/keys — a user managing their own API keys. */
export async function handleKeysRoute(path: string, req: Request): Promise<Response | null> {
  if (path === "/api/keys" && req.method === "GET") {
    const ctx = await requireAuth(req);
    if (new URL(req.url).searchParams.has("limit")) {
      const grid = parseGridQuery(new URL(req.url));
      const { keys, total } = queryKeys(ctx.user.id, grid);
      return ok({ keys, total, limit: grid.limit, offset: grid.offset }, req);
    }
    const rows = db
      .prepare<ApiKeyRow, [string]>(
        "SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC",
      )
      .all(ctx.user.id);
    return ok({ keys: rows.map((r) => publicKey(r)) }, req);
  }

  if (path === "/api/keys" && req.method === "POST") {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    const body = await readJsonBody(req, LIMITS.apiBodyBytes);

    const count = db
      .prepare<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?")
      .get(ctx.user.id)!.n;
    if (count >= MAX_KEYS_PER_USER) return err(400, `limit of ${MAX_KEYS_PER_USER} keys reached`, req);

    const name = v.str(body, "name", { min: 1, max: 64 })!;
    const dailyLimit = v.int(body, "dailyLimit", { min: 1, max: 10 ** 12, optional: true });
    const totalLimit = v.int(body, "totalLimit", { min: 1, max: 10 ** 15, optional: true });
    const rpm = v.int(body, "rpm", { min: 1, max: 3600, optional: true });
    const expiresAt = v.int(body, "expiresAt", {
      min: Date.now() + 60_000,
      max: Date.now() + MAX_TTL_MS,
      optional: true,
    });

    const { row, token } = await createKey(ctx.user.id, {
      name,
      expiresAt,
      dailyLimit,
      totalLimit,
      rpm,
    });
    audit("key.created", { actorId: ctx.user.id, target: row.id, ip, meta: { name } });

    // Plaintext token: returned here AND recoverable later via GET /reveal
    // from the AES copy (token_enc) — every reveal is audit-logged.
    return ok({ key: publicKey(row), token }, req);
  }

  const m = path.match(/^\/api\/keys\/([a-f0-9]{24})(\/reveal)?$/);
  if (!m) return null;
  const keyId = m[1]!;

  if (req.method === "PATCH") {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    const key = ownKey(ctx.user.id, keyId);
    if (!key) return err(404, "key not found", req);

    const body = await readJsonBody(req, LIMITS.apiBodyBytes);
    const name = v.str(body, "name", { min: 1, max: 64, optional: true }) ?? key.name;
    const dailyLimit =
      "dailyLimit" in body ? v.int(body, "dailyLimit", { min: 1, max: 10 ** 12, optional: true }) : key.daily_limit;
    const totalLimit =
      "totalLimit" in body ? v.int(body, "totalLimit", { min: 1, max: 10 ** 15, optional: true }) : key.total_limit;
    const rpm = "rpm" in body ? v.int(body, "rpm", { min: 1, max: 3600, optional: true }) : key.rpm;

    // Raising limits re-activates an exhausted key.
    const newStatus = key.status === "exhausted" ? "active" : key.status;

    db.prepare(
      "UPDATE api_keys SET name = ?, daily_limit = ?, total_limit = ?, rpm = ?, status = ? WHERE id = ?",
    ).run(name, dailyLimit, totalLimit, rpm, newStatus, keyId);

    audit("key.updated", { actorId: ctx.user.id, target: keyId, ip });
    const updated = db
      .prepare<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE id = ?")
      .get(keyId)!;
    return ok({ key: publicKey(updated) }, req);
  }

  if (req.method === "GET" && path.endsWith("/reveal")) {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    const key = ownKey(ctx.user.id, keyId);
    if (!key) return err(404, "key not found", req);
    if (!key.token_enc) {
      return err(404, "this key predates reveal support — create a new one to get a copyable token", req);
    }
    const token = await decryptSecret(key.token_enc, GATEWAY_SECRET);
    audit("key.revealed", { actorId: ctx.user.id, target: keyId, ip });
    return ok({ token }, req);
  }

  if (req.method === "DELETE") {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    const key = ownKey(ctx.user.id, keyId);
    if (!key) return err(404, "key not found", req);

    const hard = new URL(req.url).searchParams.get("hard") === "true";
    if (hard) {
      // Permanent removal. Usage history is kept (ledger rows stay auditable).
      db.prepare("DELETE FROM api_keys WHERE id = ?").run(keyId);
      audit("key.deleted", { actorId: ctx.user.id, target: keyId, ip, meta: { name: key.name } });
      return ok({ deleted: true }, req);
    }

    revokeKey(keyId);
    audit("key.revoked", { actorId: ctx.user.id, target: keyId, ip });
    return ok({ revoked: true }, req);
  }

  return null;
}
