export interface GatewayModel {
  id: string;
  name: string;
  /** Provider of the first routing target (fallback order). */
  provider: string;
  /** Upstream model id of the first routing target. */
  upstreamModel: string;
  /** Context window in tokens (256k when the registry reports none). */
  context: number;
  /** Max output in tokens (65536 when the registry reports none). */
  output: number;
}

export interface SessionContext {
  usedTokens: number;
  windowTokens: number;
  model: string;
  estimated: boolean;
}

/** Group models by provider (first routing target), keeping first-appearance order. */
export function groupModelsByProvider(models: GatewayModel[]): Array<{ provider: string; models: GatewayModel[] }> {
  const out: Array<{ provider: string; models: GatewayModel[] }> = [];
  const byName = new Map<string, GatewayModel[]>();
  for (const m of models) {
    const p = m.provider || "Other";
    let list = byName.get(p);
    if (!list) {
      list = [];
      byName.set(p, list);
      out.push({ provider: p, models: list });
    }
    list.push(m);
  }
  return out;
}

/**
 * Compact token formatter: at most 4 significant chars + one K/M/B/T
 * suffix (e.g. 12.3B, 123M, 5.23T, 125K — never "125.K", never a
 * trailing "."). Anything at/above 1000T is capped at "999T".
 */
export function compactTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const neg = n < 0;
  const v = Math.round(Math.abs(n));
  if (v < 1000) return neg ? String(-v) : String(v);
  const scaled = (div: number, suffix: string): string => {
    let s = v / div;
    if (suffix === "T" && s >= 1000) s = 999;
    const digits = s >= 100 ? 0 : s >= 10 ? 1 : 2;
    return `${neg ? "-" : ""}${s.toFixed(digits)}${suffix}`;
  };
  if (v >= 1_000_000_000_000) return scaled(1_000_000_000_000, "T");
  if (v >= 1_000_000_000) return scaled(1_000_000_000, "B");
  if (v >= 1_000_000) return scaled(1_000_000, "M");
  return scaled(1_000, "K");
}

export function contextDisplay(context: SessionContext | null, model?: GatewayModel) {
  // Prefer the current gateway configuration, including when its limit was removed.
  const window = model ? (model.context ?? 0) : (context?.windowTokens ?? 0);
  const used = context?.usedTokens ?? null;
  const percent = used !== null && window > 0 ? Math.round(used * 100 / window) : null;
  return {
    used, window, percent,
    label: used === null ? "Context —" : `${context?.estimated ? "~" : ""}${compactTokens(used)}${percent === null ? "" : ` (${percent}%)`}`,
  };
}
