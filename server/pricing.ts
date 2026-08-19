export type PricingValues = Record<string, number>;

/** Keep numeric pricing from provider payloads while accepting currency labels. */
export function normalizePricingValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  // Full numeric parse first: scientific notation ("4.5e-7") must survive —
  // digit-stripping alone turns it into "4.57" and silently corrupts the price.
  const cleaned = value.replace(/[\s,$€£]/g, "");
  if (/^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) {
    const number = Number(cleaned);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }
  const digits = cleaned.replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const number = Number(digits);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function normalizePricing(value: unknown): PricingValues | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: PricingValues = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= 16 || key.length > 48) continue;
    const number = normalizePricingValue(raw);
    if (number !== null) out[key] = number;
  }
  return Object.keys(out).length ? out : null;
}

function first(pricing: PricingValues | null, keys: string[]): number | null {
  if (!pricing) return null;
  for (const key of keys) {
    if (pricing[key] !== undefined) return pricing[key]!;
  }
  return null;
}

export function pricingColumns(pricing: PricingValues | null): {
  input: number | null;
  inputCache: number | null;
  inputCacheWrite: number | null;
  output: number | null;
} {
  return {
    input: first(pricing, ["prompt", "input", "input_price"]),
    inputCache: first(pricing, ["input_cache_reads", "input_cache_read", "input_cache", "cache_read", "cache"]),
    inputCacheWrite: first(pricing, ["input_cache_writes", "input_cache_write", "cache_write"]),
    output: first(pricing, ["completion", "output", "output_price"]),
  };
}
