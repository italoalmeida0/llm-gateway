import { db } from "./db";

export interface GridFilterEntry {
  filterType?: string;
  type?: string;
  filter?: unknown;
  filterTo?: unknown;
}

export interface GridSort {
  colId: string;
  sort: string;
}

export interface ColSpec {
  col: string;
  kind?: "text" | "number";
}

export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function buildGridWhere(
  filters: Record<string, GridFilterEntry> | undefined,
  cols: Record<string, ColSpec>,
): { clauses: string[]; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  for (const [colId, f] of Object.entries(filters ?? {})) {
    const spec = cols[colId];
    if (!spec || !f || typeof f !== "object") continue;
    const type = String(f.type ?? "").toLowerCase();
    if (spec.kind === "number" || f.filterType === "number") {
      if (spec.kind !== "number") continue;
      const n = Number(f.filter);
      const nTo = Number(f.filterTo);
      if (type === "inrange" && Number.isFinite(n) && Number.isFinite(nTo)) {
        clauses.push(`${spec.col} BETWEEN ? AND ?`);
        params.push(n, nTo);
      } else if (Number.isFinite(n)) {
        const op =
          type === "equals" ? "="
          : type === "notequal" ? "<>"
          : type === "lessthan" ? "<"
          : type === "lessthanorequal" ? "<="
          : type === "greaterthan" ? ">"
          : type === "greaterthanorequal" ? ">="
          : null;
        if (op) {
          clauses.push(`${spec.col} ${op} ?`);
          params.push(n);
        }
      }
      continue;
    }
    const val = String(f.filter ?? "").slice(0, 200);
    if (val.length === 0) continue;
    if (type === "equals" || type === "notequal") {
      clauses.push(`${spec.col} ${type === "notequal" ? "<>" : "="} ?`);
      params.push(val);
    } else {
      const neg = type === "notcontains";
      const like =
        type === "startswith" ? `${likeEscape(val)}%`
        : type === "endswith" ? `%${likeEscape(val)}`
        : `%${likeEscape(val)}%`;
      clauses.push(`${spec.col} ${neg ? "NOT " : ""}LIKE ? ESCAPE '\\'`);
      params.push(like);
    }
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
}

export function gridPage(a: GridPageArgs): { rows: any[]; total: number } {
  const { clauses, params } = buildGridWhere(a.grid.filters, a.cols);
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const order = buildGridOrder(a.grid.sort, a.cols, a.defaultOrder, a.tieBreak);
  const rows = db
    .prepare(`SELECT * FROM (${a.baseSql})${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...a.baseParams, ...params, a.grid.limit, a.grid.offset);
  const total = db
    .prepare<{ n: number }, Array<string | number>>(
      `SELECT COUNT(*) AS n FROM (${a.baseSql})${where}`,
    )
    .get(...a.baseParams, ...params)!.n;
  return { rows, total };
}