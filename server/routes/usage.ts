import { requireAuth } from "../auth";
import { ok } from "../http";
import { userDailySeries, userEvents, userSummary, keyDailySeries, hourlySeries, userUsageBreakdown } from "../usage";
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

    // "all" = no lower date bound (the ALL window in the UI).
    const daysParam = url.searchParams.get("days");
    const days = daysParam === "all" ? "all" : Math.min(Number(daysParam || 14), 365);
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
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 500);
    const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
    const { rows, total } = userEvents(ctx.user.id, { keyId, limit, offset });
    return ok({ events: rows, total, limit, offset }, req);
  }

  if (path === "/api/usage/breakdown" && req.method === "GET") {
    const ctx = await requireAuth(req);
    const daysParam = url.searchParams.get("days");
    const keyId = url.searchParams.get("key_id");
    if (keyId) {
      const key = db.prepare<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE id = ?").get(keyId);
      if (!key || key.user_id !== ctx.user.id) return ok({ rows: [] }, req);
    }
    const providerId = url.searchParams.get("provider_id") || undefined;
    const days = daysParam === "all" ? "all" : daysParam;
    const rows = userUsageBreakdown(ctx.user.id, {
      keyId: keyId ?? undefined,
      providerId,
      days: days as number | "all",
    });
    return ok({ rows }, req);
  }

  if (path === "/api/usage/by-model" && req.method === "GET") {
    const ctx = await requireAuth(req);
    const daysParam = url.searchParams.get("days");
    const keyId = url.searchParams.get("key_id");
    if (keyId) {
      const key = db.prepare<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE id = ?").get(keyId);
      if (!key || key.user_id !== ctx.user.id) return ok({ models: [] }, req);
    }
    // Reads the usage_model_daily rollup (migration 006), not usage_events:
    // identical answers, ~150x faster at scale (4ms vs 668ms @ 3.65M events).
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (keyId) {
      clauses.push("key_id = ?");
      params.push(keyId);
    }
    clauses.push("user_id = ?");
    params.push(ctx.user.id);
    if (daysParam !== "all") {
      clauses.push("date >= date('now', ?)");
      params.push(`-${Math.min(Math.max(Number(daysParam) || 14, 1), 365)} days`);
    }
    const rows = db
      .prepare(
        `SELECT model, proto,
                SUM(in_tok) AS in_tok, SUM(cache_tok) AS cache_tok, SUM(out_tok) AS out_tok, SUM(reqs) AS reqs
         FROM usage_model_daily
         WHERE ${clauses.join(" AND ")}
         GROUP BY model, proto
         ORDER BY (SUM(in_tok) + SUM(cache_tok) + SUM(out_tok)) DESC
         LIMIT 25`,
      )
      .all(...(params as [string, string])) as any[];
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
