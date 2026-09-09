import {
  db,
  type ModelRow,
  type ModelTargetRow,
  type ProviderKeyRow,
  type ProviderRow,
  type RoutingMode,
} from "./db";
import { decryptSecret } from "./crypto";
import { GATEWAY_SECRET } from "./config";
import { keyUsable } from "./failover";
import { normalizePricing, pricingColumns } from "./pricing";

/**
 * Model registry & routing.
 *
 * Registry entries carry no protocol: every model serves both surfaces
 * (Anthropic requests to OpenAI-only providers go through translation).
 * - `previewProviderModels` fetches a provider's GET /models lists without
 *    importing (the dashboard shows counts before importing);
 *    `syncProviderModels` imports the union of every configured capability.
 *    Best-effort: never blocks provider creation, tolerates OpenAI /
 *    Anthropic / rich (OpenRouter-style) payload shapes, and duplicates are
 *    skipped (INSERT OR IGNORE) so re-syncing never clobbers admin edits.
 * - Every model has an ORDERED list of routing targets (`model_targets`):
 *    (provider, upstream_model) pairs tried in priority order by the proxy's
 *    failover loop. `models.provider_id`/`models.upstream_model` are a
 *    denormalized mirror of the top-1 target for pre-failover readers —
 *    `refreshModelMirror()` recomputes them after every mutation.
 * - `routerSnapshot` is the proxy hot-path view (5s cache, same pattern as the
 *    old provider cache): routing mode + every model row + every target +
 *    every ENABLED provider with ALL its keys decrypted (ordered). Admin
 *    mutations call invalidateModelCache().
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
  context_length: number | null;
  max_output_length: number | null;
  input_modalities: string[];
  output_modalities: string[];
  sampling_params: string[];
  features: string[];
  reasoning_efforts: string[] | null;
  pricing: Record<string, number> | null;
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
    // eslint-disable-next-line no-control-regex -- intentional: reject control chars in public model ids
    if (!id || /\s/.test(id) || /[\x00-\x1f]/.test(id)) continue;
    const reasoningParams = (m.reasoning_parameters ?? null) as Record<string, unknown> | null;
    const topProvider = (m.top_provider ?? null) as Record<string, unknown> | null;
    const modalities = parseModalities(m);
    out.push({
      id,
      name: str(m.name) || str(m.display_name) || id,
      description: str(m.description, 2000),
      context_length: posInt(m.context_length) ?? posInt(topProvider?.context_length),
      max_output_length:
        posInt(m.max_output_length) ??
        posInt(m.max_completion_tokens) ??
        posInt(topProvider?.max_completion_tokens),
      input_modalities: modalities.input,
      output_modalities: modalities.output,
      sampling_params:
        strArr(m.supported_sampling_parameters) ?? strArr(m.supported_parameters) ?? [],
      features: strArr(m.supported_features) ?? [],
      reasoning_efforts: strArr(reasoningParams?.efforts) ?? strArr(m.reasoning_efforts),
      pricing: normalizePricing(m.pricing),
    });
  }
  return out;
}

// ---------- sync ----------

export interface SyncOutcome {
  added: number;
  skipped: number;
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
     (id, provider_id, upstream_model, name, description, enabled, context_length,
      max_output_length, input_modalities, output_modalities,
       sampling_params, features, reasoning_efforts, pricing,
       pricing_input, pricing_input_cache, pricing_input_cache_write, pricing_output,
       source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?)`,
);

/** A freshly imported model gets its provider as the priority-0 target. */
const insertTarget = db.prepare(
  `INSERT OR IGNORE INTO model_targets (model_id, provider_id, upstream_model, priority, enabled, created_at)
   VALUES (?, ?, ?, 0, 1, ?)`,
);



/** Fetch one capability's GET /models list. Never throws. */
async function fetchCapabilityModels(
  provider: ProviderRow,
  proto: "openai" | "anthropic",
  plaintextKey: string,
): Promise<{ models: ParsedModel[] } | { error: string }> {
  const base = proto === "openai" ? provider.openai_base_url : provider.anthropic_base_url;
  if (!base) return { error: "not configured" };
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Accept: "application/json", ...authHeaders(provider, proto, plaintextKey) },
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { models: parseUpstreamModels((await res.json()) as unknown) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "sync failed" };
  }
}

/** Per-capability preview of a provider's model lists (before importing). */
export interface CapPreview {
  count?: number;
  sample?: string[];
  error?: string;
}

export interface SyncPreview {
  openai?: CapPreview;
  anthropic?: CapPreview;
  /** Ids present on both lists (only when both fetches succeeded). */
  common?: number;
}

/**
 * Fetch every configured capability's model list WITHOUT importing — the
 * dashboard shows this and asks how to import (mode "both" | "separate").
 */
export async function previewProviderModels(
  provider: ProviderRow,
  plaintextKey: string,
): Promise<SyncPreview> {
  const out: SyncPreview = {};
  const ids: Partial<Record<"openai" | "anthropic", Set<string>>> = {};
  for (const proto of ["openai", "anthropic"] as const) {
    const base = proto === "openai" ? provider.openai_base_url : provider.anthropic_base_url;
    if (!base) continue;
    const r = await fetchCapabilityModels(provider, proto, plaintextKey);
    if ("error" in r) {
      out[proto] = { error: r.error };
    } else {
      ids[proto] = new Set(r.models.map((m) => m.id));
      out[proto] = { count: r.models.length, sample: r.models.slice(0, 5).map((m) => m.id) };
    }
  }
  if (ids.openai && ids.anthropic) {
    let common = 0;
    for (const id of ids.openai) if (ids.anthropic!.has(id)) common++;
    out.common = common;
  }
  return out;
}

/**
 * Import models for every capability the provider exposes (union of the
 * configured lists — registry entries carry no protocol). Returns
 * per-capability counts; a failing capability yields {added:0, skipped:0,
 * error} and never throws — sync must not block provider creation.
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
    const r = await fetchCapabilityModels(provider, proto, plaintextKey);
    if ("error" in r) {
      out[proto] = { added: 0, skipped: 0, error: r.error };
      continue;
    }
    const parsed = r.models;
    let added = 0;
    db.transaction(() => {
      for (const m of parsed) {
        const prices = pricingColumns(m.pricing);
        const r2 = insertModel.run(
          m.id,
          provider.id,
          m.id, // auto-import: upstream id == public id
          m.name,
          m.description,
          m.context_length,
          m.max_output_length,
          JSON.stringify(m.input_modalities),
          JSON.stringify(m.output_modalities),
          JSON.stringify(m.sampling_params),
          JSON.stringify(m.features),
          m.reasoning_efforts ? JSON.stringify(m.reasoning_efforts) : null,
          m.pricing ? JSON.stringify(m.pricing) : null,
          prices.input,
          prices.inputCache,
          prices.inputCacheWrite,
          prices.output,
          now,
          now,
        );
        added += r2.changes;
        // New rows only: existing models keep whatever targets the admin
        // configured (an orphaned id is also never auto-healed by a sync).
        if (r2.changes === 1) insertTarget.run(m.id, provider.id, m.id, now);
      }
    })();
    out[proto] = { added, skipped: parsed.length - added };
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

function modelPricing(m: ModelRow): Record<string, number> | null {
  const pricing = normalizePricing(jsonObj(m.pricing)) ?? {};
  if (m.pricing_input != null) pricing.prompt = m.pricing_input;
  if (m.pricing_input_cache != null) pricing.input_cache_reads = m.pricing_input_cache;
  if (m.pricing_input_cache_write != null) pricing.input_cache_writes = m.pricing_input_cache_write;
  if (m.pricing_output != null) pricing.completion = m.pricing_output;
  return Object.keys(pricing).length ? pricing : null;
}

/** Fallback context window (tokens) reported when the upstream advertises none. */
export const DEFAULT_MODEL_CONTEXT = 256_000;

/** Shared public metadata. Unknown output limits stay absent; an unknown
 *  context window is reported as DEFAULT_MODEL_CONTEXT. */
export function publicModelSummary(m: ModelRow) {
  const limit: { context?: number; output?: number } = {
    context: m.context_length ?? DEFAULT_MODEL_CONTEXT,
  };
  if (m.max_output_length != null) limit.output = m.max_output_length;
  return { id: m.id, name: m.name || m.id, limit };
}

/** The rich registry entry shape served by /v1/models in router mode. */
export function publicModelEntry(m: ModelRow, providerName: string): Record<string, unknown> {
  const efforts = jsonArr(m.reasoning_efforts);
  const pricing = modelPricing(m);
  const entry: Record<string, unknown> = {
    ...publicModelSummary(m),
    provider: providerName,
  };
  if (efforts.length) entry.reasoning_parameters = { efforts };
  entry.description = m.description;
  entry.input_modalities = jsonArr(m.input_modalities);
  entry.output_modalities = jsonArr(m.output_modalities);
  if (m.context_length != null) entry.context_length = m.context_length;
  if (m.max_output_length != null) entry.max_output_length = m.max_output_length;
  if (pricing) entry.pricing = pricing;
  entry.supported_sampling_parameters = jsonArr(m.sampling_params);
  entry.supported_features = jsonArr(m.features);
  return entry;
}

/** Admin dashboard DTO (camelCase, JSON fields parsed). */
export function publicModelAdmin(
  m: ModelRow & { provider_name?: string | null },
  targets?: ModelTargetDto[],
) {
  return {
    id: m.id,
    providerId: m.provider_id,
    providerName: m.provider_name ?? null,
    upstreamModel: m.upstream_model,
    name: m.name,
    description: m.description,
    enabled: !!m.enabled,
    contextLength: m.context_length,
    maxOutputLength: m.max_output_length,
    inputModalities: jsonArr(m.input_modalities),
    outputModalities: jsonArr(m.output_modalities),
    samplingParams: jsonArr(m.sampling_params),
    features: jsonArr(m.features),
    reasoningEfforts: m.reasoning_efforts ? jsonArr(m.reasoning_efforts) : null,
    pricing: modelPricing(m),
    pricingInput: m.pricing_input ?? null,
    pricingInputCache: m.pricing_input_cache ?? null,
    pricingInputCacheWrite: m.pricing_input_cache_write ?? null,
    pricingOutput: m.pricing_output ?? null,
    source: m.source,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
    // Ordered failover chain (first entry mirrors providerId/upstreamModel).
    targets: targets ?? [],
  };
}

/** Dashboard view of one routing target. */
export interface ModelTargetDto {
  providerId: string;
  providerName: string | null;
  upstreamModel: string;
  priority: number;
  enabled: boolean;
}

export function modelTargetsFor(modelId: string): ModelTargetDto[] {
  const rows = db
    .prepare<ModelTargetRow & { provider_name: string | null }, [string]>(
      `SELECT t.*, p.name AS provider_name FROM model_targets t
       JOIN providers p ON p.id = t.provider_id
       WHERE t.model_id = ? ORDER BY t.priority ASC`,
    )
    .all(modelId);
  return rows.map((t) => ({
    providerId: t.provider_id,
    providerName: t.provider_name,
    upstreamModel: t.upstream_model,
    priority: t.priority,
    enabled: !!t.enabled,
  }));
}

/** Recompute the denormalized top-1 mirror on `models` after any target
 *  mutation (provider_id/upstream_model = lowest-priority target; NULL when
 *  none remains — the model is then "orphaned", same as a pre-failover
 *  provider deletion). */
export function refreshModelMirror(modelId: string): void {
  const top = db
    .prepare<ModelTargetRow, [string]>(
      "SELECT * FROM model_targets WHERE model_id = ? ORDER BY priority ASC LIMIT 1",
    )
    .get(modelId);
  if (top) {
    db.prepare("UPDATE models SET provider_id = ?, upstream_model = ? WHERE id = ?").run(
      top.provider_id,
      top.upstream_model,
      modelId,
    );
  } else {
    db.prepare("UPDATE models SET provider_id = NULL WHERE id = ?").run(modelId);
  }
}

/** Keep `providers.api_key_enc` mirroring the top-priority key row (NOT NULL
 *  invariant: the last key of a provider is never deleted). */
export function refreshProviderKeyMirror(providerId: string): void {
  const top = db
    .prepare<ProviderKeyRow, [string]>(
      "SELECT api_key_enc FROM provider_keys WHERE provider_id = ? ORDER BY priority ASC LIMIT 1",
    )
    .get(providerId);
  if (top) {
    db.prepare("UPDATE providers SET api_key_enc = ? WHERE id = ?").run(top.api_key_enc, providerId);
  }
}

/** Top-priority usable key for admin-side operations (sync/test). Falls back
 *  to the top key regardless of state — a best-effort call never fails just
 *  because every key is cooling down. */
export async function primaryAdminKey(providerId: string): Promise<string | null> {
  const rows = db
    .prepare<ProviderKeyRow, [string]>(
      "SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY priority ASC",
    )
    .all(providerId);
  if (rows.length === 0) return null;
  const usable = rows.find((k) => keyUsable(k));
  const chosen = usable ?? rows[0]!;
  try {
    return await decryptSecret(chosen.api_key_enc, GATEWAY_SECRET);
  } catch {
    return null;
  }
}

// ---------- router snapshot (proxy hot path) ----------

/** One decrypted upstream key, ordered within its provider. */
export interface RoutedKey {
  id: string;
  key: string;
  label: string;
  priority: number;
  status: ProviderKeyRow["status"];
  cooldownUntil: number | null;
  exhaustedReason: string | null;
}

export interface RoutedProvider {
  row: ProviderRow;
  /** Decrypted keys, priority ASC (may include blocked ones — the proxy's
   *  candidate builder filters). */
  keys: RoutedKey[];
}

export interface RouterSnapshot {
  mode: RoutingMode;
  /** ALL model rows (any enabled state) — the proxy distinguishes
   *  404-unknown vs 404-disabled vs 503-orphaned from this map. */
  models: Map<string, ModelRow>;
  /** Ordered fallback chain per model id (any enabled state). */
  targets: Map<string, ModelTargetRow[]>;
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
    const targets = new Map<string, ModelTargetRow[]>();
    for (const t of db
      .query<ModelTargetRow, []>("SELECT * FROM model_targets ORDER BY priority ASC")
      .all()) {
      const list = targets.get(t.model_id);
      if (list) list.push(t);
      else targets.set(t.model_id, [t]);
    }
    const providers = new Map<string, RoutedProvider>();
    for (const row of db
      .query<ProviderRow, []>("SELECT * FROM providers WHERE enabled = 1 ORDER BY priority, created_at")
      .all()) {
      try {
        const keys: RoutedKey[] = [];
        for (const k of db
          .query<ProviderKeyRow, [string]>(
            "SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY priority ASC",
          )
          .all(row.id)) {
          keys.push({
            id: k.id,
            key: await decryptSecret(k.api_key_enc, GATEWAY_SECRET),
            label: k.label,
            priority: k.priority,
            status: k.status,
            cooldownUntil: k.cooldown_until,
            exhaustedReason: k.exhausted_reason,
          });
        }
        if (keys.length > 0) providers.set(row.id, { row, keys });
        // A provider whose key material is all corrupt/models entry that
        // can't decrypt: left out — its models 503 instead of taking the
        // whole proxy down.
      } catch {}
    }
    const snap: RouterSnapshot = { mode, models, targets, providers };
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

/** One attempt of the failover chain: a concrete provider key plus the
 *  upstream model id to send (null in passthrough mode — body untouched).
 *  `translated` marks an Anthropic-protocol request served by an
 *  OpenAI-only provider through the Anthropic→OpenAI bridge. */
export interface RouteCandidate {
  provider: RoutedProvider;
  key: RoutedKey;
  upstreamModel: string;
  translated: boolean;
}

/** Capability match for a candidate, including bridge translation: an
 *  Anthropic request may use an OpenAI-only provider (translated); the
 *  reverse is never translated. */
function candidateUsable(provider: RoutedProvider, proto: "openai" | "anthropic"): "direct" | "translated" | null {
  if (providerHasCapability(provider.row, proto)) return "direct";
  if (proto === "anthropic" && provider.row.openai_base_url) return "translated";
  return null;
}

/** Resolve a requested public model id against the registry (router mode). */
export type ModelResolution =
  | { ok: true; requested: string; candidates: RouteCandidate[] }
  | { ok: false; status: 404 | 503; code: string; message: string };

/** Keys of a provider currently worth trying, priority order. */
export function usableKeys(provider: RoutedProvider, now = Date.now()): RoutedKey[] {
  return provider.keys.filter((k) =>
    keyUsable(
      {
        status: k.status,
        cooldown_until: k.cooldownUntil,
        exhausted_reason: k.exhaustedReason,
      },
      now,
    ),
  );
}

export function resolveModelRoute(
  snap: RouterSnapshot,
  proto: "openai" | "anthropic",
  model: string,
): ModelResolution {
  const m = snap.models.get(model);
  if (!m) {
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
  const modelTargetRows = snap.targets.get(model) ?? [];
  const enabledTargets = modelTargetRows.filter((t) => t.enabled);
  if (enabledTargets.length === 0) {
    return {
      ok: false,
      status: 503,
      code: "model_unavailable",
      message: `model '${model}' has no provider configured`,
    };
  }
  const candidates: RouteCandidate[] = [];
  for (const t of enabledTargets) {
    const provider = snap.providers.get(t.provider_id);
    if (!provider) continue;
    const usable = candidateUsable(provider, proto);
    if (!usable) continue;
    for (const key of usableKeys(provider)) {
      candidates.push({ provider, key, upstreamModel: t.upstream_model, translated: usable === "translated" });
    }
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      status: 503,
      code: "model_unavailable",
      message: `model '${model}': every upstream candidate is unavailable right now`,
    };
  }
  return { ok: true, requested: model, candidates };
}

/** Passthrough-mode candidates: every enabled provider exposing this
 *  capability (priority order), each contributing its usable keys. */
export function passthroughCandidates(
  snap: RouterSnapshot,
  proto: "openai" | "anthropic",
): RouteCandidate[] {
  const out: RouteCandidate[] = [];
  for (const provider of snap.providers.values()) {
    const usable = candidateUsable(provider, proto);
    if (!usable) continue;
    for (const key of usableKeys(provider)) {
      out.push({ provider, key, upstreamModel: "", translated: usable === "translated" });
    }
  }
  return out;
}

/** Models visible in /v1/models for a protocol: enabled, with at least
 *  one enabled target whose provider is enabled and capable (translated
 *  for Anthropic requests to OpenAI-only providers). */
export function listableModels(snap: RouterSnapshot, proto: "openai" | "anthropic"): ModelRow[] {
  const out: ModelRow[] = [];
  for (const m of snap.models.values()) {
    if (!m.enabled) continue;
    const ts = snap.targets.get(m.id) ?? [];
    const servable = ts.some((t) => {
      if (!t.enabled) return false;
      const p = snap.providers.get(t.provider_id);
      return !!p && candidateUsable(p, proto) !== null;
    });
    if (servable) out.push(m);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
