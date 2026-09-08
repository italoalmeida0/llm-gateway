export interface GatewayModel {
  id: string;
  name: string;
  proto?: "openai" | "anthropic" | "both";
  limit?: { context?: number; output?: number };
}

export interface SessionContext {
  usedTokens: number;
  windowTokens: number;
  model: string;
  estimated: boolean;
}

export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(n));
}

export function contextDisplay(context: SessionContext | null, model?: GatewayModel) {
  // Prefer the current gateway configuration, including when its limit was removed.
  const window = model ? (model.limit?.context ?? 0) : (context?.windowTokens ?? 0);
  const used = context?.usedTokens ?? null;
  const percent = used !== null && window > 0 ? Math.round(used * 100 / window) : null;
  return {
    used, window, percent,
    label: used === null ? "Context —" : `${context?.estimated ? "~" : ""}${compactTokens(used)}${percent === null ? "" : ` (${percent}%)`}`,
  };
}
