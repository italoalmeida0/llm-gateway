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

export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(n));
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
