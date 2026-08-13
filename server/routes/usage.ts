import { requireAuth } from "../auth";
import { ok } from "../http";
import { userDailySeries, userEvents, userSummary, keyDailySeries, hourlySeries } from "../usage";
import { db, type ApiKeyRow } from "../db";

/** /api/usage — the authenticated user's own consumption data. */
export async function handleUsageRoute(path: string, req: Request, url: URL): Promise<Response | null> {
  if (path === "/api/usage/summary" && req.method === "GET") {
    const ctx = await requireAuth(req);
    return ok({ summary: userSummary(ctx.user.id) }, req);
  }

  if (path === "/api/usage/daily" && req.method === "GET") {
    const ctx = await requireAuth(req);
    const keyId = url.searchParams.get("key_id");
    let key: ApiKeyRow | undefined;
    if (keyId) {
      key = db.prepare<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE id = ?").get(keyId);
      if (!key || key.user_id !== ctx.user.id) return ok({ series: [] }, req);
    }

    // Hour granularity: trailing N hours from usage_events (for the "1D" view).
    const hoursParam = url.searchParams.get("hours");
    if (hoursParam !== null) {
      const hours = Math.min(Math.max(Number(hoursParam) || 24, 1), 168);
      return ok(
        { series: hourlySeries(ctx.user.id, keyId ?? null, hours), granularity: "hour" },
        req,
      );
    }

    const days = Math.min(Number(url.searchParams.get("days") || 14), 365);
    if (keyId) return ok({ series: keyDailySeries(keyId!, days), granularity: "day" }, req);
    return ok({ series: userDailySeries(ctx.user.id, days), granularity: "day" }, req);
  }

  if (path === "/api/usage/events" && req.method === "GET") {
    const ctx = await requireAuth(req);
    const keyId = url.searchParams.get("key_id") || undefined;
    if (keyId) {
      const key = db.prepare<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE id = ?").get(keyId);
      if (!key || key.user_id !== ctx.user.id) return ok({ events: [], total: 0 }, req);
    }
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 25), 1), 100);
    const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
    const { rows, total } = userEvents(ctx.user.id, { keyId, limit, offset });
    return ok({ events: rows, total, limit, offset }, req);
  }

  if (path === "/api/usage/by-model" && req.method === "GET") {
    const ctx = await requireAuth(req);
    const days = Math.min(Math.max(Number(url.searchParams.get("days") || 14), 1), 365);
    const keyId = url.searchParams.get("key_id");
    if (keyId) {
      const key = db.prepare<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE id = ?").get(keyId);
      if (!key || key.user_id !== ctx.user.id) return ok({ models: [] }, req);
    }
    const since = Date.now() - days * 86_400_000;
    const rows = db
      .prepare(
        `SELECT model, proto,
                SUM(in_tok) AS in_tok, SUM(cache_tok) AS cache_tok, SUM(out_tok) AS out_tok, COUNT(*) AS reqs
         FROM usage_events
         WHERE user_id = ? AND ts >= ? ${keyId ? "AND key_id = ?" : ""}
         GROUP BY model, proto
         ORDER BY (SUM(in_tok) + SUM(cache_tok) + SUM(out_tok)) DESC
         LIMIT 25`,
      )
      .all(...(keyId ? [ctx.user.id, since, keyId] : [ctx.user.id, since])) as any[];
    return ok(
      {
        models: rows.map((r) => ({
          model: r.model || "(unknown)",
          proto: r.proto,
          in_tok: r.in_tok,
          cache_tok: r.cache_tok,
          out_tok: r.out_tok,
          reqs: r.reqs,
        })),
      },
      req,
    );
  }

  return null;
}
