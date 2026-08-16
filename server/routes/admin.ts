import { LIMITS, SMTP_ENABLED } from "../config";
import { db, stmts, audit, type ProviderRow, type ProviderKeyRow, type ModelTargetRow, type ApiKeyRow, type UserRow, type AuthStyle, type ModelRow, type ModelProto } from "../db";
import { encryptSecret, decryptSecret, randomToken, sha256Hex } from "../crypto";
import { requireAdmin, revokeAllUserSessions, auditAdmin } from "../auth";
import { publicKey, revokeKey } from "../keys";
import { GATEWAY_SECRET } from "../config";
import { sendInviteEmail, sendResetEmail } from "../email";
import { liveKeyClear } from "../failover";
import {
  getRoutingMode,
  setRoutingMode,
  syncProviderModels,
  previewProviderModels,
  publicModelAdmin,
  invalidateModelCache,
  modelTargetsFor,
  refreshModelMirror,
  refreshProviderKeyMirror,
  primaryAdminKey,
  type ModelTargetDto,
} from "../models";
import { ApiError, clientIp, err, ok, readJsonBody, v } from "../http";
import { hourlySeries, utcDate } from "../usage";

/**
 * /api/admin/* — everything requires role=admin. Every mutation is audited.
 */

function publicProvider(p: ProviderRow, modelCount?: number, keys?: ProviderKeyRow[]) {
  return {
    id: p.id,
    name: p.name,
    openaiBaseUrl: p.openai_base_url,
    openaiAuthStyle: p.openai_auth_style,
    anthropicBaseUrl: p.anthropic_base_url,
    anthropicAuthStyle: p.anthropic_auth_style,
    enabled: !!p.enabled,
    priority: p.priority,
    createdAt: p.created_at,
    hasApiKey: !!p.api_key_enc,
    modelCount: modelCount ?? providerModelCount(p.id),
    // Upstream keys in failover order — NEVER including the key material.
    keys: (keys ?? providerKeysFor(p.id)).map(publicProviderKey),
  };
}

function providerKeysFor(providerId: string): ProviderKeyRow[] {
  return db
    .prepare<ProviderKeyRow, [string]>(
      "SELECT * FROM provider_keys WHERE provider_id = ? ORDER BY priority ASC, created_at ASC",
    )
    .all(providerId);
}

function publicProviderKey(k: ProviderKeyRow) {
  return {
    id: k.id,
    label: k.label,
    priority: k.priority,
    status: k.status,
    failCount: k.fail_count,
    cooldownUntil: k.cooldown_until,
    exhaustedReason: k.exhausted_reason,
    createdAt: k.created_at,
  };
}

/** Insert a new upstream key at the end of a provider's failover chain. */
async function addProviderKey(providerId: string, apiKey: string, label: string, status: "active" | "disabled" = "active") {
  const id = randomToken(12);
  const enc = await encryptSecret(apiKey, GATEWAY_SECRET);
  const maxP = db
    .prepare<{ p: number | null }, [string]>("SELECT MAX(priority) AS p FROM provider_keys WHERE provider_id = ?")
    .get(providerId)!.p;
  const now = Date.now();
  db.prepare(
    `INSERT INTO provider_keys (id, provider_id, label, api_key_enc, priority, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, providerId, label, enc, (maxP ?? -10) + 10, status, now, now);
  refreshProviderKeyMirror(providerId);
  return db.prepare<ProviderKeyRow, [string]>("SELECT * FROM provider_keys WHERE id = ?").get(id)!;
}

/** Legacy single-key write: route an incoming `apiKey` to the provider's
 *  TOP-1 key row (create when missing), keeping the mirror invariant. */
async function rotatePrimaryKey(providerId: string, apiKeyEnc: string): Promise<void> {
  const top = providerKeysFor(providerId)[0];
  if (top) {
    // A new secret is a fresh credential: clear any failure state with it.
    db.prepare(
      `UPDATE provider_keys SET api_key_enc = ?, status = 'active', fail_count = 0,
         cooldown_until = NULL, exhausted_reason = NULL, updated_at = ? WHERE id = ?`,
    ).run(apiKeyEnc, Date.now(), top.id);
    liveKeyClear(top.id);
  } else {
    const now = Date.now();
    db.prepare(
      `INSERT INTO provider_keys (id, provider_id, label, api_key_enc, priority, status, created_at, updated_at)
       VALUES (?, ?, 'primary', ?, 0, 'active', ?, ?)`,
    ).run(randomToken(12), providerId, apiKeyEnc, now, now);
  }
  refreshProviderKeyMirror(providerId);
}

function providerModelCount(providerId: string): number {
  return db
    .prepare<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM models WHERE provider_id = ?")
    .get(providerId)!.n;
}

function validBaseUrl(raw: string | null, field: string): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ApiError(400, `${field} is not a valid URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ApiError(400, `${field} must be http(s)`);
  }
  return u.toString().replace(/\/+$/, "");
}

function authStyleField(body: Record<string, unknown>, field: string): AuthStyle | undefined {
  if (!(field in body)) return undefined;
  const val = body[field];
  if (val !== "bearer" && val !== "x-api-key") {
    throw new ApiError(400, `${field} must be "bearer" or "x-api-key"`);
  }
  return val;
}

async function providerWrite(body: Record<string, unknown>, existing?: ProviderRow) {
  const name =
    v.str(body, "name", { min: 1, max: 64, optional: !!existing }) ?? existing?.name;
  if (!name) throw new ApiError(400, "name is required");
  const openaiBaseUrl =
    "openaiBaseUrl" in body
      ? validBaseUrl(v.str(body, "openaiBaseUrl", { max: 512, optional: true }), "openaiBaseUrl")
      : (existing?.openai_base_url ?? null);
  const anthropicBaseUrl =
    "anthropicBaseUrl" in body
      ? validBaseUrl(v.str(body, "anthropicBaseUrl", { max: 512, optional: true }), "anthropicBaseUrl")
      : (existing?.anthropic_base_url ?? null);
  const openaiAuthStyle =
    authStyleField(body, "openaiAuthStyle") ?? existing?.openai_auth_style ?? "bearer";
  const anthropicAuthStyle =
    authStyleField(body, "anthropicAuthStyle") ?? existing?.anthropic_auth_style ?? "x-api-key";
  const enabled = "enabled" in body ? !!body.enabled : existing ? !!existing.enabled : true;
  const priority =
    v.int(body, "priority", { min: 0, max: 10_000, optional: true }) ?? existing?.priority ?? 100;

  if (!openaiBaseUrl && !anthropicBaseUrl) {
    throw new ApiError(400, "configure at least one base URL (openaiBaseUrl or anthropicBaseUrl)");
  }

  // apiKey: required on create; on update, only replaced when a non-empty value is sent.
  let apiKeyEnc = existing?.api_key_enc;
  const apiKey = v.str(body, "apiKey", { max: 512, optional: true });
  if (apiKey) apiKeyEnc = await encryptSecret(apiKey, GATEWAY_SECRET);
  if (!apiKeyEnc) throw new ApiError(400, "apiKey is required");

  return { name, openaiBaseUrl, anthropicBaseUrl, openaiAuthStyle, anthropicAuthStyle, enabled, priority, apiKeyEnc };
}

/** Validated model-registry column values for create/update. Absent PATCH
 *  fields keep the existing value; nullable fields accept explicit null. */
function modelFields(body: Record<string, unknown>, existing?: ModelRow) {
  const strOpt = (key: string, max: number): string | undefined => {
    if (!(key in body)) return undefined;
    const val = body[key];
    if (typeof val !== "string") throw new ApiError(400, `${key} must be a string`);
    if (val.length > max) throw new ApiError(400, `${key} is too long (max ${max})`);
    return val;
  };
  const arrOpt = (key: string): string[] | undefined => {
    if (!(key in body)) return undefined;
    const val = body[key];
    if (
      !Array.isArray(val) ||
      val.length > 24 ||
      val.some((x) => typeof x !== "string" || x.length === 0 || x.length > 64)
    ) {
      throw new ApiError(400, `${key} must be an array of up to 24 strings (≤64 chars each)`);
    }
    return val as string[];
  };
  const intOpt = (key: string, max: number): number | null | undefined => {
    if (!(key in body)) return undefined;
    const val = body[key];
    if (val === null) return null;
    if (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > max) {
      throw new ApiError(400, `${key} must be an integer between 0 and ${max}`);
    }
    return val;
  };
  const pricingOpt = (): string | null | undefined => {
    if (!("pricing" in body)) return undefined;
    const val = body.pricing;
    if (val === null) return null;
    if (typeof val !== "object" || Array.isArray(val)) {
      throw new ApiError(400, "pricing must be an object of string values");
    }
    const out: Record<string, string> = {};
    for (const [k, p] of Object.entries(val as Record<string, unknown>)) {
      if (Object.keys(out).length >= 16) break;
      if (k.length > 48) throw new ApiError(400, "pricing keys are too long");
      if (typeof p === "string" && p.length <= 32) out[k] = p;
      else if (typeof p === "number" && Number.isFinite(p)) out[k] = String(p);
      else throw new ApiError(400, `pricing.${k} must be a string or number`);
    }
    return JSON.stringify(out);
  };
  const datacentersOpt = (): string | null | undefined => {
    if (!("datacenters" in body)) return undefined;
    const val = body.datacenters;
    if (val === null) return null;
    if (!Array.isArray(val) || val.length > 24) {
      throw new ApiError(400, "datacenters must be an array of {country_code}");
    }
    for (const d of val) {
      const cc = (d as Record<string, unknown> | null)?.country_code;
      if (typeof cc !== "string" || !/^[A-Za-z0-9-]{1,8}$/.test(cc)) {
        throw new ApiError(400, "each datacenter needs a short country_code");
      }
    }
    return JSON.stringify(val.map((d) => ({ country_code: (d as any).country_code })));
  };
  const boolOpt = (key: string): number | undefined => {
    if (!(key in body)) return undefined;
    return body[key] ? 1 : 0;
  };
  const protoOpt = (): ModelProto | undefined => {
    if (!("proto" in body)) return undefined;
    if (body.proto !== "openai" && body.proto !== "anthropic" && body.proto !== "both") {
      throw new ApiError(400, 'proto must be "openai", "anthropic" or "both"');
    }
    return body.proto;
  };
  const jsonOr = (arr: string[] | undefined, prev: string): string =>
    arr === undefined ? prev : JSON.stringify(arr);

  // Nullable fields: undefined = keep, null = clear (must NOT use ?? chains,
  // which would turn an explicit clear into "keep").
  const cl = intOpt("contextLength", 1e10);
  const mol = intOpt("maxOutputLength", 1e10);
  const created = intOpt("created", 4_102_444_800);
  const pricing = pricingOpt();
  const datacenters = datacentersOpt();
  const efforts = arrOpt("reasoningEfforts");

  return {
    proto: protoOpt() ?? existing?.proto,
    upstream_model: strOpt("upstreamModel", 256) ?? existing?.upstream_model,
    name: strOpt("name", 256) ?? existing?.name ?? "",
    description: strOpt("description", 2000) ?? existing?.description ?? "",
    hugging_face_id: strOpt("huggingFaceId", 256) ?? existing?.hugging_face_id ?? "",
    quantization: strOpt("quantization", 64) ?? existing?.quantization ?? "",
    openrouter_slug: strOpt("openrouterSlug", 256) ?? existing?.openrouter_slug ?? "",
    always_on: boolOpt("alwaysOn") ?? existing?.always_on ?? 1,
    enabled: boolOpt("enabled") ?? existing?.enabled ?? 1,
    context_length: cl === undefined ? (existing?.context_length ?? null) : cl,
    max_output_length: mol === undefined ? (existing?.max_output_length ?? null) : mol,
    created: created === undefined ? (existing?.created ?? null) : created,
    input_modalities: jsonOr(arrOpt("inputModalities"), existing?.input_modalities ?? '["text"]'),
    output_modalities: jsonOr(arrOpt("outputModalities"), existing?.output_modalities ?? '["text"]'),
    sampling_params: jsonOr(arrOpt("samplingParams"), existing?.sampling_params ?? "[]"),
    features: jsonOr(arrOpt("features"), existing?.features ?? "[]"),
    reasoning_efforts:
      efforts === undefined
        ? (existing?.reasoning_efforts ?? null)
        : efforts.length
          ? JSON.stringify(efforts)
          : null,
    pricing: pricing === undefined ? (existing?.pricing ?? null) : pricing,
    datacenters: datacenters === undefined ? (existing?.datacenters ?? null) : datacenters,
  };
}

// ---------- model failover targets ----------

interface TargetInput {
  providerId: string;
  upstreamModel: string;
  enabled: boolean;
}

const MAX_MODEL_TARGETS = 8;

/** Validate a `targets` array (ordered failover chain) for a model. */
export function validateTargets(raw: unknown, modelId: string): TargetInput[] {
  if (!Array.isArray(raw)) throw new ApiError(400, "targets must be an array");
  if (raw.length < 1 || raw.length > MAX_MODEL_TARGETS) {
    throw new ApiError(400, `targets must have between 1 and ${MAX_MODEL_TARGETS} entries`);
  }
  const seen = new Set<string>();
  const exists = db.prepare<{ id: string }, [string]>("SELECT id FROM providers WHERE id = ?");
  return raw.map((t, i) => {
    if (!t || typeof t !== "object" || Array.isArray(t)) {
      throw new ApiError(400, `targets[${i}] must be an object`);
    }
    const o = t as Record<string, unknown>;
    const providerId = o.providerId;
    if (typeof providerId !== "string" || providerId.length > 64) {
      throw new ApiError(400, `targets[${i}].providerId must be a provider id string`);
    }
    if (!exists.get(providerId)) {
      throw new ApiError(400, `targets[${i}].providerId does not match any provider`);
    }
    if (seen.has(providerId)) {
      throw new ApiError(400, "the same provider cannot appear twice in a model's chain");
    }
    seen.add(providerId);
    let upstreamModel = modelId;
    if (o.upstreamModel !== undefined && o.upstreamModel !== null && o.upstreamModel !== "") {
      if (typeof o.upstreamModel !== "string" || o.upstreamModel.length > 256 || /\s/.test(o.upstreamModel)) {
        throw new ApiError(400, `targets[${i}].upstreamModel is invalid (max 256 chars, no spaces)`);
      }
      upstreamModel = o.upstreamModel;
    }
    return { providerId, upstreamModel, enabled: o.enabled !== false };
  });
}

/** Replace a model's whole failover chain (order = priority) + mirror. */
function replaceModelTargets(modelId: string, targets: TargetInput[]): void {
  db.transaction(() => {
    db.prepare("DELETE FROM model_targets WHERE model_id = ?").run(modelId);
    const ins = db.prepare(
      "INSERT INTO model_targets (model_id, provider_id, upstream_model, priority, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const now = Date.now();
    targets.forEach((t, i) => ins.run(modelId, t.providerId, t.upstreamModel, i * 10, t.enabled ? 1 : 0, now));
    refreshModelMirror(modelId);
  })();
  invalidateModelCache();
}

/** Legacy single-link edit (PATCH providerId/upstreamModel): sync the TOP-1
 *  target; `providerId === null` drops the top of the chain. */
function upsertPrimaryTarget(modelId: string, providerId: string | null, upstreamModel: string): void {
  const qFirst = db.prepare<ModelTargetRow, [string]>(
    "SELECT * FROM model_targets WHERE model_id = ? ORDER BY priority ASC LIMIT 1",
  );
  const first = qFirst.get(modelId);
  // One provider may only appear once per model (chain PRIMARY KEY).
  db.prepare("DELETE FROM model_targets WHERE model_id = ? AND provider_id = ?").run(
    modelId,
    providerId ?? "__none__",
  );
  if (providerId === null) {
    if (first) {
      db.prepare("DELETE FROM model_targets WHERE model_id = ? AND provider_id = ?").run(modelId, first.provider_id);
    }
  } else if (first) {
    db.prepare("DELETE FROM model_targets WHERE model_id = ? AND provider_id = ?").run(modelId, first.provider_id);
    db.prepare(
      "INSERT INTO model_targets (model_id, provider_id, upstream_model, priority, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)",
    ).run(modelId, providerId, upstreamModel, first.priority, first.created_at);
  } else {
    db.prepare(
      "INSERT INTO model_targets (model_id, provider_id, upstream_model, priority, enabled, created_at) VALUES (?, ?, ?, 0, 1, ?)",
    ).run(modelId, providerId, upstreamModel, Date.now());
  }
  refreshModelMirror(modelId);
}

export async function handleAdminRoute(path: string, req: Request, url: URL): Promise<Response | null> {
  const ctx = await requireAdmin(req); // every admin route is gated
  const ip = clientIp(req);

  // ================= providers =================

  if (path === "/api/admin/providers" && req.method === "GET") {
    const rows = db
      .prepare<ProviderRow, []>("SELECT * FROM providers ORDER BY priority ASC, created_at ASC")
      .all();
    const counts = new Map(
      db
        .query<{ provider_id: string; n: number }, []>(
          "SELECT provider_id, COUNT(*) AS n FROM models GROUP BY provider_id",
        )
        .all()
        .map((r) => [r.provider_id, r.n]),
    );
    const keysByProvider = new Map<string, ProviderKeyRow[]>();
    for (const k of db
      .query<ProviderKeyRow, []>("SELECT * FROM provider_keys ORDER BY priority ASC, created_at ASC")
      .all()) {
      const list = keysByProvider.get(k.provider_id);
      if (list) list.push(k);
      else keysByProvider.set(k.provider_id, [k]);
    }
    return ok(
      { providers: rows.map((p) => publicProvider(p, counts.get(p.id) ?? 0, keysByProvider.get(p.id) ?? [])) },
      req,
    );
  }

  if (path === "/api/admin/providers" && req.method === "POST") {
    const body = await readJsonBody(req, LIMITS.apiBodyBytes);
    const data = await providerWrite(body);
    const plainApiKey = v.str(body, "apiKey", { max: 512, optional: true });
    const id = randomToken(12);
    db.prepare(
      `INSERT INTO providers (id, name, openai_base_url, anthropic_base_url, openai_auth_style, anthropic_auth_style, api_key_enc, enabled, priority, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      data.name,
      data.openaiBaseUrl,
      data.anthropicBaseUrl,
      data.openaiAuthStyle,
      data.anthropicAuthStyle,
      data.apiKeyEnc!,
      data.enabled ? 1 : 0,
      data.priority,
      Date.now(),
    );
    // The submitted key becomes the provider's primary upstream key.
    db.prepare(
      `INSERT INTO provider_keys (id, provider_id, label, api_key_enc, priority, status, created_at, updated_at)
       VALUES (?, ?, 'primary', ?, 0, 'active', ?, ?)`,
    ).run(randomToken(12), id, data.apiKeyEnc!, Date.now(), Date.now());
    invalidateModelCache();
    const row = db.prepare<ProviderRow, [string]>("SELECT * FROM providers WHERE id = ?").get(id)!;
    // Dual-capability provider: don't import yet — preview both /models lists
    // and let the dashboard ask how to import (sync-models with mode
    // "both"|"separate"). Single-capability: auto-import right away.
    const dual = !!row.openai_base_url && !!row.anthropic_base_url;
    if (plainApiKey && dual) {
      const preview = await previewProviderModels(row, plainApiKey);
      auditAdmin(ctx.user, "provider.created", id, { name: data.name, import: "pending-choice" }, ip);
      return ok({ provider: publicProvider(row), preview }, req);
    }
    // Model registry auto-import: best-effort — a failing /models endpoint
    // yields per-capability errors in `sync` but never blocks creation.
    const sync = plainApiKey ? await syncProviderModels(row, plainApiKey) : {};
    auditAdmin(ctx.user, "provider.created", id, { name: data.name, sync }, ip);
    return ok({ provider: publicProvider(row), sync }, req);
  }

  // Failover order of providers themselves (used by passthrough mode and as
  // display order): the submitted id list IS the new order.
  if (path === "/api/admin/providers/reorder" && req.method === "POST") {
    const body = await readJsonBody(req, LIMITS.apiBodyBytes);
    const ids = body.ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > 500 ||
      ids.some((x) => typeof x !== "string" || !/^[a-f0-9]{24}$/.test(x))
    ) {
      throw new ApiError(400, "ids must be an array of provider ids");
    }
    const existing = db.prepare<{ id: string }, []>("SELECT id FROM providers").all();
    if (ids.length !== existing.length || existing.some((p) => !ids.includes(p.id))) {
      throw new ApiError(400, "ids must list every provider exactly once");
    }
    db.transaction(() => {
      const upd = db.prepare("UPDATE providers SET priority = ? WHERE id = ?");
      (ids as string[]).forEach((pid, i) => upd.run(i * 10, pid));
    })();
    invalidateModelCache();
    auditAdmin(ctx.user, "providers.reordered", undefined, { count: ids.length }, ip);
    const rows = db
      .prepare<ProviderRow, []>("SELECT * FROM providers ORDER BY priority ASC, created_at ASC")
      .all();
    return ok({ providers: rows.map((p) => publicProvider(p)) }, req);
  }

  const providerMatch = path.match(/^\/api\/admin\/providers\/([a-f0-9]{24})(\/test|\/sync-models|\/keys|\/keys\/reorder|\/keys\/([a-f0-9]{24}))?$/);
  if (providerMatch) {
    const providerId = providerMatch[1]!;
    const action = providerMatch[2] ?? "";
    const keyId = providerMatch[3];
    const isTest = action === "/test";
    const isSync = action === "/sync-models";
    const existing = db
      .prepare<ProviderRow, [string]>("SELECT * FROM providers WHERE id = ?")
      .get(providerId);
    if (!existing) return err(404, "provider not found", req);

    // ---------- upstream keys (failover chain) ----------

    if (req.method === "POST" && action === "/keys") {
      const body = await readJsonBody(req, LIMITS.apiBodyBytes);
      const apiKey = v.str(body, "apiKey", { min: 1, max: 512 })!;
      const label = v.str(body, "label", { max: 64, optional: true }) ?? "";
      const row = await addProviderKey(providerId, apiKey, label.trim());
      invalidateModelCache();
      auditAdmin(ctx.user, "provider_key.created", row.id, { provider: providerId, label: row.label }, ip);
      return ok({ key: publicProviderKey(row) }, req);
    }

    if (req.method === "POST" && action === "/keys/reorder") {
      const body = await readJsonBody(req, LIMITS.apiBodyBytes);
      const ids = body.ids;
      const current = providerKeysFor(providerId);
      if (
        !Array.isArray(ids) ||
        ids.length !== current.length ||
        current.some((k) => !ids.includes(k.id)) ||
        ids.some((x) => typeof x !== "string")
      ) {
        throw new ApiError(400, "ids must list every key of this provider exactly once");
      }
      db.transaction(() => {
        const upd = db.prepare("UPDATE provider_keys SET priority = ?, updated_at = ? WHERE id = ?");
        (ids as string[]).forEach((kid, i) => upd.run(i * 10, Date.now(), kid));
      })();
      // A new key became top-1: the mirror follows.
      refreshProviderKeyMirror(providerId);
      invalidateModelCache();
      auditAdmin(ctx.user, "provider_keys.reordered", providerId, { count: ids.length }, ip);
      return ok({ keys: providerKeysFor(providerId).map(publicProviderKey) }, req);
    }

    if (keyId) {
      const keyRow = db
        .prepare<ProviderKeyRow, [string, string]>(
          "SELECT * FROM provider_keys WHERE id = ? AND provider_id = ?",
        )
        .get(keyId, providerId);
      if (!keyRow) return err(404, "key not found", req);

      if (req.method === "PATCH") {
        const body = await readJsonBody(req, LIMITS.apiBodyBytes);
        let { label, status, api_key_enc } = keyRow;
        let failCount = keyRow.fail_count;
        let cooldownUntil = keyRow.cooldown_until;
        let exhaustedReason = keyRow.exhausted_reason;
        if ("label" in body) {
          label = v.str(body, "label", { max: 64, optional: true }) ?? "";
        }
        if ("apiKey" in body) {
          // New secret = fresh credential: wipe billing/auth/transient state.
          const apiKey = v.str(body, "apiKey", { min: 1, max: 512 })!;
          api_key_enc = await encryptSecret(apiKey, GATEWAY_SECRET);
          status = "active";
          failCount = 0;
          cooldownUntil = null;
          exhaustedReason = null;
        }
        if ("status" in body) {
          if (body.status !== "active" && body.status !== "disabled") {
            throw new ApiError(400, 'status must be "active" or "disabled"');
          }
          status = body.status;
          if (status === "active") {
            failCount = 0;
            cooldownUntil = null;
            exhaustedReason = null;
          }
        }
        db.prepare(
          `UPDATE provider_keys SET label = ?, api_key_enc = ?, status = ?, fail_count = ?,
             cooldown_until = ?, exhausted_reason = ?, updated_at = ? WHERE id = ?`,
        ).run(label, api_key_enc, status, failCount, cooldownUntil, exhaustedReason, Date.now(), keyId);
        refreshProviderKeyMirror(providerId);
        liveKeyClear(keyId);
        invalidateModelCache();
        auditAdmin(
          ctx.user,
          status !== keyRow.status && status === "active" ? "provider_key.reenabled" : "provider_key.updated",
          keyId,
          { provider: providerId, status },
          ip,
        );
        const row = db.prepare<ProviderKeyRow, [string]>("SELECT * FROM provider_keys WHERE id = ?").get(keyId)!;
        return ok({ key: publicProviderKey(row) }, req);
      }

      if (req.method === "DELETE") {
        // providers.api_key_enc is NOT NULL — the failover chain must never
        // become empty. Deleting the last key would orphan the provider.
        const n = db
          .prepare<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM provider_keys WHERE provider_id = ?")
          .get(providerId)!.n;
        if (n <= 1) throw new ApiError(400, "a provider needs at least one upstream key");
        db.prepare("DELETE FROM provider_keys WHERE id = ?").run(keyId);
        refreshProviderKeyMirror(providerId);
        liveKeyClear(keyId);
        invalidateModelCache();
        auditAdmin(ctx.user, "provider_key.deleted", keyId, { provider: providerId, label: keyRow.label }, ip);
        return ok({ deleted: true }, req);
      }
    }

    if (req.method === "PATCH" && !action) {
      const body = await readJsonBody(req, LIMITS.apiBodyBytes);
      const data = await providerWrite(body, existing);
      const priKeyRotated = !!v.str(body, "apiKey", { max: 512, optional: true });
      db.prepare(
        `UPDATE providers SET name = ?, openai_base_url = ?, anthropic_base_url = ?, openai_auth_style = ?, anthropic_auth_style = ?, api_key_enc = ?, enabled = ?, priority = ?
         WHERE id = ?`,
      ).run(
        data.name,
        data.openaiBaseUrl,
        data.anthropicBaseUrl,
        data.openaiAuthStyle,
        data.anthropicAuthStyle,
        data.apiKeyEnc!,
        data.enabled ? 1 : 0,
        data.priority,
        providerId,
      );
      // A submitted apiKey rotates the TOP-1 upstream key (legacy single-key
      // semantics) and refreshes its failure state.
      if (priKeyRotated) await rotatePrimaryKey(providerId, data.apiKeyEnc!);
      invalidateModelCache();
      auditAdmin(ctx.user, "provider.updated", providerId, { name: data.name }, ip);
      const row = db.prepare<ProviderRow, [string]>("SELECT * FROM providers WHERE id = ?").get(providerId)!;
      return ok({ provider: publicProvider(row) }, req);
    }

    if (req.method === "DELETE" && !action) {
      // Default: models keep their rows; targets pointing at this provider
      // cascade away, so models with no remaining targets become orphaned
      // (badge "no provider") and can be re-linked from the Models tab.
      // ?deleteModels=true opts into cascading deletion.
      const deleteModels = url.searchParams.get("deleteModels") === "true";
      const n = providerModelCount(providerId);
      const affected = db
        .prepare<{ model_id: string }, [string]>(
          "SELECT DISTINCT model_id FROM model_targets WHERE provider_id = ?",
        )
        .all(providerId)
        .map((r) => r.model_id);
      db.transaction(() => {
        if (deleteModels) db.prepare("DELETE FROM models WHERE provider_id = ?").run(providerId);
        db.prepare("DELETE FROM providers WHERE id = ?").run(providerId);
        for (const mid of affected) refreshModelMirror(mid);
      })();
      invalidateModelCache();
      auditAdmin(
        ctx.user,
        "provider.deleted",
        providerId,
        { name: existing.name, models: deleteModels ? { deleted: n } : { orphaned: n } },
        ip,
      );
      return ok(
        { deleted: true, modelsDeleted: deleteModels ? n : 0, modelsOrphaned: deleteModels ? 0 : n },
        req,
      );
    }

    if (req.method === "POST" && isSync) {
      // Re-run the registry import on demand (models added upstream since the
      // provider was created). Duplicates are skipped; admin edits survive.
      // Optional body { mode: "both" | "separate" } (default "both") — see
      // syncProviderModels.
      let body: Record<string, unknown> = {};
      if ((req.headers.get("content-type") ?? "").includes("application/json")) {
        body = await readJsonBody(req, LIMITS.apiBodyBytes);
      }
      const mode = v.str(body, "mode", { max: 16, optional: true });
      if (mode && mode !== "both" && mode !== "separate") {
        return err(400, 'mode must be "both" or "separate"', req);
      }
      const key = await primaryAdminKey(providerId);
      if (!key) return err(400, "provider has no upstream key", req);
      const sync = await syncProviderModels(existing, key, (mode ?? "both") as "both" | "separate");
      auditAdmin(ctx.user, "provider.models_synced", providerId, { mode: mode ?? "both", sync }, ip);
      return ok({ sync }, req);
    }

    if (req.method === "POST" && isTest) {
      // Smoke-test the upstream with a real key (never echoing it back).
      // Optional JSON body { cap?, model?, keyId? } — keyId tests one
      // specific key of the failover chain instead of the top usable one.
      let body: Record<string, unknown> = {};
      if ((req.headers.get("content-type") ?? "").includes("application/json")) {
        body = await readJsonBody(req, LIMITS.apiBodyBytes);
      }
      const model = v.str(body, "model", { max: 256, optional: true });
      const capReq = v.str(body, "cap", { max: 16, optional: true });
      if (capReq && capReq !== "openai" && capReq !== "anthropic") {
        return err(400, 'cap must be "openai" or "anthropic"', req);
      }

      let key: string | null;
      const keyIdReq = v.str(body, "keyId", { max: 64, optional: true });
      if (keyIdReq) {
        const kr = db
          .prepare<ProviderKeyRow, [string, string]>(
            "SELECT * FROM provider_keys WHERE id = ? AND provider_id = ?",
          )
          .get(keyIdReq, providerId);
        if (!kr) return err(404, "key not found", req);
        try {
          key = await decryptSecret(kr.api_key_enc, GATEWAY_SECRET);
        } catch {
          return err(500, "key material is unreadable", req);
        }
      } else {
        key = await primaryAdminKey(providerId);
      }
      if (!key) return err(400, "provider has no usable upstream key", req);
      const headersFor = (cap: "openai" | "anthropic"): Record<string, string> => {
        const style = cap === "openai" ? existing.openai_auth_style : existing.anthropic_auth_style;
        const h: Record<string, string> =
          style === "x-api-key" ? { "x-api-key": key } : { Authorization: `Bearer ${key}` };
        if (cap === "anthropic") h["anthropic-version"] = "2023-06-01";
        h["Content-Type"] = "application/json";
        return h;
      };

      const results: Record<string, unknown> = {};

      if (model) {
        const cap = (capReq ?? (existing.openai_base_url ? "openai" : "anthropic")) as
          | "openai"
          | "anthropic";
        const base = cap === "openai" ? existing.openai_base_url : existing.anthropic_base_url;
        if (!base) return err(400, `provider has no ${cap} base URL configured`, req);
        const started = performance.now();
        try {
          const res = await fetch(`${base}${cap === "openai" ? "/chat/completions" : "/messages"}`, {
            method: "POST",
            signal: AbortSignal.timeout(20_000),
            headers: headersFor(cap),
            body: JSON.stringify({
              model,
              max_tokens: 16,
              messages: [{ role: "user", content: "Say hello in one short sentence." }],
            }),
          });
          const text = await res.text();
          let reply: string | undefined;
          try {
            const j = JSON.parse(text);
            reply = (
              cap === "openai" ? j?.choices?.[0]?.message?.content : j?.content?.[0]?.text
            )?.slice(0, 240);
          } catch {}
          results[cap] = {
            reachable: true,
            status: res.status,
            latencyMs: Math.round(performance.now() - started),
            model,
            ...(reply ? { reply } : {}),
            ...(res.status >= 400 ? { upstreamError: text.slice(0, 300) } : {}),
          };
        } catch (e) {
          results[cap] = { reachable: false, model, error: (e as Error).message.slice(0, 160) };
        }
      } else {
        for (const cap of ["openai", "anthropic"] as const) {
          const base = cap === "openai" ? existing.openai_base_url : existing.anthropic_base_url;
          if (!base) continue;
          const started = performance.now();
          try {
            const res = await fetch(`${base}/models`, {
              signal: AbortSignal.timeout(8_000),
              headers: headersFor(cap),
            });
            const text = await res.text();
            let models: string[] = [];
            try {
              const j = JSON.parse(text);
              if (Array.isArray(j?.data)) {
                models = j.data
                  .map((m: any) => String(m?.id ?? ""))
                  .filter(Boolean)
                  .slice(0, 100);
              }
            } catch {}
            results[cap] = {
              reachable: true,
              status: res.status,
              latencyMs: Math.round(performance.now() - started),
              models,
            };
          } catch (e) {
            results[cap] = { reachable: false, error: (e as Error).message.slice(0, 160) };
          }
        }
      }
      auditAdmin(ctx.user, "provider.tested", providerId, model ? { model } : undefined, ip);
      return ok({ results }, req);
    }
  }

  // ================= settings =================

  if (path === "/api/admin/settings" && req.method === "GET") {
    return ok({ settings: { routingMode: getRoutingMode() } }, req);
  }

  if (path === "/api/admin/settings" && req.method === "PATCH") {
    const body = await readJsonBody(req, LIMITS.apiBodyBytes);
    const mode = v.str(body, "routingMode", { max: 16 });
    if (mode !== "passthrough" && mode !== "router") {
      throw new ApiError(400, 'routingMode must be "passthrough" or "router"');
    }
    setRoutingMode(mode);
    invalidateModelCache();
    auditAdmin(ctx.user, "settings.updated", "routing_mode", { routingMode: mode }, ip);
    return ok({ settings: { routingMode: mode } }, req);
  }

  // ================= models (registry) =================

  if (path === "/api/admin/models" && req.method === "GET") {
    const rows = db
      .prepare<ModelRow & { provider_name: string | null }, []>(
        `SELECT m.*, p.name AS provider_name FROM models m
         LEFT JOIN providers p ON p.id = m.provider_id
         ORDER BY m.id`,
      )
      .all();
    const byModel = new Map<string, ModelTargetDto[]>();
    for (const t of db
      .prepare<ModelTargetDto & { model_id: string }, []>(
        `SELECT t.model_id, t.provider_id AS "providerId", p.name AS "providerName",
                t.upstream_model AS "upstreamModel", t.priority, t.enabled
         FROM model_targets t JOIN providers p ON p.id = t.provider_id
         ORDER BY t.priority ASC`,
      )
      .all()) {
      const dto: ModelTargetDto = {
        providerId: t.providerId,
        providerName: t.providerName,
        upstreamModel: t.upstreamModel,
        priority: t.priority,
        enabled: !!t.enabled,
      };
      const list = byModel.get(t.model_id);
      if (list) list.push(dto);
      else byModel.set(t.model_id, [dto]);
    }
    return ok({ models: rows.map((m) => publicModelAdmin(m, byModel.get(m.id) ?? [])) }, req);
  }

  if (path === "/api/admin/models" && req.method === "POST") {
    const body = await readJsonBody(req, LIMITS.apiBodyBytes);
    const id = v.str(body, "id", { min: 1, max: 256 })!;
    if (/\s|[\x00-\x1f]/.test(id)) {
      throw new ApiError(400, "id must not contain whitespace or control characters");
    }
    if (db.prepare<{ id: string }, [string]>("SELECT id FROM models WHERE id = ?").get(id)) {
      throw new ApiError(409, "a model with this id is already registered");
    }
    // Either a single providerId (legacy) or an ordered targets chain.
    const targets = "targets" in body ? validateTargets(body.targets, id) : null;
    let providerId = targets?.[0]?.providerId ?? v.str(body, "providerId", { min: 1, max: 64 })!;
    const provider = db
      .prepare<ProviderRow, [string]>("SELECT * FROM providers WHERE id = ?")
      .get(providerId);
    if (!provider) throw new ApiError(400, "providerId does not match any provider");
    const f = modelFields(body);
    // Default to every capability the provider exposes (both when dual-surface).
    const proto: ModelProto =
      f.proto ??
      (provider.openai_base_url
        ? provider.anthropic_base_url
          ? "both"
          : "openai"
        : "anthropic");
    const upstreamModel =
      targets?.[0]?.upstreamModel ?? f.upstream_model ?? id;
    const now = Date.now();
    const chain = targets ?? [{ providerId, upstreamModel, enabled: f.enabled === 1 }];
    db.transaction(() => {
      db.prepare(
        `INSERT INTO models
           (id, provider_id, upstream_model, proto, name, description, hugging_face_id,
            quantization, openrouter_slug, always_on, enabled, context_length,
            max_output_length, created, input_modalities, output_modalities,
            sampling_params, features, reasoning_efforts, pricing, datacenters,
            source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)`,
      ).run(
        id, providerId, upstreamModel, proto, f.name, f.description, f.hugging_face_id,
        f.quantization, f.openrouter_slug, f.always_on, f.enabled, f.context_length,
        f.max_output_length, f.created, f.input_modalities, f.output_modalities,
        f.sampling_params, f.features, f.reasoning_efforts, f.pricing, f.datacenters,
        now, now,
      );
      const ins = db.prepare(
        "INSERT INTO model_targets (model_id, provider_id, upstream_model, priority, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      chain.forEach((t, i) => ins.run(id, t.providerId, t.upstreamModel, i * 10, t.enabled ? 1 : 0, now));
      refreshModelMirror(id);
    })();
    invalidateModelCache();
    auditAdmin(ctx.user, "model.created", id, { providerId, upstreamModel, proto, targets: chain.length }, ip);
    const row = db
      .prepare<ModelRow & { provider_name: string | null }, [string]>(
        `SELECT m.*, p.name AS provider_name FROM models m LEFT JOIN providers p ON p.id = m.provider_id WHERE m.id = ?`,
      )
      .get(id)!;
    return ok({ model: publicModelAdmin(row, modelTargetsFor(id)) }, req);
  }

  if (path === "/api/admin/models/bulk-delete" && req.method === "POST") {
    const body = await readJsonBody(req, LIMITS.apiBodyBytes);
    const ids = body.ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > 500 ||
      ids.some((x) => typeof x !== "string" || x.length === 0 || x.length > 256)
    ) {
      throw new ApiError(400, "ids must be an array of 1..500 model id strings");
    }
    const del = db.prepare("DELETE FROM models WHERE id = ?");
    const exists = db.prepare("SELECT 1 AS x FROM models WHERE id = ?");
    let deleted = 0;
    db.transaction(() => {
      // NB: bun:sqlite's .changes includes FK-cascaded model_targets rows —
      // count models by existence instead.
      for (const mid of ids as string[]) {
        if (exists.get(mid)) {
          del.run(mid);
          deleted++;
        }
      }
    })();
    invalidateModelCache();
    auditAdmin(ctx.user, "models.bulk_deleted", null, { requested: ids.length, deleted }, ip);
    return ok({ deleted }, req);
  }

  const modelTargetsMatch = path.match(/^\/api\/admin\/models\/(.+)\/targets$/);
  if (modelTargetsMatch && (req.method === "PUT" || req.method === "POST")) {
    let modelId = modelTargetsMatch[1]!;
    try {
      modelId = decodeURIComponent(modelTargetsMatch[1]!);
    } catch {
      return err(400, "malformed model id", req);
    }
    const existing = db.prepare<ModelRow, [string]>("SELECT * FROM models WHERE id = ?").get(modelId);
    if (!existing) return err(404, "model not found", req);
    const body = await readJsonBody(req, LIMITS.apiBodyBytes);
    const targets = validateTargets(body.targets, modelId);
    replaceModelTargets(modelId, targets);
    // The mirror makes the top-1 visible on the models row itself.
    db.prepare("UPDATE models SET updated_at = ? WHERE id = ?").run(Date.now(), modelId);
    auditAdmin(
      ctx.user,
      "model.targets_updated",
      modelId,
      { chain: targets.map((t) => `${t.providerId} → ${t.upstreamModel}`) },
      ip,
    );
    const row = db
      .prepare<ModelRow & { provider_name: string | null }, [string]>(
        `SELECT m.*, p.name AS provider_name FROM models m LEFT JOIN providers p ON p.id = m.provider_id WHERE m.id = ?`,
      )
      .get(modelId)!;
    return ok({ model: publicModelAdmin(row, modelTargetsFor(modelId)) }, req);
  }

  const modelMatch = path.match(/^\/api\/admin\/models\/(.+)$/);
  if (modelMatch && modelMatch[1] !== "bulk-delete") {
    let modelId = modelMatch[1]!;
    try {
      modelId = decodeURIComponent(modelMatch[1]!);
    } catch {
      return err(400, "malformed model id", req);
    }
    const existing = db
      .prepare<ModelRow, [string]>("SELECT * FROM models WHERE id = ?")
      .get(modelId);
    if (!existing) return err(404, "model not found", req);

    if (req.method === "PATCH") {
      const body = await readJsonBody(req, LIMITS.apiBodyBytes);
      const hasTargets = "targets" in body;
      if (hasTargets && ("providerId" in body || "upstreamModel" in body)) {
        throw new ApiError(400, "pass either `targets` or providerId/upstreamModel, not both");
      }
      const targets = hasTargets ? validateTargets(body.targets, modelId) : null;

      let providerId = existing.provider_id;
      if (!hasTargets && "providerId" in body) {
        const pid = body.providerId;
        if (pid === null) {
          providerId = null; // explicit unlink of the top-1 target
        } else {
          if (typeof pid !== "string") throw new ApiError(400, "providerId must be a string or null");
          const p = db
            .prepare<{ id: string }, [string]>("SELECT id FROM providers WHERE id = ?")
            .get(pid);
          if (!p) throw new ApiError(400, "providerId does not match any provider");
          providerId = pid;
        }
      }
      // Optional rename: `id` is the PRIMARY KEY, updated in place — model
      // targets follow via ON UPDATE CASCADE and usage events record the
      // model as plain text, so history keeps the old id.
      let newId: string | undefined;
      if ("id" in body) {
        const candidate = v.str(body, "id", { min: 1, max: 256 })!;
        if (/\s|[\x00-\x1f]/.test(candidate)) {
          throw new ApiError(400, "id must not contain whitespace or control characters");
        }
        if (candidate !== modelId) {
          if (db.prepare<{ id: string }, [string]>("SELECT id FROM models WHERE id = ?").get(candidate)) {
            throw new ApiError(409, "a model with this id is already registered");
          }
          newId = candidate;
        }
      }
      const f = modelFields(body, existing);
      const finalId = newId ?? modelId;
      db.transaction(() => {
        db.prepare(
          `UPDATE models SET provider_id = ?, upstream_model = ?, proto = ?, name = ?,
             description = ?, hugging_face_id = ?, quantization = ?, openrouter_slug = ?,
             always_on = ?, enabled = ?, context_length = ?, max_output_length = ?,
             created = ?, input_modalities = ?, output_modalities = ?, sampling_params = ?,
             features = ?, reasoning_efforts = ?, pricing = ?, datacenters = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          targets ? existing.provider_id : providerId,
          targets ? existing.upstream_model : (f.upstream_model ?? existing.upstream_model),
          f.proto ?? existing.proto,
          f.name, f.description, f.hugging_face_id, f.quantization, f.openrouter_slug,
          f.always_on, f.enabled, f.context_length, f.max_output_length, f.created,
          f.input_modalities, f.output_modalities, f.sampling_params, f.features,
          f.reasoning_efforts, f.pricing, f.datacenters, Date.now(), modelId,
        );
        if (targets) {
          replaceModelTargets(modelId, targets);
        } else if ("providerId" in body || "upstreamModel" in body) {
          upsertPrimaryTarget(modelId, providerId, f.upstream_model ?? existing.upstream_model);
        }
        if (newId) db.prepare("UPDATE models SET id = ? WHERE id = ?").run(newId, modelId);
        refreshModelMirror(finalId);
      })();
      invalidateModelCache();
      auditAdmin(
        ctx.user,
        newId ? "model.renamed" : "model.updated",
        finalId,
        {
          providerId,
          ...(targets ? { targets: targets.length } : {}),
          ...(newId ? { renamedFrom: modelId } : {}),
        },
        ip,
      );
      const row = db
        .prepare<ModelRow & { provider_name: string | null }, [string]>(
          `SELECT m.*, p.name AS provider_name FROM models m LEFT JOIN providers p ON p.id = m.provider_id WHERE m.id = ?`,
        )
        .get(finalId)!;
      return ok({ model: publicModelAdmin(row, modelTargetsFor(finalId)) }, req);
    }

    if (req.method === "DELETE") {
      db.prepare("DELETE FROM models WHERE id = ?").run(modelId);
      invalidateModelCache();
      auditAdmin(ctx.user, "model.deleted", modelId, undefined, ip);
      return ok({ deleted: true }, req);
    }
  }

  // ================= users =================

  if (path === "/api/admin/users" && req.method === "GET") {
    const rows = db
      .prepare<UserRow, []>("SELECT * FROM users ORDER BY created_at DESC LIMIT 1000")
      .all();
    const keyCounts = db
      .prepare<{ user_id: string; n: number }, []>(
        "SELECT user_id, COUNT(*) AS n FROM api_keys GROUP BY user_id",
      )
      .all();
    const countMap = new Map(keyCounts.map((r) => [r.user_id, r.n]));
    return ok(
      {
        users: rows.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          status: u.status,
          hasPassword: !!u.password_hash,
          googleLinked: !!u.google_id,
          totpEnabled: !!u.totp_secret,
          createdAt: u.created_at,
          lastLoginAt: u.last_login_at,
          keyCount: countMap.get(u.id) ?? 0,
        })),
      },
      req,
    );
  }

  if (path === "/api/admin/users" && req.method === "POST") {
    const body = await readJsonBody(req, LIMITS.apiBodyBytes);
    const email = v.email(body, "email");
    const name = v.str(body, "name", { min: 1, max: 128 })!;
    const role = body.role === "admin" ? "admin" : "user";
    const sendInvite = body.sendInvite !== false;

    if (stmts.userByEmail.get(email)) return err(409, "email already registered", req);

    const id = randomToken(12);
    db.prepare(
      "INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, email, name, role, Date.now());

    let inviteSent = false;
    let inviteLink: string | null = null;
    if (sendInvite) {
      const token = randomToken(32);
      db.prepare(
        "INSERT INTO password_tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, 'invite', ?)",
      ).run(sha256Hex(token), id, Date.now() + LIMITS.passwordTokenTtlMs);
      inviteSent = await sendInviteEmail(email, name, token);
      // Relative link when PUBLIC_URL is unset — the dashboard prefixes the
      // origin the admin is actually browsing with (handles port-forwarding).
      const base = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
      inviteLink = inviteSent ? null : `${base}/#/set-password?token=${encodeURIComponent(token)}`;
    }
    auditAdmin(ctx.user, "user.created", id, { email, role, inviteSent }, ip);
    return ok(
      {
        user: { id, email, name, role },
        invite: { sent: inviteSent, link: inviteLink, smtpConfigured: SMTP_ENABLED },
      },
      req,
    );
  }

  const userMatch = path.match(
    /^\/api\/admin\/users\/([a-f0-9]{24})(\/reset-2fa|\/send-reset|\/revoke-sessions)?$/,
  );
  if (userMatch) {
    const targetId = userMatch[1]!;
    const action = userMatch[2] || "";
    const target = stmts.userById.get(targetId);
    if (!target) return err(404, "user not found", req);

    if (req.method === "PATCH" && !action) {
      const body = await readJsonBody(req, LIMITS.apiBodyBytes);
      const name = v.str(body, "name", { min: 1, max: 128, optional: true }) ?? target.name;
      const role = body.role === "admin" || body.role === "user" ? body.role : target.role;
      const status =
        body.status === "banned" || body.status === "active" ? body.status : target.status;
      if (targetId === ctx.user.id && (role !== "admin" || status !== "active")) {
        return err(400, "you cannot demote or ban yourself", req);
      }
      db.prepare("UPDATE users SET name = ?, role = ?, status = ? WHERE id = ?").run(
        name,
        role,
        status,
        targetId,
      );
      if (status === "banned") revokeAllUserSessions(targetId);
      auditAdmin(ctx.user, "user.updated", targetId, { name, role, status }, ip);
      return ok({ done: true }, req);
    }

    if (req.method === "DELETE" && !action) {
      if (targetId === ctx.user.id) return err(400, "you cannot delete yourself", req);
      db.prepare("DELETE FROM users WHERE id = ?").run(targetId);
      auditAdmin(ctx.user, "user.deleted", targetId, { email: target.email }, ip);
      return ok({ deleted: true }, req);
    }

    if (req.method === "POST" && action === "/reset-2fa") {
      db.prepare("UPDATE users SET totp_secret = NULL, totp_pending = NULL WHERE id = ?").run(
        targetId,
      );
      auditAdmin(ctx.user, "user.2fa.reset", targetId, undefined, ip);
      return ok({ done: true }, req);
    }

    if (req.method === "POST" && action === "/revoke-sessions") {
      revokeAllUserSessions(targetId);
      auditAdmin(ctx.user, "user.sessions.revoked", targetId, undefined, ip);
      return ok({ done: true }, req);
    }

    if (req.method === "POST" && action === "/send-reset") {
      const token = randomToken(32);
      db.prepare(
        "INSERT INTO password_tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, 'reset', ?)",
      ).run(sha256Hex(token), targetId, Date.now() + LIMITS.passwordTokenTtlMs);
      const sent = await sendResetEmail(target.email, token);
      const base = (process.env.PUBLIC_URL ?? "").replace(/\/$/, "");
      const link = sent ? null : `${base}/#/set-password?token=${encodeURIComponent(token)}`;
      auditAdmin(ctx.user, "user.reset.sent", targetId, { sent }, ip);
      return ok({ sent, link }, req);
    }
  }

  // ================= keys (global view) =================

  if (path === "/api/admin/keys" && req.method === "GET") {
    const rows = db
      .prepare<ApiKeyRow, []>("SELECT * FROM api_keys ORDER BY created_at DESC LIMIT 1000")
      .all();
    const users = db.prepare<UserRow, []>("SELECT * FROM users").all();
    const emailById = new Map(users.map((u) => [u.id, u.email]));
    return ok({ keys: rows.map((k) => publicKey(k, emailById.get(k.user_id))) }, req);
  }

  const adminKeyMatch = path.match(/^\/api\/admin\/keys\/([a-f0-9]{24})(\/reveal)?$/);
  if (adminKeyMatch && req.method === "DELETE" && !adminKeyMatch[2]) {
    const keyId = adminKeyMatch[1]!;
    const key = db.prepare<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE id = ?").get(keyId);
    if (!key) return err(404, "key not found", req);

    const hard = new URL(req.url).searchParams.get("hard") === "true";
    if (hard) {
      db.prepare("DELETE FROM api_keys WHERE id = ?").run(keyId);
      auditAdmin(ctx.user, "key.deleted.admin", keyId, { owner: key.user_id, name: key.name }, ip);
      return ok({ deleted: true }, req);
    }

    revokeKey(keyId);
    auditAdmin(ctx.user, "key.revoked.admin", keyId, { owner: key.user_id }, ip);
    return ok({ revoked: true }, req);
  }

  if (adminKeyMatch && adminKeyMatch[2] === "/reveal" && req.method === "GET") {
    const keyId = adminKeyMatch[1]!;
    const key = db.prepare<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE id = ?").get(keyId);
    if (!key) return err(404, "key not found", req);
    if (!key.token_enc) {
      return err(404, "this key predates reveal support", req);
    }
    const token = await decryptSecret(key.token_enc, GATEWAY_SECRET);
    auditAdmin(ctx.user, "key.revealed.admin", keyId, { owner: key.user_id }, ip);
    return ok({ token }, req);
  }

  // ================= stats =================

  if (path === "/api/admin/stats" && req.method === "GET") {
    // Hour granularity ("1D"): the window tables come from usage_events so
    // series/top-lists stay consistent with the trailing-N-hours chart.
    const hoursParam = url.searchParams.get("hours");
    const hours = hoursParam !== null ? Math.min(Math.max(Number(hoursParam) || 24, 1), 168) : null;
    const daysAll = url.searchParams.get("days") === "all";
    const days = daysAll ? "all" : Math.min(Number(url.searchParams.get("days") || 14), 365);

    const range =
      hours !== null
        ? hourlySeries(null, null, hours)
        : days === "all"
          ? db
              .prepare(
                `SELECT date, SUM(in_tok) AS in_tok, SUM(cache_tok) AS cache_tok, SUM(out_tok) AS out_tok, SUM(reqs) AS reqs
                 FROM usage_daily GROUP BY date ORDER BY date`,
              )
              .all()
          : db
              .prepare(
                `SELECT date, SUM(in_tok) AS in_tok, SUM(cache_tok) AS cache_tok, SUM(out_tok) AS out_tok, SUM(reqs) AS reqs
                 FROM usage_daily WHERE date >= date('now', ?) GROUP BY date ORDER BY date`,
              )
              .all(`-${days} days`);
    const perUser =
      hours !== null
        ? db
            .prepare(
              `SELECT ue.user_id, u.email, SUM(ue.in_tok) AS in_tok, SUM(ue.cache_tok) AS cache_tok, SUM(ue.out_tok) AS out_tok, COUNT(*) AS reqs
               FROM usage_events ue JOIN users u ON u.id = ue.user_id
               WHERE ue.ts >= ? GROUP BY ue.user_id ORDER BY (in_tok + cache_tok + out_tok) DESC LIMIT 50`,
            )
            .all(Date.now() - hours * 3_600_000)
        : days === "all"
          ? db
              .prepare(
                `SELECT ud.user_id, u.email, SUM(ud.in_tok) AS in_tok, SUM(ud.cache_tok) AS cache_tok, SUM(ud.out_tok) AS out_tok, SUM(ud.reqs) AS reqs
                 FROM usage_daily ud JOIN users u ON u.id = ud.user_id
                 GROUP BY ud.user_id ORDER BY (in_tok + cache_tok + out_tok) DESC LIMIT 50`,
              )
              .all()
          : db
              .prepare(
                `SELECT ud.user_id, u.email, SUM(ud.in_tok) AS in_tok, SUM(ud.cache_tok) AS cache_tok, SUM(ud.out_tok) AS out_tok, SUM(ud.reqs) AS reqs
                 FROM usage_daily ud JOIN users u ON u.id = ud.user_id
                 WHERE ud.date >= date('now', ?) GROUP BY ud.user_id ORDER BY (in_tok + cache_tok + out_tok) DESC LIMIT 50`,
              )
              .all(`-${days} days`);
    // Hour windows need sub-day granularity -> usage_events (selective range,
    // <1ms with planner stats). Day/all windows read the usage_model_daily
    // rollup instead of grouping millions of raw events (3330ms -> ~30ms at
    // 10y scale; see docs/performance).
    const perModel =
      hours !== null
        ? db
            .prepare(
              `SELECT model, proto, COALESCE(SUM(in_tok),0) AS in_tok, COALESCE(SUM(cache_tok),0) AS cache_tok, COALESCE(SUM(out_tok),0) AS out_tok, COUNT(*) AS reqs
               FROM usage_events WHERE ts >= ?
               GROUP BY model, proto ORDER BY (in_tok + cache_tok + out_tok) DESC LIMIT 20`,
            )
            .all(Date.now() - hours * 3_600_000)
        : days === "all"
          ? db
              .prepare(
                `SELECT model, proto, COALESCE(SUM(in_tok),0) AS in_tok, COALESCE(SUM(cache_tok),0) AS cache_tok, COALESCE(SUM(out_tok),0) AS out_tok, COALESCE(SUM(reqs),0) AS reqs
                 FROM usage_model_daily
                 GROUP BY model, proto ORDER BY (in_tok + cache_tok + out_tok) DESC LIMIT 20`,
              )
              .all()
          : db
              .prepare(
                `SELECT model, proto, COALESCE(SUM(in_tok),0) AS in_tok, COALESCE(SUM(cache_tok),0) AS cache_tok, COALESCE(SUM(out_tok),0) AS out_tok, COALESCE(SUM(reqs),0) AS reqs
                 FROM usage_model_daily WHERE date >= date('now', ?)
                 GROUP BY model, proto ORDER BY (in_tok + cache_tok + out_tok) DESC LIMIT 20`,
              )
              .all(`-${days} days`);
    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(in_tok),0) AS in_tok, COALESCE(SUM(cache_tok),0) AS cache_tok, COALESCE(SUM(out_tok),0) AS out_tok, COALESCE(SUM(reqs),0) AS reqs
         FROM usage_daily`,
      )
      .get();
    const todayRow = db
      .prepare(
        `SELECT COALESCE(SUM(in_tok),0) AS in_tok, COALESCE(SUM(cache_tok),0) AS cache_tok, COALESCE(SUM(out_tok),0) AS out_tok, COALESCE(SUM(reqs),0) AS reqs
         FROM usage_daily WHERE date = ?`,
      )
      .get(utcDate(Date.now()));
    const counts = {
      users: db.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get()!.n,
      keys: db.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM api_keys").get()!.n,
      activeKeys: db
        .prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM api_keys WHERE status = 'active'")
        .get()!.n,
      providers: db.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM providers").get()!.n,
    };
    return ok(
      { series: range, perUser, perModel, totals, today: todayRow, counts, granularity: hours !== null ? "hour" : "day" },
      req,
    );
  }

  if (path === "/api/admin/audit" && req.method === "GET") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 200);
    const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
    const rows = db
      .prepare(
        `SELECT a.ts, a.action, a.target, a.meta, a.ip, u.email AS actor_email
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
         ORDER BY a.ts DESC, a.id DESC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset);
    const total = db.prepare<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_log").get()!.n;
    return ok({ entries: rows, total }, req);
  }

  return null;
}
