import { LIMITS } from "../config";
import { stmts, audit, parseStripParams, type AuthStyle, type Proto } from "../db";
import { randomToken, sha256Hex } from "../crypto";
import { clientIp, baseHeaders } from "../http";
import { countRequestTokens, splitKvInput } from "../tokens";
import {
  acquireUpstreamSlot,
  releaseUpstreamSlot,
  keyRpmHit,
  limits,
} from "../ratelimit";
import { checkKeyAvailability } from "../keys";
import { recordUsage, flushUsage, getKeySpend } from "../usage";
import { db } from "../db";
import {
  routerSnapshot,
  resolveModelRoute,
  passthroughCandidates,
  listableModels,
  publicModelEntry,
  candidateUsable,
  type RouterSnapshot,
  type RouteCandidate,
  type RoutedKey,
} from "../models";
import {
  classifyHttpError,
  stickyClear,
  stickyGet,
  stickySet,
} from "../failover";
import { normalizeAttemptBody } from "./target-profile";
import { extractDsmlToolCalls, patchRawResponseDsml, toolHintsFromRequest } from "./dsml";
import {
  decodeToIR,
  encodeIR,
  decodeResponseToIR,
  encodeResponseFromIR,
  reEnvelopeErrorIR,
  IRStreamTranslator,
  type Proto as IRProto,
} from "./gateway-ir";

/**
 * The gateway itself: OpenAI-, Responses- and Anthropic-compatible
 * pass-through proxy.
 *
 *   client --(gw_ key)--> this --(real key)--> configured upstream provider
 *
 * Guarantees: authN/Z per request, budget/rate/concurrency enforcement,
 * streaming with incremental usage parsing, sanitized failures, and usage
 * accounting per key/user — including client aborts.
 */

interface RouteMatch {
  proto: Proto;
  upstreamPath: string; // appended to the provider's capability base URL
  isModelsList?: boolean;
  /** Decoded model id for `GET .../v1/models/:id`. */
  modelId?: string;
}

interface RouteResult {
  match: RouteMatch | null;
  hint: Proto; // best-guess protocol for error envelopes, even on 404
}

/**
 * Map our public surface to capability + upstream path. match=null means 404.
 *
 * Two shapes:
 *  - legacy  /v1/*            → protocol inferred from the endpoint itself
 *                               (/v1/models disambiguates via auth header)
 *  - strict  /openai/v1/*  /anthropic/v1/* → PROTOCOL FORCED by the path
 *    prefix; only that protocol's endpoints resolve under it, so tools can
 *    point at an unambiguous base URL regardless of header style.
 */
function matchRoute(pathname: string, method: string, req: Request): RouteResult {
  let forced: Proto | null = null;
  let p = pathname;
  if (p === "/openai/v1" || p.startsWith("/openai/v1/")) {
    forced = "openai";
    p = "/v1" + p.slice("/openai/v1".length);
  } else if (p === "/anthropic/v1" || p.startsWith("/anthropic/v1/")) {
    forced = "anthropic";
    p = "/v1" + p.slice("/anthropic/v1".length);
  }
  const hint = forced ?? "openai";

  // OpenAI surface
  if (forced !== "anthropic") {
    if (p === "/v1/chat/completions" && method === "POST")
      return { match: { proto: "openai", upstreamPath: "/chat/completions" }, hint };
    if (p === "/v1/responses" && method === "POST")
      return { match: { proto: "responses", upstreamPath: "/responses" }, hint };
    if (p === "/v1/completions" && method === "POST")
      return { match: { proto: "openai", upstreamPath: "/completions" }, hint };
    if (p === "/v1/embeddings" && method === "POST")
      return { match: { proto: "openai", upstreamPath: "/embeddings" }, hint };
  }

  // Anthropic surface
  if (forced !== "openai") {
    if (p === "/v1/messages" && method === "POST")
      return { match: { proto: "anthropic", upstreamPath: "/messages" }, hint };
    if (p === "/v1/messages/count_tokens" && method === "POST")
      return { match: { proto: "anthropic", upstreamPath: "/messages/count_tokens" }, hint };
  }

  // Models listing: forced prefix decides the protocol outright; the legacy
  // bare /v1/models keeps the old auth-header disambiguation.
  if ((p === "/v1/models" || p.startsWith("/v1/models/")) && method === "GET") {
    let modelId: string | undefined;
    if (p.startsWith("/v1/models/")) {
      const raw = p.slice("/v1/models/".length);
      modelId = raw;
      try {
        modelId = decodeURIComponent(raw);
      } catch {
        /* leave raw */
      }
    }
    const mk = (proto: Proto): RouteMatch => ({
      proto,
      upstreamPath: p.slice(3),
      isModelsList: true,
      modelId,
    });
    if (forced) return { match: mk(forced), hint };
    if (req.headers.get("x-api-key")) {
      return { match: mk("anthropic"), hint: "anthropic" };
    }
    if (req.headers.get("authorization")) {
      return { match: mk("openai"), hint };
    }
  }
  return { match: null, hint };
}

// ===== Error envelopes per protocol =====

function envelopeError(proto: Proto, status: number, message: string, type?: string, req?: Request): Response {
  const h = baseHeaders(req);
  h.set("Content-Type", "application/json; charset=utf-8");
  // Responses errors share the OpenAI `{error:{…}}` envelope — clients
  // (codex) depend on it.
  if (proto === "openai" || proto === "responses") {
    return new Response(
      JSON.stringify({
        error: { message: message, type: type ?? (status === 401 ? "authentication_error" : "invalid_request_error"), code: null },
      }),
      { status, headers: h },
    );
  }
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: type ?? (status === 401 ? "authentication_error" : "invalid_request_error"), message: message },
    }),
    { status, headers: h },
  );
}

// ===== Failover observability (per-provider-key stats, write-light) =====
// No-skip policy: NOTHING here removes a key from rotation. A failed
// attempt only bumps `fail_count` as an admin-visible signal (reset by any
// success); upstream failures are audit-logged so the dashboard shows
// which key is unhealthy, and the client always receives the real upstream
// error and owns backoff/retry.

const qKeyFailBump = db.prepare(
  "UPDATE provider_keys SET fail_count = fail_count + 1, updated_at = ? WHERE id = ?",
);
const qKeyFailReset = db.prepare(
  "UPDATE provider_keys SET fail_count = 0, updated_at = ? WHERE id = ? AND fail_count != 0",
);

/** A failed attempt: bump the visible failure counter + audit the cause.
 *  Failover itself is decided by the classification at the call site
 *  (`continue` to the next candidate) — this only records it. */
function noteProviderKeyFailure(key: RoutedKey, cls: string): void {
  qKeyFailBump.run(Date.now(), key.id);
  audit("provider_key.failed", {
    target: key.id,
    meta: { reason: cls, label: key.label },
  });
  console.warn(`[PROXY] upstream key failed (${cls}): ${key.label || key.id}`);
}

/** Healthy response (or a client-caused rejection that proves the key
 *  works): clear the visible failure counter. The conditional UPDATE
 *  keeps the common path write-free. */
function noteProviderKeyOk(key: RoutedKey): void {
  qKeyFailReset.run(Date.now(), key.id);
}

/** Consume an upstream error body (capped) so it can be classified for
 *  failover. Error bodies from LLM providers are small JSON payloads — the
 *  cap guards against pathological upstreams. */
async function readBodyCapped(resp: Response, cap: number): Promise<string> {
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        chunks.push(value);
        total += value.length;
        if (total >= cap) break;
      }
    }
  } catch {
    /* aborted/failed upstream: classify whatever bytes we have */
  } finally {
    reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(Math.min(total, cap));
  let off = 0;
  for (const c of chunks) {
    const n = Math.min(c.length, buf.length - off);
    if (n <= 0) break;
    buf.set(c.subarray(0, n), off);
    off += n;
  }
  return new TextDecoder().decode(buf);
}

// ===== Circuit breaker (per provider+capability) =====

const breakers = new Map<string, { fails: number; openUntil: number }>();

function breakerState(id: string): "open" | "closed" {
  const b = breakers.get(id);
  if (!b) return "closed";
  if (b.openUntil > Date.now()) return "open";
  return "closed";
}

function breakerFail(id: string): void {
  const b = breakers.get(id) ?? { fails: 0, openUntil: 0 };
  b.fails++;
  if (b.fails >= LIMITS.breakerFailThreshold) {
    b.openUntil = Date.now() + LIMITS.breakerOpenMs;
    b.fails = 0;
    console.warn(`[PROXY] circuit breaker OPEN for provider ${id} (${LIMITS.breakerOpenMs}ms)`);
  }
  breakers.set(id, b);
}

function breakerOk(id: string): void {
  breakers.delete(id);
}

// ===== Header hygiene =====

const STRIP_REQ_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "cookie",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "cf-connecting-ip",
  "cf-ray",
  "cf-ipcountry",
]);

function buildUpstreamHeaders(req: Request, proto: Proto, key: string, style: AuthStyle): Headers {
  const h = new Headers();
  req.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (STRIP_REQ_HEADERS.has(lower) || lower.startsWith("cf-")) return;
    h.set(name, value);
  });
  h.set("Content-Type", "application/json");
  h.set("Accept-Encoding", "identity"); // we tee the stream; keep bytes readable
  if (style === "x-api-key") {
    h.set("x-api-key", key);
  } else {
    h.set("Authorization", `Bearer ${key}`);
  }
  if (proto === "anthropic" && !h.has("anthropic-version")) {
    h.set("anthropic-version", "2023-06-01");
  }
  return h;
}

const STRIP_RES_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "set-cookie",
  "server",
  "date",
  // Security headers belong to the gateway, never to the upstream. Without
  // this, a compromised provider could serve text/html on /v1/* that renders
  // as a live document on OUR origin (dashboard tokens live in localStorage).
  "content-type", // re-set below, sanitized
  "content-security-policy",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "x-xss-protection",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
]);

/** Only API-ish payloads may be rendered by clients; anything else becomes JSON. */
const SAFE_RES_CT = new Set(["application/json", "text/event-stream", "text/plain"]);
const MAX_BUFFERED_UPSTREAM_BYTES = 16 * 1024 * 1024;
/** SSE comment: ignored by every event-stream client dialect. */
const SSE_KEEPALIVE = new TextEncoder().encode(": ping\n\n");

/** Drop the provider's blocked top-level body params, if any configured. */
function stripBlockedParams(attemptBody: string, provider: { strip_params?: unknown }): string {
  const blocked = parseStripParams(provider.strip_params);
  if (blocked.length === 0) return attemptBody;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(attemptBody) as Record<string, unknown>;
  } catch {
    return attemptBody;
  }
  if (j === null || typeof j !== "object" || Array.isArray(j)) return attemptBody;
  let changed = false;
  for (const k of blocked) {
    if (k in j) {
      delete j[k];
      changed = true;
    }
  }
  return changed ? JSON.stringify(j) : attemptBody;
}

function safeResponseContentType(upstream: Headers): string {
  const raw = upstream.get("content-type") || "";
  const mime = raw.split(";")[0]!.trim().toLowerCase();
  return SAFE_RES_CT.has(mime) ? raw : "application/json; charset=utf-8";
}

function buildClientHeaders(upstream: Headers, requestId: string, req: Request, extra?: { attemptsMade?: number }): Headers {
  const h = baseHeaders(req);
  // Even if unsafe content slips through, it can never execute as a document.
  h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  upstream.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (STRIP_RES_HEADERS.has(lower) || [
      "cache-control", "pragma", "expires", "age", "etag", "last-modified", "vary",
      "access-control-allow-origin", "access-control-allow-credentials",
      "access-control-allow-methods", "access-control-allow-headers",
      "access-control-expose-headers", "access-control-max-age",
    ].includes(lower)) return;
    h.set(name, value);
  });
  h.set("Cache-Control", "no-store");
  h.set("Pragma", "no-cache");
  h.set("Content-Type", safeResponseContentType(upstream));
  h.set("X-Request-Id", requestId);
  // Failover/transparency signals for the client (which owns backoff):
  // how many upstream candidates this request attempted. Upstream
  // Retry-After / rate-limit hints pass through below via the copy loop
  // (they are not in the strip lists), so a 429 tells the client when
  // to retry instead of the gateway hiding it behind a 503.
  if (extra?.attemptsMade !== undefined) h.set("x-gateway-attempts", String(extra.attemptsMade));
  return h;
}

/**
 * Passthrough `GET /v1/models(:id)`: forward to the first usable upstream
 * and patch the payload for strict managers (codex requires `display_name`
 * per entry plus a top-level `models` array — upstreams like synthetic omit
 * both). Patch-only, never stored. Non-JSON or error upstreams pass through
 * untouched.
 */
async function passthroughModelsList(req: Request, proto: Proto, modelId?: string): Promise<Response> {
  const snap = await routerSnapshot();
  const cands = passthroughCandidates(snap, proto, modelId);
  const cand = cands[0];
  if (!cand) {
    return envelopeError(proto, 503, "gateway is not configured for this API protocol", "api_error", req);
  }
  const via = cand.via;
  const base = (
    via === "openai"
      ? cand.provider.row.openai_base_url
      : via === "responses"
        ? cand.provider.row.responses_base_url
        : cand.provider.row.anthropic_base_url
  )!.replace(/\/+$/, "");
  const upstreamPath = cand.translated
    ? via === "anthropic"
      ? "/messages"
      : via === "responses"
        ? "/responses"
        : "/chat/completions"
    : "/models";
  // Responses-capable listing lives under /responses/models upstream; the
  // other two share /models.
  const path = via === "responses" && cand.translated ? "/models" : upstreamPath;
  const url = base + path + (modelId !== undefined ? `/${encodeURIComponent(modelId)}` : "");
  const headers = buildUpstreamHeaders(
    req,
    via,
    cand.key.key,
    via === "openai"
      ? cand.provider.row.openai_auth_style
      : via === "responses"
        ? cand.provider.row.responses_auth_style
        : cand.provider.row.anthropic_auth_style,
  );
  let upstream: Response;
  try {
    upstream = await fetch(url, { method: "GET", headers });
  } catch {
    return envelopeError(proto, 502, "upstream is unreachable", "api_error", req);
  }
  const ct = upstream.headers.get("content-type") || "";
  const h = buildClientHeaders(upstream.headers, "models", req);
  if (!ct.includes("application/json")) return new Response(upstream.body, { status: upstream.status, headers: h });
  let text: string;
  try {
    text = await upstream.text();
  } catch {
    return new Response(null, { status: upstream.status, headers: h });
  }
  // Single-model fetch decodes into CodexModel too (strict struct — the
  // same missing-field 500s as the list). Rebuild with the allowlisted
  // shape when a modelId was requested.
  if (modelId !== undefined) {
    try {
      const one = JSON.parse(text) as Record<string, unknown>;
      const id = typeof one.id === "string" ? one.id : modelId;
      h.set("Content-Type", "application/json; charset=utf-8");
      return new Response(
        JSON.stringify({
          id,
          object: "model",
          created: typeof one.created === "number" ? one.created : 0,
          owned_by: typeof one.owned_by === "string" ? one.owned_by : "gateway",
          display_name: id, description: id,
          visibility: "list",
          priority: 0,
          supported_reasoning_levels: [
            { name: "low", description: "low reasoning effort", effort: "low" },
            { name: "medium", description: "medium reasoning effort", effort: "medium" },
            { name: "high", description: "high reasoning effort", effort: "high" },
          ],
          shell_type: "default",
          supported_in_api: true,
          support_verbosity: true,
          truncation_policy: { type: "auto" },
          mode: { id: "default" },
          model_messages: { instructions_template: "" },
          ...MODEL_INFO_DEFAULTS,
        }),
        { status: upstream.status, headers: h },
      );
    } catch {
      h.set("Content-Type", "application/json; charset=utf-8");
      return new Response(text, { status: upstream.status, headers: h });
    }
  }
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    // Anthropic clients expect the NATIVE list shape ({type:"model", ...},
    // has_more) — never rewrite it (the directional-alias contract + real
    // Anthropic SDKs depend on it). Only OpenAI-family surfaces get the
    // CodexModel allowlist below.
    if (proto === "anthropic") {
      h.set("Content-Type", "application/json; charset=utf-8");
      return new Response(text, { status: upstream.status, headers: h });
    }
    const data = (j as any).data;
    if (Array.isArray(data)) {
      // Codex decodes this payload into a STRICT struct: any unknown field
      // (synthetic sends ~20: reasoning_parameters, quantizations, lamar...) 
      // 500s the models refresh. Rebuild entries with the allowlisted shape
      // only: OpenAI list fields + the two compat fields codex requires.
      // data[] keeps the OpenAI list shape (lenient decoder) + compat extras.
      const clean = data
        .filter((m: any) => m && typeof m === "object")
        .map((m: any) => {
          const id = typeof m.id === "string" ? m.id : "model";
          const levelsFinal = ["low", "high", "max"].map((name: string) => ({ name, description: `${name} reasoning effort`, effort: name }));
          return { id, object: "model", created: typeof m.created === "number" ? m.created : 0, owned_by: typeof m.owned_by === "string" ? m.owned_by : "gateway", display_name: id, description: id, visibility: "list", priority: 0, supported_reasoning_levels: levelsFinal, shell_type: "default", supported_in_api: true, support_verbosity: true, truncation_policy: { type: "auto" }, mode: { id: "default" } };
        });
      (j as any).data = clean;
      // models[] decodes as Vec<ModelInfo> (STRICT 35-field struct — see
      // model_info_from_slug). Emit the EXACT fallback shape per entry:
      // slug (not id!), every Option-without-default as null, required
      // enums with fallback values. Anything missing 500s the refresh.
      const toModelInfo = (id: string) => ({
        slug: id,
        display_name: id,
        description: id,
        default_reasoning_level: null,
        supported_reasoning_levels: ["low", "high", "max"].map((name: string) => ({ effort: name, description: `${name} reasoning effort` })),
        shell_type: "unified_exec",
        visibility: "list",
        supported_in_api: true,
        priority: 0,
        additional_speed_tiers: [],
        service_tiers: [],
        default_service_tier: null,
        available_access_programs: null,
        availability_nux: null,
        upgrade: null,
        model_messages: { instructions_template: "" },
        include_skills_usage_instructions: false,
        include_plugin_usage_instructions: false,
        include_apps_usage_instructions: true,
        supports_reasoning_summary_parameter: true,
        default_reasoning_summary: "auto",
        support_verbosity: false,
        default_verbosity: null,
        apply_patch_tool_type: null,
        web_search_tool_type: "text",
        truncation_policy: { mode: "bytes", limit: 10000 },
        supports_image_detail_original: false,
        context_window: 272000,
        max_context_window: 272000,
        auto_compact_token_limit: null,
        comp_hash: null,
        effective_context_window_percent: 95,
        experimental_supported_tools: [],
        input_modalities: ["text", "image"],
        supports_search_tool: false,
        supports_experimental_context: false,
        use_responses_lite: false,
        supports_reasoning_effort_updates: false,
        guardian: null,
        node_repl_auto_review_required: false,
        node_repl_disabled: false,
        auto_review_model_override: null,
        model_specialty: null,
        tool_mode: null,
        multi_agent_version: null,
        multi_agent_reasoning_effort: null,
      });
      (j as any).models = clean.map((m: any) => toModelInfo(typeof m.id === "string" ? m.id : "model"));
      // Drop any other top-level extras the upstream sent.
      for (const k of Object.keys(j)) {
        if (k !== "object" && k !== "data" && k !== "models") delete (j as any)[k];
      }
      (j as any).object = "list";
    }
    h.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(j), { status: upstream.status, headers: h });
  } catch {
    h.set("Content-Type", "application/json; charset=utf-8");
    return new Response(text, { status: upstream.status, headers: h });
  }
}

/** Decoded model id for `GET .../v1/models/:id`. */
/**
 * Router-mode `/v1/models`: answered from the local registry (rich format),
 * never forwarded upstream. Only servable models are listed (enabled, with an
 * enabled provider exposing this protocol's capability).
 */
// Full ModelInfo shape, mirroring codex's model_info_from_slug fallback
// (every field the fallback constructor sets — Option fields WITHOUT
// #[serde(default)] are REQUIRED to be present, null allowed; omitting any
// single one 500s the whole models refresh with `missing field X`).
const MODEL_INFO_DEFAULTS = {
  default_reasoning_level: null,
  additional_speed_tiers: [],
  service_tiers: [],
  default_service_tier: null,
  available_access_programs: null,
  availability_nux: null,
  upgrade: null,
  base_instructions: "",
  include_skills_usage_instructions: false,
  include_plugin_usage_instructions: false,
  include_apps_usage_instructions: true,
  supports_reasoning_summary_parameter: true,
  default_reasoning_summary: "auto",
  default_verbosity: null,
  apply_patch_tool_type: null,
  web_search_tool_type: "text",
  supports_image_detail_original: false,
  context_window: 272000,
  max_context_window: 272000,
  auto_compact_token_limit: null,
  comp_hash: null,
  effective_context_window_percent: 95,
  experimental_supported_tools: [],
  input_modalities: ["text", "image"],
  supports_search_tool: false,
  supports_experimental_context: false,
  use_responses_lite: false,
  supports_reasoning_effort_updates: false,
  guardian: null,
  node_repl_auto_review_required: false,
  node_repl_disabled: false,
  auto_review_model_override: null,
  model_specialty: null,
  tool_mode: null,
  multi_agent_version: null,
  multi_agent_reasoning_effort: null,
};
const MODEL_LEVELS = [{ name: "low", description: "low reasoning effort", effort: "low" }, { name: "high", description: "high reasoning effort", effort: "high" }, { name: "max", description: "max reasoning effort", effort: "max" }];

function registryModelsResponse(
  req: Request,
  snap: RouterSnapshot,
  proto: Proto,
  modelId?: string,
): Response {
  const rows = listableModels(snap, proto);
  // Responses clients (codex) expect the OpenAI list shape — and some
  // versions require a top-level `models` array — while the rich
  // registry format stays on the chat/anthropic surfaces.
  if (proto === "responses") {
    const providerName = (m: (typeof rows)[number]) =>
      snap.providers.get(m.provider_id!)?.row.name ?? "";
    const h = baseHeaders(req);
    h.set("Content-Type", "application/json; charset=utf-8");
    if (modelId !== undefined) {
      const m = rows.find((r) => r.id === modelId);
      if (!m) {
        return envelopeError(proto, 404, `unknown model '${modelId}'`, "model_not_found", req);
      }
      return new Response(
        JSON.stringify({ id: m.id, object: "model", created: 0, owned_by: providerName(m) }),
        { headers: h },
      );
    }
    // Codex hard-requires `display_name`, `supported_reasoning_levels` +
    // top-level `models` on this surface (it 500s the models refresh
    // otherwise); the data[] entries keep the OpenAI list shape.
    // (Observed live: `missing field supported_reasoning_levels`.)
    return new Response(
      JSON.stringify({
        object: "list",
        data: rows.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: providerName(m), display_name: m.id, visibility: "list", shell_type: "default", supported_in_api: true, support_verbosity: true, supported_reasoning_levels: MODEL_LEVELS, mode: { id: "default" }, ...MODEL_INFO_DEFAULTS })),
        models: rows.map((m) => ({ id: m.id, slug: m.id, display_name: m.id, visibility: "list", shell_type: "default", supported_in_api: true, support_verbosity: true, supported_reasoning_levels: MODEL_LEVELS, mode: { id: "default" }, ...MODEL_INFO_DEFAULTS })),
      }),
      { headers: h },
    );
  }
  const providerName = (m: (typeof rows)[number]) =>
    snap.providers.get(m.provider_id!)?.row.name ?? "";
  if (modelId !== undefined) {
    const m = rows.find((r) => r.id === modelId);
    if (!m) {
      return envelopeError(proto, 404, `unknown model '${modelId}'`, "model_not_found", req);
    }
    const h = baseHeaders(req);
    h.set("Content-Type", "application/json; charset=utf-8");
    return new Response(JSON.stringify(publicModelEntry(m, providerName(m))), { headers: h });
  }
  const h = baseHeaders(req);
  h.set("Content-Type", "application/json; charset=utf-8");
  // Extra top-level `models` id list: some clients (codex) require it
  // alongside `data` and ignore unknown shapes otherwise.
  return new Response(
    JSON.stringify({
      data: rows.map((m) => publicModelEntry(m, providerName(m))),
      models: rows.map((m) => ({ id: m.id, slug: m.id })),
    }),
    { headers: h },
  );
}

// ===== Token estimation fallback =====
// btdby4 per-protocol request counters (same BPE engine as the
// indirect-code daemon). Used ONLY on the fallback path — whenever the
// upstream reports real usage figures, those always win.

export function estimateBodyTokens(bodyJson: unknown, proto?: "openai" | "anthropic" | "responses"): number {
  if (!bodyJson || typeof bodyJson !== "object" || Array.isArray(bodyJson)) return 1;
  const body = bodyJson as Record<string, unknown>;
  // The caller (handleProxy) knows the ingress surface — it tells us which
  // per-protocol counter to use. Sniffing only covers direct callers/tests.
  const p =
    proto ??
    (Array.isArray((body as any).input)
      ? "responses"
      : typeof (body as any).max_tokens === "number" && Array.isArray((body as any).messages)
        ? "anthropic"
        : "openai");
  return countRequestTokens(p, body);
}

// ===== Usage parsing =====

interface UsageResult {
  inTok: number;
  cacheTok: number;
  outTok: number;
  model: string;
  estimated: boolean;
}

// ===== Main handler =====

/**
 * Ask a chat-completions upstream to include a terminal usage chunk so
 * accounting stays exact (Anthropic and Responses always stream usage
 * events). This and the router-mode per-attempt model rewrite are the
 * ONLY fields ever mutated — otherwise the original bytes go untouched.
 */
function withChatStreamOptions(attemptBody: string): string {
  try {
    const j = JSON.parse(attemptBody) as Record<string, unknown>;
    if (j && typeof j === "object" && (j as any).stream === true) {
      const so = ((j as any).stream_options ?? {}) as Record<string, unknown>;
      if (so.include_usage !== true) {
        so.include_usage = true;
        (j as any).stream_options = so;
        return JSON.stringify(j);
      }
    }
  } catch {
    /* unparseable body goes upstream untouched */
  }
  return attemptBody;
}

/**
 * Re-envelope an upstream error to the client's protocol. Chat and
 * Responses share the OpenAI `{error:{…}}` envelope (passthrough either
 * way); only the Anthropic direction converts.
 */
function reEnvelopeError(proto: Proto, via: Proto, status: number, body: string): string {
  if (via === proto) return body;
  // All error re-envelopes go through the gateway IR: extract the upstream
  // message once, envelope in the client protocol. Protocol N+1 only needs
  // its message extractor in errorMessageFromBody. No legacy fallback: if
  // the IR cannot parse the error, the raw upstream body is delivered.
  try {
    return reEnvelopeErrorIR(proto as IRProto, via as IRProto, status, body);
  } catch {
    return body;
  }
}

export async function handleProxy(req: Request, url: URL, server: any): Promise<Response> {
  const { match: route, hint } = matchRoute(url.pathname, req.method, req);
  if (!route) {
    return envelopeError(hint, 404, "unknown endpoint", "invalid_request_error", req);
  }
  const proto = route.proto;
  const ip = clientIp(req, server);

  // ---- authenticate the gateway API key ----
  let token: string;
  const authz = req.headers.get("authorization");
  if (proto === "openai" || proto === "responses") {
    token = authz?.startsWith("Bearer ") ? authz.slice(7).trim() : (req.headers.get("x-api-key") ?? "");
  } else {
    token = req.headers.get("x-api-key") ?? (authz?.startsWith("Bearer ") ? authz.slice(7).trim() : "");
  }
  if (!token || !token.startsWith("gw_") || token.length !== 51) {
    return envelopeError(proto, 401, "missing or malformed API key (expected gw_…)", undefined, req);
  }

  const keyRow = stmts.keyByHash.get(sha256Hex(token));
  if (!keyRow) {
    // Failed proxy auth attempts get their own strict bucket: key spraying dies here.
    const retry = limits.authPerMin(`proxyfail:${ip}`);
    if (retry > 0) return envelopeError(proto, 429, "too many failed authentications", undefined, req);
    return envelopeError(proto, 401, "invalid API key", undefined, req);
  }

  // ---- availability (revoked/expired/budgets) ----
  const availability = checkKeyAvailability(keyRow);
  if (!availability.ok) {
    const messages: Record<typeof availability.reason, string> = {
      revoked: "this API key has been revoked",
      exhausted: "this API key has exhausted its total output token budget",
      expired: "this API key has expired",
      daily_limit: "daily output token budget exhausted (resets at 00:00 UTC)",
      total_limit: "total output token budget exhausted",
    };
    return envelopeError(proto, 429, messages[availability.reason], "rate_limit_error", req);
  }

  // Owner must be an active user.
  const owner = stmts.userById.get(keyRow.user_id);
  if (!owner || owner.status !== "active") {
    return envelopeError(proto, 401, "account unavailable", undefined, req);
  }

  // ---- per-key rate + concurrency ----
  const rpm = keyRow.rpm ?? LIMITS.defaultKeyRpm;
  const rpmRetry = keyRpmHit(keyRow.id, rpm);
  if (rpmRetry > 0) {
    return envelopeError(proto, 429, `rate limit exceeded (${rpm} req/min), retry in ${rpmRetry}s`, "rate_limit_error", req);
  }
  if (!acquireUpstreamSlot(keyRow.id, LIMITS.defaultKeyConcurrency)) {
    return envelopeError(proto, 429, "too many concurrent requests for this key", "rate_limit_error", req);
  }

  // Slot released exactly once, whatever happens below.
  let slotReleased = false;
  const release = () => {
    if (!slotReleased) {
      slotReleased = true;
      releaseUpstreamSlot(keyRow.id);
    }
  };
  req.signal.addEventListener("abort", release, { once: true });

  const requestId = randomToken(8);
  const started = performance.now();
  const requestBytes = req.headers.get("content-length");
  // Set once we hand a streaming Response back: the stream pump owns the slot
  // from there on, releasing it when the stream ends/aborts (not before).
  let slotHeldByStream = false;

  try {
    // ---- read + validate body (GET /models has none) ----
    let bodyText = "";
    let bodyJson: Record<string, unknown> | null = null;
    if (req.method === "POST") {
      if (requestBytes && Number(requestBytes) > LIMITS.proxyBodyBytes) {
        return envelopeError(proto, 413, "payload too large", "invalid_request_error", req);
      }
      try {
        bodyText = await req.text();
      } catch {
        return envelopeError(proto, 400, "could not read request body", undefined, req);
      }
      if (bodyText.length > LIMITS.proxyBodyBytes) {
        return envelopeError(proto, 413, "payload too large", "invalid_request_error", req);
      }
      const ctype = (req.headers.get("content-type") || "").toLowerCase();
      if (!ctype.includes("application/json")) {
        return envelopeError(proto, 415, "content-type must be application/json", "invalid_request_error", req);
      }
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        return envelopeError(proto, 400, "invalid JSON body", "invalid_request_error", req);
      }
      if (typeof bodyJson !== "object" || bodyJson === null || Array.isArray(bodyJson)) {
        return envelopeError(proto, 400, "JSON body must be an object", "invalid_request_error", req);
      }
      if (typeof (bodyJson as any).model !== "string" && !route.isModelsList) {
        return envelopeError(proto, 400, "`model` is required", "invalid_request_error", req);
      }
    }

    // Declared tools (any protocol shape) drive DSML tool-call recovery on
    // the response side — empty (no tools / tool_choice none) disables it.
    const dsmlTools = toolHintsFromRequest(bodyJson);

    // ---- model registry (routing mode + router-backed /v1/models) ----
    const snap = await routerSnapshot();
    let routedPublicModel: string | null = null;

    // TEST-ONLY E2E hook (scripts/test-indirect-compaction-e2e.ts): force a
    // provider-style context overflow error without burning a real 1M
    // window. Armed via the admin /api/admin/e2e-overflow endpoint (which
    // only exists when E2E_FORCE_OVERFLOW=1, so production can never
    // trigger it). One-shot: the first POST after arming fails with a 400
    // overflow, the daemon compacts and retries cleanly through to the
    // provider. Never remove the env gate.
    if (process.env.E2E_FORCE_OVERFLOW && req.method === "POST" && !route.isModelsList) {
      if ((globalThis as any).__e2eOverflowArmed) {
        (globalThis as any).__e2eOverflowArmed = false;
        console.log(`[e2e-overflow] forced 400 for ${route.upstreamPath}`);
        return envelopeError(
          proto, 400,
          "This model's maximum context length is 48000 tokens. Please reduce the length of the messages.",
          undefined, req,
        );
      }
    }

    if (snap.mode === "router" && route.isModelsList) {
      return registryModelsResponse(req, snap, proto, route.modelId);
    }
    // Passthrough GET /v1/models(:id): forward upstream (the managers that
    // fetch it — codex — require fields upstreams omit: `display_name` per
    // entry and a top-level `models` array). Patched here, never stored.
    if (route.isModelsList && req.method === "GET") {
      return await passthroughModelsList(req, proto, route.modelId);
    }

    // ---- build the failover chain ----
    // Router mode: the model's enabled targets in priority order, each with
    // its provider's keys. Passthrough: enabled providers in priority
    // order, each contributing its keys. Every attempt is a concrete
    // (provider, key, upstreamModel) triple. Nothing is skipped
    // automatically — the chain is only reordered below (sticky winner).
    let candidates: RouteCandidate[];
    let stickyLane: string | null = null;
    if (snap.mode === "router" && req.method === "POST" && bodyJson) {
      const requested = String((bodyJson as any).model);
      const resolution = resolveModelRoute(snap, proto, requested);
      if (!resolution.ok) {
        return envelopeError(proto, resolution.status, resolution.message, resolution.code, req);
      }
      candidates = resolution.candidates;
      routedPublicModel = requested;
      // One sticky lane per public model id + ingress protocol: per-model
      // fallback chains are independent of each other.
      stickyLane = `model:${proto}:${requested}`;
    } else {
      // Passthrough POST: affinity by requested model id (registry-known
      // ids route to their provider first; unknown ids keep stable order).
      const requestedModel = bodyJson && typeof (bodyJson as any).model === "string" ? String((bodyJson as any).model) : undefined;
      candidates = passthroughCandidates(snap, proto, requestedModel);
      // One sticky lane per requested id (or protocol when unmapped):
      // unrelated model ids never share a winner.
      stickyLane = `pass:${proto}:${requestedModel ?? ""}`;
    }
    // Sticky winner FIRST: the candidate that answered this lane last goes
    // to the front (TTL 10min sliding, memory-only). Order only — every
    // candidate is still tried when the winner fails.
    if (stickyLane) {
      const w = stickyGet(stickyLane);
      if (w) {
        const wi = candidates.findIndex(
          (c) => c.provider.row.id === w.providerId && c.key.id === w.keyId &&
            c.upstreamModel === w.upstreamModel && c.via === w.via,
        );
        if (wi > 0) {
          const [win] = candidates.splice(wi, 1);
          candidates.unshift(win!);
        } else if (wi < 0) {
          // Winner no longer exists (key deleted/disabled, target removed,
          // provider capability changed): drop the stale entry so the lane
          // restarts from priority order.
          stickyClear(stickyLane);
        }
      }
    }
    // How many candidates were actually attempted — reported back so the
    // client can see failover happened (`x-gateway-attempts`).
    let attemptsMade = 0;
    if (candidates.length === 0) {
      const hasMatchingProvider = Array.from(snap.providers.values()).some(
        (p) => candidateUsable(p, proto) !== null,
      );
      if (hasMatchingProvider) {
        return envelopeError(
          proto,
          503,
          "no enabled upstream key is configured for this API protocol",
          "api_error",
          req,
        );
      }
      console.error(`[PROXY] no usable upstream candidate for capability "${proto}"`);
      return envelopeError(proto, 503, "gateway is not configured for this API protocol", "api_error", req);
    }
    const wantsStream = (bodyJson as any)?.stream === true;

    // Per-request usage ledger for the client: real upstream figures
    // when present, gateway estimate when the upstream zeroed/omitted
    // (same numbers the gateway records internally). Emitted as a
    // response header on buffered replies and as a terminal SSE comment
    // (`: x-gateway-usage ...`) on streams — comments are ignored by
    // every SSE dialect, so no client parser breaks. Daemon clients
    // prefer this over body usage (see indirect-code-daemon usage).
    // NOTE: headers on a ReadableStream Response are frozen at first
    // byte, so the stream value can only ride the body, not a header.
    const setUsageHeader = (h: Headers, u: UsageResult) => {
      h.set("x-gateway-usage", `in=${u.inTok},cache=${u.cacheTok},out=${u.outTok}`);
    };

    const record = (u: UsageResult, status: number, latencyMs: number, stream: boolean, cand: RouteCandidate) => {
      let inTok = u.inTok;
      let cacheTok = u.cacheTok;
      let estimated = u.estimated;
      // Zero-input guard: upstream said in+cache == 0 on a 2xx with a
      // non-trivial request body (the MuseSpark 400k-context case). The
      // split comes from the btdby4 KV provider (`splitKvInput`): it
      // counts the request with the real BPE engine and simulates a REAL
      // KV cache on the EGRESS side (the provider that answered) — a
      // block-level prefix trie with fork branches, LFU eviction and TTL,
      // keyed by gateway key + provider + provider key + upstream model +
      // egress lane (per-protocol isolation is built into the provider).
      // Always flagged estimated. Nonzero upstream figures never reach
      // this path — they are recorded untouched.
      if (bodyJson && bodyText && status >= 200 && status < 300 && inTok <= 0 && cacheTok <= 0) {
        const namespace =
          `${keyRow.id}\0${cand.provider.row.id}\0${cand.key.id}\0` +
          `${cand.upstreamModel || (routedPublicModel ?? String((bodyJson as any)?.model ?? ""))}`;
        const split = splitKvInput(bodyText, cand.via, namespace);
        if (split.total > 0) {
          inTok = split.inTok;
          cacheTok = split.cacheTok;
          estimated = true;
        }
      }
      recordUsage({
        keyId: keyRow.id,
        userId: keyRow.user_id,
        proto,
        // Router mode bills/attributes under the PUBLIC model id the client
        // asked for (the upstream model id varies per failover target);
        // passthrough keeps the upstream-reported model as before.
        model: routedPublicModel ?? (u.model || String((bodyJson as any)?.model ?? "").slice(0, 128)),
        inTok,
        cacheTok,
        outTok: u.outTok,
        latencyMs,
        status,
        stream,
        estimated,
        // Upstream dimension: which failover candidate actually answered.
        providerId: cand.provider.row.id,
        providerKeyId: cand.key.id,
        upstreamModel: cand.upstreamModel,
      });
      touchKey(keyRow.id, ip);

      // Optimistic total-budget enforcement: the flush lands asynchronously,
      // so we add this request's delta onto the (≤2s stale) cached spend and
      // flip the key to exhausted immediately when crossed. Budgets cap
      // OUTPUT tokens, so only this request's output counts here.
      if (keyRow.total_limit !== null && keyRow.status === "active") {
        const spend = getKeySpend(keyRow.id);
        if (spend.total + u.outTok >= keyRow.total_limit) {
          db.prepare("UPDATE api_keys SET status = 'exhausted' WHERE id = ? AND status = 'active'").run(
            keyRow.id,
          );
          audit("key.exhausted", { target: keyRow.id, meta: { user: keyRow.user_id }, ip });
        }
      }
    };

    // Usage is parsed from the UPSTREAM body shape through the gateway IR:
    // decode the upstream protocol once — the IR carries the canonical
    // (in, cache, out) split with reasoning excluded. No legacy parsers:
    // protocol N+1 only needs its decoder in decodeResponseToIR.
    const parseBufferedUsage = (contentType: string, text: string, _translated: boolean, via: Proto): UsageResult => {
      if (!contentType.includes("application/json")) return { inTok: 0, cacheTok: 0, outTok: 0, model: "", estimated: false };
      try {
        const irr = decodeResponseToIR(via as IRProto, text, "");
        return { inTok: irr.inTok, cacheTok: irr.cacheTok, outTok: irr.outTok, model: irr.model, estimated: irr.usageEstimated };
      } catch {
        return { inTok: 0, cacheTok: 0, outTok: 0, model: "", estimated: true };
      }
    };

    let lastFailure:
      | { kind: "upstream"; status: number; body: string; headers: Headers }
      | { kind: "network"; status: number; timedOut: boolean }
      | null = null;
    // The candidate that last made a fetch attempt — its provider/key/upstream
    // model are attributed to the "all candidates failed" network record.
    let lastAttempted: RouteCandidate | null = null;

    // ---- forward, with failover across the candidate chain ----
    // No-skip policy: every candidate is attempted in order (sticky winner
    // first). Failures only reorder FUTURE requests via the sticky lane —
    // nothing here removes a key from rotation; the client owns backoff
    // and always receives the real upstream error.
    for (const cand of candidates.slice(0, LIMITS.maxFailoverAttempts)) {
      attemptsMade++;
      lastAttempted = cand;
      // Translated candidates serve requests through the provider's
      // other-protocol endpoint (the gateway IR, every direction);
      // everything else is byte-faithful pass-through on its own
      // capability URL.
      const via = cand.via;
      const upstreamProto = via;
      // Trailing "/" would produce "//chat/completions" — new rows are
      // stripped at write time, this covers legacy rows still carrying one.
      const base = (
        via === "openai"
          ? cand.provider.row.openai_base_url
          : via === "responses"
            ? cand.provider.row.responses_base_url
            : cand.provider.row.anthropic_base_url
      )!.replace(/\/+$/, "");
      const breakerId = `${cand.provider.row.id}:${upstreamProto}`;
      if (breakerState(breakerId) === "open") continue;

      // `/messages/count_tokens` has no OpenAI equivalent: answer translated
      // attempts locally from the request-body size estimate.
      if (cand.translated && route.upstreamPath === "/messages/count_tokens" && bodyJson) {
        const h = baseHeaders(req);
        h.set("Content-Type", "application/json; charset=utf-8");
        h.set("x-gateway-attempts", String(attemptsMade));
        if (stickyLane) {
          stickySet(stickyLane, {
            providerId: cand.provider.row.id,
            keyId: cand.key.id,
            upstreamModel: cand.upstreamModel,
            via: cand.via,
          });
        }
        noteProviderKeyOk(cand.key);
        record(
          { inTok: estimateBodyTokens(bodyJson, proto), cacheTok: 0, outTok: 0, model: "", estimated: true },
          200,
          Math.round(performance.now() - started),
          false,
          cand,
        );
        h.set("x-gateway-usage", `in=${estimateBodyTokens(bodyJson, proto)},cache=0,out=0`);
        return new Response(
          JSON.stringify({ input_tokens: estimateBodyTokens(bodyJson, proto) }),
          { status: 200, headers: h },
        );
      }

      // Byte-fidelity rule: the original request bytes go upstream untouched;
      // the only per-attempt mutation is the router-mode model rewrite
      // (each failover target may name the model differently). Translated
      // attempts instead carry the IR-converted body.
      const upstreamPath = cand.translated
        ? via === "anthropic"
          ? "/messages"
          : via === "responses"
            ? "/responses"
            : "/chat/completions"
        : route.upstreamPath;
      // Byte-fidelity rule: the original request bytes go upstream untouched;
      // the only per-attempt mutation is the router-mode model rewrite
      // (each failover target may name the model differently). Translated
      // attempts instead carry the IR-converted body.
      let attemptBody = bodyText;
      if (cand.translated && bodyJson) {
        const withModel =
          cand.upstreamModel && (bodyJson as any).model !== cand.upstreamModel
            ? { ...bodyJson, model: cand.upstreamModel }
            : bodyJson;
        // All translated requests go through the gateway IR: decode the
        // ingress protocol once, encode to the attempt's egress protocol.
        // Same-protocol attempts are translated too (dialects differ).
        try {
          const req43 = withModel as Record<string, unknown>;
          const ir = await decodeToIR(proto as IRProto, req43);
          attemptBody = JSON.stringify(encodeIR(via as IRProto, ir, cand.upstreamModel));
        } catch (e) {
          // Client-caused conversion failure (bad image URL, missing
          // tool_call_id): fail fast as 400 with no failover.
          noteProviderKeyOk(cand.key);
          record(
            { inTok: 0, cacheTok: 0, outTok: 0, model: "", estimated: false },
            400,
            Math.round(performance.now() - started),
            false,
            cand,
          );
          return envelopeError(proto, 400, (e as Error).message || "invalid request", "invalid_request_error", req);
        }
      } else if (bodyJson && cand.upstreamModel && (bodyJson as any).model !== cand.upstreamModel) {
        attemptBody = JSON.stringify({ ...bodyJson, model: cand.upstreamModel });
      }
      // Chat upstreams need the terminal usage chunk for exact accounting.
      if (via === "openai" && upstreamPath === "/chat/completions" && (bodyJson as any)?.stream === true) {
        attemptBody = withChatStreamOptions(attemptBody);
      }
      // Provider-level parameter blocklist (e.g. reasoning-only models that
      // reject `temperature`): drop top-level keys from the final upstream
      // body — native and translated attempts alike.
      attemptBody = stripBlockedParams(attemptBody, cand.provider.row);
      // Universal normalization (the IR pass): EVERY attempt — including
      // same-protocol ("passthrough") ones — is normalized for its TARGET:
      // output-limit key rename, over-long tool-id compaction, narrow-block
      // filtering. Compliant bodies pass through untouched (same bytes), so
      // well-behaved providers see zero change; cross-dialect replays
      // (failover/model-swap, accumulated prefixes) get fixed per target.
      // See server/proxy/target-profile.ts.
      if (bodyJson) {
        try {
          const parsed = JSON.parse(attemptBody) as Record<string, unknown>;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const normalized = normalizeAttemptBody(parsed, {
              openai_base_url: cand.provider.row.openai_base_url,
              anthropic_base_url: cand.provider.row.anthropic_base_url,
              responses_base_url: cand.provider.row.responses_base_url,
              strip_params: cand.provider.row.strip_params,
              via,
              upstreamModel: cand.upstreamModel || (parsed as any).model,
            });
            if (normalized !== parsed) attemptBody = JSON.stringify(normalized);
          }
        } catch {
          // Non-JSON bodies go upstream untouched.
        }
      }

      const upstreamUrl = `${base}${upstreamPath}`;
      const controller = new AbortController();
      const headerTimeout = setTimeout(
        () => controller.abort(new Error("upstream header timeout")),
        wantsStream ? LIMITS.upstreamTimeoutMs : LIMITS.upstreamNonStreamTimeoutMs,
      );
      const onClientAbort = () => controller.abort(new Error("client disconnected"));
      req.signal.addEventListener("abort", onClientAbort, { once: true });

      let upstream: Response;
      try {
        upstream = await fetch(upstreamUrl, {
          method: req.method,
          headers: buildUpstreamHeaders(
            req,
            upstreamProto,
            cand.key.key,
            upstreamProto === "openai"
              ? cand.provider.row.openai_auth_style
              : upstreamProto === "responses"
                ? cand.provider.row.responses_auth_style
                : cand.provider.row.anthropic_auth_style,
          ),
          body: req.method === "POST" ? attemptBody : undefined,
          signal: controller.signal,
        });
        clearTimeout(headerTimeout);
      } catch (e) {
        clearTimeout(headerTimeout);
        req.signal.removeEventListener("abort", onClientAbort);
        const clientDisconnected = req.signal.aborted;
        const timedOut = controller.signal.aborted && !clientDisconnected;
        // A client giving up on us (short timeout, rage-quit) must NOT trip
        // the breaker nor the key's fail counter — otherwise a few
        // disconnects would 503 the whole gateway for every user. Only
        // genuine upstream network failures and OUR header timeout count as
        // provider trouble.
        if (!clientDisconnected) {
          breakerFail(breakerId);
          noteProviderKeyFailure(cand.key, "transient");
          console.error(`[PROXY] upstream fetch failed (${upstreamUrl}):`, (e as Error).name);
          lastFailure = { kind: "network", status: timedOut ? 504 : 502, timedOut };
          continue;
        }
        // The client is gone; running cheaper candidates serves nobody.
        lastFailure = { kind: "network", status: timedOut ? 504 : 502, timedOut };
        break;
      }
      req.signal.removeEventListener("abort", onClientAbort);

      // Only infrastructure-level failures count toward the circuit breaker;
      // a 4xx from upstream is just the client's request being rejected there.
      if (upstream.status >= 500 || upstream.status === 429) breakerFail(breakerId);
      else breakerOk(breakerId);

      if (upstream.status >= 400) {
        // Failover happens BEFORE a single byte reaches the client: consume
        // the (capped) error body, classify it, then either move to the
        // next candidate or deliver the error untouched. Failures are only
        // recorded (audit + visible counter) — the key stays in rotation
        // and the client owns backoff (it gets the real error + Retry-After).
        const peekTimeout = setTimeout(
          () => controller.abort(new Error("error peek timeout")),
          LIMITS.upstreamNonStreamTimeoutMs,
        );
        let errBody = "";
        try {
          errBody = await readBodyCapped(upstream, LIMITS.upstreamErrorPeekBytes);
        } catch {
          /* classified with an empty peek */
        }
        clearTimeout(peekTimeout);

        if (req.signal.aborted) {
          lastFailure = { kind: "upstream", status: upstream.status, body: errBody, headers: upstream.headers };
          break;
        }
        const cls = classifyHttpError(upstream.status, errBody);
        if (cls === "model_not_found") {
          lastFailure = { kind: "upstream", status: upstream.status, body: errBody, headers: upstream.headers };
          continue;
        }
        if (cls) {
          // Fail-able (billing/auth/rate_limit/transient): record it and
          // try the next candidate in THIS request. The key is NOT removed
          // from rotation — the next request still tries everyone (sticky
          // winner first).
          noteProviderKeyFailure(cand.key, cls);
          lastFailure = { kind: "upstream", status: upstream.status, body: errBody, headers: upstream.headers };
          continue;
        }
        // Client-caused rejection (bad request, too large, ...): every other
        // candidate would answer the same — deliver as-is, no failover. The
        // key itself clearly works, so its visible failure counter resets.
        // Translated attempts are re-enveloped so the client still sees the
        // protocol it asked for.
        noteProviderKeyOk(cand.key);
        const ct = upstream.headers.get("content-type") || "";
        const clientErrUsage = parseBufferedUsage(ct, errBody, cand.translated, cand.via);
        record(
          clientErrUsage,
          upstream.status,
          Math.round(performance.now() - started),
          false,
          cand,
        );
        const errOut = reEnvelopeError(proto, cand.via, upstream.status, errBody);
        const errHeaders = buildClientHeaders(upstream.headers, requestId, req, { attemptsMade });
        setUsageHeader(errHeaders, clientErrUsage);
        return new Response(errOut, {
          status: upstream.status,
          headers: errHeaders,
        });
      }

      // ---- success: deliver this candidate's response ----
      noteProviderKeyOk(cand.key);
      if (stickyLane) {
        // This candidate answered: future requests on this lane try it
        // first (TTL sliding). Streams set it now, at first byte — the
        // winner proved reachable; mid-stream failures can't fail over
        // anyway (headers already sent).
        stickySet(stickyLane, {
          providerId: cand.provider.row.id,
          keyId: cand.key.id,
          upstreamModel: cand.upstreamModel,
          via: cand.via,
        });
      }
      const contentType = upstream.headers.get("content-type") || "";
      const isSse = contentType.includes("text/event-stream");
      const clientHeaders = buildClientHeaders(upstream.headers, requestId, req, { attemptsMade });

      // ---- streaming relay ----
      if (isSse && upstream.body) {
        // The concurrency slot stays held until the stream really ends below —
        // the outer finally must not free it when we hand back the Response.
        slotHeldByStream = true;

        // EVERY stream — native or translated — flows through the generic IR
        // stream translator (any upstream SSE -> any client SSE). No legacy
        // passthrough meter: same-protocol dialects still differ (usage
        // shapes, reasoning fields), so the translator normalizes those too.
        // Usage comes from the translator (terminal chunk), with the
        // request-body estimate as the input fallback.
        const modelName = routedPublicModel ?? String((bodyJson as any)?.model ?? "");
        const translator = new IRStreamTranslator(cand.via as IRProto, proto as IRProto, modelName, dsmlTools);
        let counted = false;
        // The finalized usage, once known — queued into the stream tail as
        // a terminal `: x-gateway-usage` comment (see pull() below).
        let finalUsage: UsageResult | null = null;
        let usageTailSent = false;
        const finalize = (status: number) => {
          if (counted) return;
          counted = true;
          const u = translator.result();
          if (u.estimated && bodyJson) u.inTok = estimateBodyTokens(bodyJson, proto);
          finalUsage = u;
          record(u, status, Math.round(performance.now() - started), true, cand);
        };
        const usageComment = (): Uint8Array | null => {
          if (!finalUsage || usageTailSent) return null;
          usageTailSent = true;
          const u = finalUsage;
          return new TextEncoder().encode(`: x-gateway-usage in=${u.inTok},cache=${u.cacheTok},out=${u.outTok}\n\n`);
        };

        const idleLimit = LIMITS.proxyStreamIdleMs;
        let idleTimer: Timer | null = null;
        const resetIdle = (cancel?: boolean) => {
          if (idleTimer) clearTimeout(idleTimer);
          if (!cancel) {
            idleTimer = setTimeout(() => {
              controller.abort(new Error("upstream idle timeout"));
            }, idleLimit);
            idleTimer.unref?.();
          }
        };
        resetIdle();

        const reader = upstream.body.getReader();
        const onClientAbortStream = () => reader.cancel().catch(() => {});
        req.signal.addEventListener("abort", onClientAbortStream, { once: true });

        const cleanup = () => {
          resetIdle(true);
          req.signal.removeEventListener("abort", onClientAbortStream);
          release();
        };
        const closeSink = (sink: ReadableStreamDefaultController<Uint8Array>) => {
          try {
            sink.close();
          } catch {
            /* already closed/errored */
          }
        };

        const stream = new ReadableStream<Uint8Array>({
          // Pull-driven relay: we read from upstream ONLY when the client socket
          // has drained. A slow consumer therefore slows the upstream read too
          // (true pass-through pacing) and memory stays bounded by in-flight
          // chunks — never by the whole response.
          async pull(sink) {
            try {
              const { done, value } = await reader.read();
              if (done) {
                try {
                  for (const piece of translator.flush()) sink.enqueue(piece);
                } catch {
                  /* terminal flush is best-effort */
                }
                finalize(req.signal.aborted ? 499 : upstream.status);
                const tail = usageComment();
                if (tail) sink.enqueue(tail);
                cleanup();
                closeSink(sink);
                return;
              }
              if (value && value.length) {
                resetIdle();
                let emitted = 0;
                for (const piece of translator.feed(value)) {
                  sink.enqueue(piece);
                  emitted++;
                }
                if (translator.isDone) {
                  // Terminal chunk arrived inside this batch: usage is
                  // final — emit it right after (before any later
                  // keepalive/close logic) so it can never be dropped.
                  finalize(upstream.status);
                  const tail = usageComment();
                  if (tail) {
                    sink.enqueue(tail);
                    emitted++;
                  }
                }
                if (emitted === 0 && !translator.isDone) {
                  // Bun.serve stops pulling a response stream whose pulls
                  // enqueue nothing, which would starve the upstream read
                  // while the translator is still buffering (e.g. long
                  // reasoning head with no client-visible events yet).
                  // An SSE comment keeps the pump alive and is ignored by
                  // every SSE client dialect.
                  sink.enqueue(SSE_KEEPALIVE);
                }
                if (translator.isDone) {
                  finalize(upstream.status);
                  const tail = usageComment();
                  if (tail) sink.enqueue(tail);
                  cleanup();
                  closeSink(sink);
                  reader.cancel().catch(() => {});
                  return;
                }
              }
            } catch {
              finalize(req.signal.aborted ? 499 : 502);
              cleanup();
              closeSink(sink);
            }
          },
          cancel() {
            reader.cancel().catch(() => {});
            finalize(499);
            cleanup();
          },
        });

        return new Response(stream, { status: upstream.status, headers: clientHeaders });
      }

      // ---- buffered relay ----
      if (!upstream.body) return new Response(null, { status: upstream.status, headers: clientHeaders });
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      const chunks: Uint8Array[] = [];
      let total = 0;
      const bodyTimeout = setTimeout(() => controller.abort(new Error("upstream body timeout")), LIMITS.upstreamNonStreamTimeoutMs);
      const onBodyAbort = () => controller.abort(new Error("client disconnected"));
      req.signal.addEventListener("abort", onBodyAbort, { once: true });
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            total += value.byteLength;
            if (total > MAX_BUFFERED_UPSTREAM_BYTES) {
              await reader.cancel().catch(() => {});
              return envelopeError(proto, 502, "upstream response too large", "api_error", req);
            }
            chunks.push(value);
          }
        }
      } catch {
        if (req.signal.aborted) return envelopeError(proto, 499, "client disconnected", "api_error", req);
        return envelopeError(proto, 502, "upstream response failed", "api_error", req);
      } finally {
        clearTimeout(bodyTimeout);
        req.signal.removeEventListener("abort", onBodyAbort);
        await reader.cancel().catch(() => {});
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      const respText = decoder.decode(body);
      const bufferedUsage = parseBufferedUsage(contentType, respText, cand.translated, cand.via);
      record(
        bufferedUsage,
        upstream.status,
        Math.round(performance.now() - started),
        false,
        cand,
      );
      setUsageHeader(clientHeaders, bufferedUsage);

      if (cand.translated) {
        const modelName = routedPublicModel ?? String((bodyJson as any)?.model ?? "");
        // All translated buffered responses go through the gateway IR:
        // decode the upstream protocol once, encode to the client protocol.
        // Adding protocol N+1 only needs one decoder + one encoder here.
        // No legacy fallback: a body the IR cannot parse is a gateway bug —
        // surface it loudly (502) instead of silently serving a wrong shape.
        let converted: string;
        let translatedUsage: UsageResult;
        try {
          const irr = decodeResponseToIR(cand.via as IRProto, respText, modelName);
          // DSML tool-call recovery (DeepSeek V4 markup leaking into content):
          // recovered calls join the IR tool uses, the markup is stripped.
          const recovered = extractDsmlToolCalls(irr.text, dsmlTools);
          if (recovered.changed) {
            irr.text = recovered.text;
            if (recovered.calls.length) {
              irr.toolUses = [
                ...irr.toolUses,
                ...recovered.calls.map((c) => ({ id: c.id, name: c.name, input: c.input })),
              ];
              if (irr.finish === "stop") irr.finish = "tool_calls";
            }
          }
          converted = encodeResponseFromIR(proto as IRProto, irr, modelName);
          translatedUsage = {
            inTok: irr.inTok, cacheTok: irr.cacheTok, outTok: irr.outTok,
            model: irr.model, estimated: irr.usageEstimated,
          };
        } catch (e) {
          record(
            { inTok: 0, cacheTok: 0, outTok: 0, model: modelName, estimated: true },
            502,
            Math.round(performance.now() - started),
            false,
            cand,
          );
          return envelopeError(proto, 502, `translation failure: ${(e as Error).message || "unparseable upstream body"}`, "api_error", req);
        }
        const h = buildClientHeaders(upstream.headers, requestId, req, { attemptsMade });
        h.set("Content-Type", "application/json; charset=utf-8");
        setUsageHeader(h, translatedUsage!);
        return new Response(converted, { status: upstream.status, headers: h });
      }
      // Same-protocol pass-through: bytes stay untouched unless DSML
      // recovery actually rewrote the body (then it is re-serialized).
      const patched = patchRawResponseDsml(cand.via as IRProto, respText, dsmlTools);
      return new Response(patched ?? respText, { status: upstream.status, headers: clientHeaders });
    }

    // ---- every candidate failed ----
    // No-skip policy: with nothing skipped, the only way here with zero
    // attempts is an open circuit breaker on every candidate's lane. The
    // client still gets the last real upstream error when there is one.
    const finalLatency = Math.round(performance.now() - started);
    if (stickyLane && attemptsMade > 0) {
      // Nothing answered: never pin the lane to a dead winner — the next
      // request restarts from priority order.
      stickyClear(stickyLane);
    }
    if (lastFailure?.kind === "upstream") {
      // Deliver the most recent UPSTREAM error (sanitized headers as always):
      // clients want the real cause (e.g. insufficient_quota), not a 503.
      // Translated failures are re-enveloped to the requested protocol.
      const f = lastFailure;
      const wasTranslated = lastAttempted?.translated ?? false;
      const failUsage = parseBufferedUsage(f.headers.get("content-type") || "", f.body, wasTranslated, lastAttempted!.via);
      record(
        failUsage,
        f.status,
        finalLatency,
        false,
        lastAttempted!,
      );
      const outBody = reEnvelopeError(proto, lastAttempted!.via, f.status, f.body);
      const failHeaders = buildClientHeaders(f.headers, requestId, req, { attemptsMade });
      setUsageHeader(failHeaders, failUsage);
      return new Response(outBody, { status: f.status, headers: failHeaders });
    }
    if (lastFailure?.kind === "network") {
      recordUsage({
        keyId: keyRow.id, userId: keyRow.user_id, proto, model: routedPublicModel ?? "",
        inTok: 0, cacheTok: 0, outTok: 0, latencyMs: finalLatency,
        status: req.signal.aborted ? 499 : lastFailure.status, stream: wantsStream, estimated: false,
        providerId: lastAttempted?.provider.row.id ?? "",
        providerKeyId: lastAttempted?.key.id ?? "",
        upstreamModel: lastAttempted?.upstreamModel ?? "",
      });
      return envelopeError(
        proto,
        lastFailure.status,
        lastFailure.timedOut ? "upstream took too long to respond" : "upstream is unreachable",
        "api_error",
      );
    }
    // No attempts reached an upstream at all (every candidate lane is
    // circuit-broken right now). This is the ONLY path that still 503s:
    // a provider-side storm guard, not key state.
    return envelopeError(
      proto,
      503,
      "no upstream candidate is currently reachable (providers circuit-broken)",
      "api_error",
      req,
    );
  } finally {
    if (!slotHeldByStream) release();
    if (usageFlushDue()) flushUsage();
  }
}

const lastTouchByKey = new Map<string, number>();
function touchKey(keyId: string, ip: string): void {
  // Throttle the per-request bookkeeping UPDATE to ~1/min/key. The throttle
  // clock is PER KEY — a global clock would starve every other key's
  // last_used_at while any single key stays busy.
  const now = Date.now();
  const last = lastTouchByKey.get(keyId) ?? 0;
  if (now - last < 60_000) return;
  if (lastTouchByKey.size > 10_000) lastTouchByKey.clear(); // bounded map
  lastTouchByKey.set(keyId, now);
  db.prepare("UPDATE api_keys SET last_used_at = ?, last_used_ip = ? WHERE id = ?").run(
    now,
    ip.slice(0, 64),
    keyId,
  );
}

let lastFlushCheck = 0;
function usageFlushDue(): boolean {
  const now = Date.now();
  if (now - lastFlushCheck > 5_000) {
    lastFlushCheck = now;
    return true;
  }
  return false;
}
