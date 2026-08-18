import { db } from "./db";

export interface GridFilterEntry {
  filterType?: string;
  type?: string;
  filter?: unknown;
  filterTo?: unknown;
  dateFrom?: unknown;
  dateTo?: unknown;
  operator?: string;
  conditions?: GridFilterEntry[];
}

export interface GridSort {
  colId: string;
  sort: string;
}

export interface ColSpec {
  col: string;
  kind?: "text" | "number" | "date";
}

export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Keyset cursor for `ORDER BY ts DESC, id DESC` grids: "<ts>:<id>" of the
 *  previous page's last row. Replaces deep OFFSET walks with O(page) index
 *  jumps. Malformed input returns null (callers fall back to OFFSET). */
export function parseCursor(raw: string | null): { ts: number; id: number } | null {
  if (!raw) return null;
  const m = raw.match(/^(\d{1,16}):(\d{1,16})$/);
  if (!m) return null;
  const ts = Number(m[1]);
  const id = Number(m[2]);
  return Number.isSafeInteger(ts) && Number.isSafeInteger(id) ? { ts, id } : null;
}

export function buildGridWhere(
  filters: Record<string, GridFilterEntry> | undefined,
  cols: Record<string, ColSpec>,
): { clauses: string[]; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  const utcDay = (raw: unknown): number | null => {
    if (typeof raw !== "string") return null;
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const ts = Date.UTC(year, month - 1, day);
    const d = new Date(ts);
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
      ? ts
      : null;
  };

  const conditionWhere = (
    spec: ColSpec,
    f: GridFilterEntry,
  ): { sql: string; params: Array<string | number> } | null => {
    const type = String(f.type ?? "").toLowerCase();
    const filterType = String(f.filterType ?? "").toLowerCase();

    if (filterType === "date" || (spec.kind === "date" && filterType !== "number")) {
      const from = utcDay(f.dateFrom ?? f.filter);
      const to = utcDay(f.dateTo ?? f.filterTo);
      if (type === "blank") return { sql: `${spec.col} IS NULL`, params: [] };
      if (type === "notblank") return { sql: `${spec.col} IS NOT NULL`, params: [] };
      if (from === null) return null;
      const nextFrom = from + 86_400_000;
      if (type === "inrange" && to !== null) {
        return {
          sql: `${spec.col} >= ? AND ${spec.col} < ?`,
          params: [from, to + 86_400_000],
        };
      }
      if (type === "equals") return { sql: `${spec.col} >= ? AND ${spec.col} < ?`, params: [from, nextFrom] };
      if (type === "notequal") return { sql: `(${spec.col} < ? OR ${spec.col} >= ?)`, params: [from, nextFrom] };
      if (type === "lessthan") return { sql: `${spec.col} < ?`, params: [from] };
      if (type === "lessthanorequal") return { sql: `${spec.col} < ?`, params: [nextFrom] };
      if (type === "greaterthan") return { sql: `${spec.col} >= ?`, params: [nextFrom] };
      if (type === "greaterthanorequal") return { sql: `${spec.col} >= ?`, params: [from] };
      return null;
    }

    if (spec.kind === "number" || filterType === "number") {
      if (spec.kind !== "number") return null;
      if (type === "blank") return { sql: `${spec.col} IS NULL`, params: [] };
      if (type === "notblank") return { sql: `${spec.col} IS NOT NULL`, params: [] };
      const n = Number(f.filter);
      const nTo = Number(f.filterTo);
      if (type === "inrange" && Number.isFinite(n) && Number.isFinite(nTo)) {
        return { sql: `${spec.col} BETWEEN ? AND ?`, params: [n, nTo] };
      }
      if (!Number.isFinite(n)) return null;
      const op =
        type === "equals" ? "="
        : type === "notequal" ? "<>"
        : type === "lessthan" ? "<"
        : type === "lessthanorequal" ? "<="
        : type === "greaterthan" ? ">"
        : type === "greaterthanorequal" ? ">="
        : null;
      return op ? { sql: `${spec.col} ${op} ?`, params: [n] } : null;
    }

    const val = String(f.filter ?? "").slice(0, 200);
    if (type === "blank") return { sql: `(${spec.col} IS NULL OR ${spec.col} = '')`, params: [] };
    if (type === "notblank") return { sql: `(${spec.col} IS NOT NULL AND ${spec.col} <> '')`, params: [] };
    if (val.length === 0) return null;
    if (type === "equals" || type === "notequal") {
      return {
        sql: `${spec.col} ${type === "notequal" ? "<>" : "="} ?`,
        params: [val],
      };
    }
    const neg = type === "notcontains";
    const like =
      type === "startswith" ? `${likeEscape(val)}%`
      : type === "endswith" ? `%${likeEscape(val)}`
      : `%${likeEscape(val)}%`;
    return {
      sql: `${spec.col} ${neg ? "NOT " : ""}LIKE ? ESCAPE '\\'`,
      params: [like],
    };
  };

  for (const [colId, f] of Object.entries(filters ?? {})) {
    const spec = cols[colId];
    if (!spec || !f || typeof f !== "object") continue;
    const conditions = Array.isArray(f.conditions) ? f.conditions.slice(0, 8) : [f];
    const built = conditions.map((condition) => conditionWhere(spec, condition)).filter(Boolean) as Array<{
      sql: string;
      params: Array<string | number>;
    }>;
    if (built.length === 0) continue;
    const join = String(f.operator ?? "AND").toUpperCase() === "OR" ? " OR " : " AND ";
    clauses.push(built.length === 1 ? built[0]!.sql : `(${built.map((x) => x.sql).join(join)})`);
    for (const condition of built) params.push(...condition.params);
  }
  return { clauses, params };
}

export function buildGridOrder(
  sort: GridSort[] | undefined,
  cols: Record<string, ColSpec>,
  defaultOrder: string,
  tieBreak?: string,
): string {
  const parts: string[] = [];
  for (const s of sort ?? []) {
    if (!s || typeof s.colId !== "string" || (s.sort !== "asc" && s.sort !== "desc")) continue;
    const spec = cols[s.colId];
    if (!spec) continue;
    parts.push(`${spec.col} ${s.sort === "asc" ? "ASC" : "DESC"}`);
  }
  if (parts.length === 0) parts.push(defaultOrder);
  if (tieBreak) parts.push(tieBreak);
  return parts.join(", ");
}

export function parseGridQuery(url: URL): {
  limit: number;
  offset: number;
  sort?: GridSort[];
  filters?: Record<string, GridFilterEntry>;
} {
  const rawLimit = Number(url.searchParams.get("limit"));
  const rawOffset = Number(url.searchParams.get("offset"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 50;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
  let sort: GridSort[] | undefined;
  let filters: Record<string, GridFilterEntry> | undefined;
  try {
    const s = url.searchParams.get("sort");
    if (s) {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) sort = parsed.slice(0, 8);
    }
    const f = url.searchParams.get("filters");
    if (f) {
      const parsed = JSON.parse(f);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        filters = parsed;
      }
    }
  } catch {}
  return { limit, offset, sort, filters };
}

export interface GridPageArgs {
  baseSql: string;
  baseParams: Array<string | number>;
  cols: Record<string, ColSpec>;
  grid: { limit: number; offset: number; sort?: GridSort[]; filters?: Record<string, GridFilterEntry> };
  defaultOrder: string;
  tieBreak?: string;
  /** Optional FROM-clause override for the COUNT query. Default counts the
   *  joined baseSql as a subquery — fine for small tables, but a LEFT JOIN
   *  resolves per ROW and an unbounded table (audit_log) pays one PK lookup
   *  per history row (~200ms at 1.8M rows, measured). Pass the join-free
   *  `FROM …` when no filter needs the joined columns: the count only has to
   *  agree with the filtered row set, and LEFT JOINs never filter. */
  countFrom?: string;
  /** Output column names of baseSql to SUM over the filtered set (footer
   *  totals for the grid). Server-side constants — same trust level as the
   *  cols map, never request input; still validated as bare identifiers
   *  before splicing into SQL. */
  sumCols?: string[];
}

export function gridPage(a: GridPageArgs): { rows: any[]; total: number; totals?: Record<string, number> } {
  const { clauses, params } = buildGridWhere(a.grid.filters, a.cols);
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const order = buildGridOrder(a.grid.sort, a.cols, a.defaultOrder, a.tieBreak);
  const rows = db
    .prepare(`SELECT * FROM (${a.baseSql})${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...a.baseParams, ...params, a.grid.limit, a.grid.offset);
  const sumCols = (a.sumCols ?? []).filter((c) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c));
  if (sumCols.length > 0) {
    // One combined COUNT+SUM pass over the same WHERE as the page (not the
    // countFrom shortcut — the sums need baseSql's output columns), so
    // footer totals always agree with the filtered row set.
    const agg = db
      .prepare<{ n: number } & Record<string, number>, Array<string | number>>(
        `SELECT COUNT(*) AS n, ${sumCols.map((c) => `COALESCE(SUM(${c}), 0) AS ${c}`).join(", ")} FROM (${a.baseSql})${where}`,
      )
      .get(...a.baseParams, ...params)!;
    const totals: Record<string, number> = {};
    for (const c of sumCols) totals[c] = agg[c] ?? 0;
    return { rows, total: agg.n, totals };
  }
  const total = db
    .prepare<{ n: number }, Array<string | number>>(
      a.countFrom
        ? `SELECT COUNT(*) AS n ${a.countFrom}${where}`
        : `SELECT COUNT(*) AS n FROM (${a.baseSql})${where}`,
    )
    .get(...a.baseParams, ...params)!.n;
  return { rows, total };
}
