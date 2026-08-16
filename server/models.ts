import { db, type ModelRow, type ProviderRow, type RoutingMode } from "./db";
import { decryptSecret } from "./crypto";
import { GATEWAY_SECRET } from "./config";

/**
 * Model registry & routing.
 *
 * - `syncProviderModels` imports a provider's model list (GET {base}/models)
 *    into the registry. It is best-effort: it never blocks provider creation
 *    and tolerates OpenAI, Anthropic and rich (OpenRouter-style) payload
 *    shapes. Duplicates are skipped (INSERT OR IGNORE) so re-syncing never
 *    clobbers admin edits — with one exception: when the OTHER capability of
 *    the same provider lists the same upstream id, a pristine auto-imported
 *    row (never edited by an admin) is upgraded to proto='both', so
 *    dual-surface providers serve the model on both protocols.
 * - `routerSnapshot` is the proxy hot-path view (5s cache, same pattern as the
 *    provider cache): routing mode + every model row + every ENABLED provider
 *    with its decrypted key. Admin mutations call invalidateModelCache().
 * - `publicModelEntry` renders the rich /v1/models entry (the format shown in
 *    the gateway's own listing when routing mode is "router").
 */

const SYNC_TIMEOUT_MS = 8_000;
const SYNC_MAX_MODELS = 1_000;

// ---------- settings (routing mode) ----------

export function getRoutingMode(): RoutingMode {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
    .get("routing_mode");
  return row?.value === "router" ? "router" : "passthrough";
}

export function setRoutingMode(mode: RoutingMode): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('routing_mode', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(mode);
}

// ---------- payload parsing (tolerant: OpenAI / Anthropic / rich shapes) ----------

export interface ParsedModel {
  id: string;
  name: string;
  description: string;
  hugging_face_id: string;
  quantization: string;
  openrouter_slug: string;
  always_on: boolean;
  context_length: number | null;
  max_output_length: number | null;
  created: number | null; // unix seconds
  input_modalities: string[];
  output_modalities: string[];
  sampling_params: string[];
  features: string[];
  reasoning_efforts: string[] | null;
  pricing: Record<string, string> | null;
  datacenters: Array<{ country_code: string }> | null;
}

const str = (v: unknown, max = 256): string =>
  typeof v === "string" ? v.slice(0, max) : "";

const strArr = (v: unknown): string[] | null => {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 64);
  return out.length ? out.slice(0, 24) : null;
};

const posInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1e10 ? Math.floor(v) : null;

function parsePricing(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (Object.keys(out).length >= 16) break;
    if (k.length > 48) continue;
    if (typeof val === "string" && val.length <= 32) out[k] = val;
    else if (typeof val === "number" && Number.isFinite(val)) out[k] = String(val);
  }
  return Object.keys(out).length ? out : null;
}

function parseDatacenters(v: unknown): Array<{ country_code: string }> | null {
  if (!Array.isArray(v)) return null;
  const out: Array<{ country_code: string }> = [];
  for (const d of v) {
    const cc = (d as Record<string, unknown> | null)?.country_code;
    if (typeof cc === "string" && /^[A-Za-z0-9-]{1,8}$/.test(cc)) out.push({ country_code: cc });
    if (out.length >= 24) break;
  }
  return out.length ? out : null;
}

function parseModalities(m: Record<string, unknown>): { input: string[]; output: string[] } {
  const arch = (m.architecture ?? null) as Record<string, unknown> | null;
  let input = strArr(m.input_modalities) ?? strArr(arch?.input_modalities);
  let output = strArr(m.output_modalities) ?? strArr(arch?.output_modalities);
  if ((!input || !output) && typeof arch?.modality === "string") {
    // OpenRouter packs it as "text+image->text".
    const [i, o] = (arch.modality as string).split("->");
    const side = (s: string | undefined) =>
      s ? s.split("+").map((x) => x.trim()).filter(Boolean) : null;
    input ??= side(i);
    output ??= side(o);
  }
  return { input: input ?? ["text"], output: output ?? ["text"] };
}

/**
 * Extract model entries from a provider's GET /models payload. Accepts the
 * plain OpenAI shape ({data:[{id, created, owned_by}]}), the Anthropic shape
 * ({data:[{type:"model", id, display_name, created_at}]}) and rich
 * OpenRouter-style entries. Invalid ids are skipped; the result is capped.
 */
export function parseUpstreamModels(payload: unknown): ParsedModel[] {
  const data = (payload as Record<string, unknown> | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: ParsedModel[] = [];
  for (const raw of data) {
    if (out.length >= SYNC_MAX_MODELS) break;
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const id = str(m.id);
    if (!id || /\s/.test(id) || /[\x00-\x1f]/.test(id)) continue;
    const openrouter = (m.openrouter ?? null) as Record<string, unknown> | null;
    const reasoningParams = (m.reasoning_parameters ?? null) as Record<string, unknown> | null;
    const topProvider = (m.top_provider ?? null) as Record<string, unknown> | null;
    const modalities = parseModalities(m);
    out.push({
      id,
      name: str(m.name) || str(m.display_name) || id,
      description: str(m.description, 2000),
      hugging_face_id: str(m.hugging_face_id),
      quantization: str(m.quantization),
      openrouter_slug: str(openrouter?.slug),
      always_on: typeof m.always_on === "boolean" ? m.always_on : true,
      context_length: posInt(m.context_length) ?? posInt(topProvider?.context_length),
      max_output_length:
        posInt(m.max_output_length) ??
        posInt(m.max_completion_tokens) ??
        posInt(topProvider?.max_completion_tokens),
      created: parseCreated(m),
      input_modalities: modalities.input,
      output_modalities: modalities.output,
      sampling_params:
        strArr(m.supported_sampling_parameters) ?? strArr(m.supported_parameters) ?? [],
      features: strArr(m.supported_features) ?? [],
      reasoning_efforts: strArr(reasoningParams?.efforts) ?? strArr(m.reasoning_efforts),
      pricing: parsePricing(m.pricing),
      datacenters: parseDatacenters(m.datacenters),
    });
  }
  return out;
}

function parseCreated(m: Record<string, unknown>): number | null {
  if (typeof m.created === "number" && Number.isFinite(m.created) && m.created > 0)
    return Math.floor(m.created);
  if (typeof m.created_at === "string") {
    const t = Date.parse(m.created_at);
    if (Number.isFinite(t)) return Math.floor(t / 1000);
  }
  return null;
}

// ---------- sync ----------

export interface SyncOutcome {
  added: number;
  skipped: number;
  /** Rows upgraded to proto='both' because the other capability of the same
   *  provider listed the same upstream id (pristine auto rows only). */
  merged: number;
  error?: string;
}

function authHeaders(provider: ProviderRow, proto: "openai" | "anthropic", key: string): Record<string, string> {
  const style = proto === "openai" ? provider.openai_auth_style : provider.anthropic_auth_style;
  return style === "bearer"
    ? { Authorization: `Bearer ${key}` }
    : proto === "openai"
      ? { "api-key": key }
      : { "x-api-key": key };
}

const insertModel = db.prepare(
  `INSERT OR IGNORE INTO models
     (id, provider_id, upstream_model, proto, name, description, hugging_face_id,
      quantization, openrouter_slug, always_on, enabled, context_length,
      max_output_length, created, input_modalities, output_modalities,
      sampling_params, features, reasoning_efforts, pricing, datacenters,
      source, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?)`,
);

/**
 * Promote a row to proto='both' when this provider's other capability lists
 * the same upstream id. Guarded to pristine auto-imported rows
 * (updated_at = created_at): once an admin touches the row, its proto is
 * never changed by a sync again.
 */
const mergeProtoBoth = db.prepare(
  `UPDATE models SET proto = 'both', updated_at = ?
   WHERE id = ? AND provider_id = ? AND upstream_model = ? AND source = 'auto'
     AND proto != ? AND proto != 'both' AND updated_at = created_at`,
);

/**
 * Import models for every capability the provider exposes. Returns per-capability
 * counts; a failing capability yields {added:0, skipped:0, error} and never
 * throws — sync must not block provider creation.
 */
export async function syncProviderModels(
  provider: ProviderRow,
  plaintextKey: string,
): Promise<Partial<Record<"openai" | "anthropic", SyncOutcome>>> {
  const out: Partial<Record<"openai" | "anthropic", SyncOutcome>> = {};
  const caps: Array<["openai" | "anthropic", string | null]> = [
    ["openai", provider.openai_base_url],
    ["anthropic", provider.anthropic_base_url],
  ];
  const now = Date.now();
  for (const [proto, base] of caps) {
    if (!base) continue;
    try {
      const res = await fetch(`${base}/models`, {
        headers: { Accept: "application/json", ...authHeaders(provider, proto, plaintextKey) },
        signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
      });
      if (!res.ok) {
        out[proto] = { added: 0, skipped: 0, merged: 0, error: `HTTP ${res.status}` };
        continue;
      }
      const parsed = parseUpstreamModels((await res.json()) as unknown);
      let added = 0;
      let merged = 0;
      db.transaction(() => {
        for (const m of parsed) {
          const r = insertModel.run(
            m.id,
            provider.id,
            m.id, // auto-import: upstream id == public id
            proto,
            m.name,
            m.description,
            m.hugging_face_id,
            m.quantization,
            m.openrouter_slug,
            m.always_on ? 1 : 0,
            m.context_length,
            m.max_output_length,
            m.created,
            JSON.stringify(m.input_modalities),
            JSON.stringify(m.output_modalities),
            JSON.stringify(m.sampling_params),
            JSON.stringify(m.features),
            m.reasoning_efforts ? JSON.stringify(m.reasoning_efforts) : null,
            m.pricing ? JSON.stringify(m.pricing) : null,
            m.datacenters ? JSON.stringify(m.datacenters) : null,
            now,
            now,
          );
          added += r.changes;
          if (r.changes === 0) merged += mergeProtoBoth.run(now, m.id, provider.id, m.id, proto).changes;
        }
      })();
      out[proto] = { added, skipped: parsed.length - added - merged, merged };
    } catch (e) {
      out[proto] = { added: 0, skipped: 0, merged: 0, error: e instanceof Error ? e.message : "sync failed" };
    }
  }
  if (Object.keys(out).length) invalidateModelCache();
  return out;
}

// ---------- public /v1/models format ----------

const jsonArr = (s: string | null): unknown[] => {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

const jsonObj = (s: string | null): Record<string, unknown> | null => {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** The rich registry entry shape served by /v1/models in router mode. */
export function publicModelEntry(m: ModelRow, providerName: string): Record<string, unknown> {
  const efforts = jsonArr(m.reasoning_efforts);
  const pricing = jsonObj(m.pricing);
  const datacenters = jsonArr(m.datacenters);
  const entry: Record<string, unknown> = {
    provider: providerName,
    always_on: !!m.always_on,
    id: m.id,
    hugging_face_id: m.hugging_face_id,
    name: m.name || m.id,
  };
  if (efforts.length) entry.reasoning_parameters = { efforts };
  entry.description = m.description;
  entry.input_modalities = jsonArr(m.input_modalities);
  entry.output_modalities = jsonArr(m.output_modalities);
  if (m.context_length != null) entry.context_length = m.context_length;
  if (m.max_output_length != null) entry.max_output_length = m.max_output_length;
  if (pricing) entry.pricing = pricing;
  if (m.created != null) entry.created = m.created;
  entry.quantization = m.quantization;
  entry.supported_sampling_parameters = jsonArr(m.sampling_params);
  entry.supported_features = jsonArr(m.features);
  if (m.openrouter_slug) entry.openrouter = { slug: m.openrouter_slug };
  if (datacenters.length) entry.datacenters = datacenters;
  return entry;
}

/** Admin dashboard DTO (camelCase, JSON fields parsed). */
export function publicModelAdmin(m: ModelRow & { provider_name?: string | null }) {
  return {
    id: m.id,
    providerId: m.provider_id,
    providerName: m.provider_name ?? null,
    upstreamModel: m.upstream_model,
    proto: m.proto,
    name: m.name,
    description: m.description,
    huggingFaceId: m.hugging_face_id,
    quantization: m.quantization,
    openrouterSlug: m.openrouter_slug,
    alwaysOn: !!m.always_on,
    enabled: !!m.enabled,
    contextLength: m.context_length,
    maxOutputLength: m.max_output_length,
    created: m.created,
    inputModalities: jsonArr(m.input_modalities),
    outputModalities: jsonArr(m.output_modalities),
    samplingParams: jsonArr(m.sampling_params),
    features: jsonArr(m.features),
    reasoningEfforts: m.reasoning_efforts ? jsonArr(m.reasoning_efforts) : null,
    pricing: jsonObj(m.pricing),
    datacenters: m.datacenters ? jsonArr(m.datacenters) : null,
    source: m.source,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
}


// ---------- router snapshot (proxy hot path) ----------

export interface RoutedProvider {
  row: ProviderRow;
  key: string;
}

export interface RouterSnapshot {
  mode: RoutingMode;
  /** ALL model rows (any enabled state) — the proxy distinguishes
   *  404-unknown vs 404-disabled vs 503-orphaned from this map. */
  models: Map<string, ModelRow>;
  /** Enabled providers only, keyed by id, with decrypted keys. */
  providers: Map<string, RoutedProvider>;
}

const SNAP_TTL_MS = 5_000;
let snapCache: { snap: RouterSnapshot; at: number } | null = null;
let snapPromise: Promise<RouterSnapshot> | null = null;

export function routerSnapshot(): Promise<RouterSnapshot> {
  const now = Date.now();
  if (snapCache && now - snapCache.at < SNAP_TTL_MS) return Promise.resolve(snapCache.snap);
  snapPromise ??= (async () => {
    const mode = getRoutingMode();
    const models = new Map<string, ModelRow>();
    for (const m of db.query<ModelRow, []>("SELECT * FROM models").all()) models.set(m.id, m);
    const providers = new Map<string, RoutedProvider>();
    for (const row of db
      .query<ProviderRow, []>("SELECT * FROM providers WHERE enabled = 1 ORDER BY priority, created_at")
      .all()) {
      try {
        providers.set(row.id, { row, key: await decryptSecret(row.api_key_enc, GATEWAY_SECRET) });
      } catch {
        // Corrupt key material: leave the provider out — its models 503
        // instead of taking the whole proxy down.
      }
    }
    const snap: RouterSnapshot = { mode, models, providers };
    snapCache = { snap, at: Date.now() };
    return snap;
  })().finally(() => {
    snapPromise = null;
  });
  return snapPromise;
}

export function invalidateModelCache(): void {
  snapCache = null;
}

export function providerHasCapability(row: ProviderRow, proto: "openai" | "anthropic"): boolean {
  return proto === "openai" ? !!row.openai_base_url : !!row.anthropic_base_url;
}

/** Resolve a requested public model id against the registry (router mode). */
export type ModelResolution =
  | { ok: true; provider: RoutedProvider; upstreamModel: string }
  | { ok: false; status: 404 | 503; code: string; message: string };

/** Does a registry entry serve this protocol surface? */
function servesProto(m: ModelRow, proto: "openai" | "anthropic"): boolean {
  return m.proto === proto || m.proto === "both";
}

export function resolveModelRoute(
  snap: RouterSnapshot,
  proto: "openai" | "anthropic",
  model: string,
): ModelResolution {
  const m = snap.models.get(model);
  if (!m || !servesProto(m, proto)) {
    return {
      ok: false,
      status: 404,
      code: "model_not_found",
      message: `unknown model '${model}' — this gateway routes through its model registry`,
    };
  }
  if (!m.enabled) {
    return { ok: false, status: 404, code: "model_not_found", message: `model '${model}' is disabled` };
  }
  if (!m.provider_id) {
    return {
      ok: false,
      status: 503,
      code: "model_unavailable",
      message: `model '${model}' has no provider configured`,
    };
  }
  const provider = snap.providers.get(m.provider_id);
  if (!provider || !providerHasCapability(provider.row, proto)) {
    return {
      ok: false,
      status: 503,
      code: "model_unavailable",
      message: `model '${model}': its provider is unavailable for this protocol`,
    };
  }
  return { ok: true, provider, upstreamModel: m.upstream_model };
}

/** Models visible in /v1/models for a protocol: enabled + provider serves it. */
export function listableModels(snap: RouterSnapshot, proto: "openai" | "anthropic"): ModelRow[] {
  const out: ModelRow[] = [];
  for (const m of snap.models.values()) {
    if (!m.enabled || !servesProto(m, proto) || !m.provider_id) continue;
    const p = snap.providers.get(m.provider_id);
    if (!p || !providerHasCapability(p.row, proto)) continue;
    out.push(m);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

