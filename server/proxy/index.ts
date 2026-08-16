import { LIMITS } from "../config";
import { stmts, audit, type ApiKeyRow, type AuthStyle } from "../db";
import { randomToken, sha256Hex } from "../crypto";
import { clientIp, baseHeaders } from "../http";
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
  type RouterSnapshot,
  type RouteCandidate,
  type RoutedKey,
} from "../models";
import {
  classifyHttpError,
  billingCooldownUntil,
  nextCooldown,
  keyBlockedNow,
  liveKeyBlock,
  liveKeyClear,
  type FailClass,
} from "../failover";

/**
 * The gateway itself: OpenAI- and Anthropic-compatible pass-through proxy.
 *
 *   client --(gw_ key)--> this --(real key)--> configured upstream provider
 *
 * Guarantees: authN/Z per request, budget/rate/concurrency enforcement,
 * streaming with incremental usage parsing, sanitized failures, and usage
 * accounting per key/user — including client aborts.
 */

type Proto = "openai" | "anthropic";

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
  if (proto === "openai") {
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

// ===== Failover bookkeeping (per-provider-key state) =====

const qKeyFailCount = db.prepare<{ fail_count: number }, [string]>(
  "SELECT fail_count FROM provider_keys WHERE id = ?",
);
const qKeyExhaust = db.prepare(
  "UPDATE provider_keys SET status = 'exhausted', exhausted_reason = ?, cooldown_until = ?, fail_count = 0, updated_at = ? WHERE id = ?",
);
const qKeyTrack = db.prepare(
  "UPDATE provider_keys SET fail_count = ?, cooldown_until = ?, updated_at = ? WHERE id = ?",
);
const qKeyReset = db.prepare(
  "UPDATE provider_keys SET fail_count = 0, cooldown_until = NULL, updated_at = ? WHERE id = ? AND (fail_count != 0 OR cooldown_until IS NOT NULL)",
);

/** A key proved unusable: billing/auth → exhausted (billing auto-retries at
 *  the next UTC midnight, when daily free tiers refill; auth waits for a
 *  manual re-enable). Transient and rate-limit failures only bump a
 *  consecutive-failure counter that escalates to an exponential cooldown
 *  from LIMITS.providerFailThreshold — intermittent blips never escalate
 *  because any success resets the counter. */
function markProviderKeyFailure(key: RoutedKey, cls: FailClass): void {
  const now = Date.now();
  if (cls === "billing" || cls === "auth") {
    const until = cls === "billing" ? billingCooldownUntil(now) : null;
    qKeyExhaust.run(cls, until, now, key.id);
    liveKeyBlock(key.id, until);
    audit("provider_key.exhausted", {
      target: key.id,
      meta: { reason: cls, label: key.label, retryAt: until },
    });
    console.warn(`[PROXY] upstream key exhausted (${cls}): ${key.label || key.id}`);
    return;
  }
  const fails = (qKeyFailCount.get(key.id)?.fail_count ?? 0) + 1;
  const until = nextCooldown(fails);
  qKeyTrack.run(fails, until, now, key.id);
  if (until !== null) {
    liveKeyBlock(key.id, until);
    console.warn(
      `[PROXY] upstream key ${key.label || key.id} cooling down until ${new Date(until).toISOString()} (${fails} consecutive failures)`,
    );
  }
}

/** Healthy response: reset the transient-failure counters (the conditional
 *  UPDATE keeps the common path write-free). */
function markProviderKeyOk(key: RoutedKey): void {
  liveKeyClear(key.id);
  qKeyReset.run(Date.now(), key.id);
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

function safeResponseContentType(upstream: Headers): string {
  const raw = upstream.get("content-type") || "";
  const mime = raw.split(";")[0]!.trim().toLowerCase();
  return SAFE_RES_CT.has(mime) ? raw : "application/json; charset=utf-8";
}

function buildClientHeaders(upstream: Headers, requestId: string): Headers {
  const h = baseHeaders();
  // Even if unsafe content slips through, it can never execute as a document.
  h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  upstream.forEach((value, name) => {
    if (STRIP_RES_HEADERS.has(name.toLowerCase())) return;
    h.set(name, value);
  });
  h.set("Content-Type", safeResponseContentType(upstream));
  h.set("X-Request-Id", requestId);
  return h;
}

/**
 * Router-mode `/v1/models`: answered from the local registry (rich format),
 * never forwarded upstream. Only servable models are listed (enabled, with an
 * enabled provider exposing this protocol's capability).
 */
function registryModelsResponse(
  req: Request,
  snap: RouterSnapshot,
  proto: Proto,
  modelId?: string,
): Response {
  const rows = listableModels(snap, proto);
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
  return new Response(
    JSON.stringify({ data: rows.map((m) => publicModelEntry(m, providerName(m))) }),
    { headers: h },
  );
}

// ===== Token estimation fallback =====

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

// ===== Usage parsing =====

interface UsageResult {
  inTok: number;
  cacheTok: number;
  outTok: number;
  model: string;
  estimated: boolean;
}

/**
 * Providers bill three token categories: uncached input, cached input (at a
 * steep discount) and output — so the gateway tracks all three separately.
 * OpenAI reports cached hits INSIDE prompt_tokens (split them apart here);
 * Anthropic's input_tokens is already cache-free and its cache_read/cache_
 * creation fields make up the cached bucket.
 */
function splitPrompt(prompt: unknown, details: unknown): { inTok: number; cacheTok: number } {
  const p = Number(prompt ?? 0) || 0;
  const cacheTok = Math.max(0, Number((details as any)?.cached_tokens ?? 0) || 0);
  return { inTok: Math.max(0, p - cacheTok), cacheTok };
}

/** Anthropic cached bucket: cache reads plus cache writes (creation). */
function anthropicCacheTok(usage: any): number {
  return (
    (Number(usage?.cache_read_input_tokens ?? 0) || 0) +
    (Number(usage?.cache_creation_input_tokens ?? 0) || 0)
  );
}

function parseOpenAiJson(bodyText: string): UsageResult {
  try {
    const j = JSON.parse(bodyText);
    const usage = j.usage;
    return {
      ...splitPrompt(usage?.prompt_tokens, usage?.prompt_tokens_details),
      outTok: Number(usage?.completion_tokens ?? 0),
      model: typeof j.model === "string" ? j.model : "",
      estimated: !usage,
    };
  } catch {
    return { inTok: 0, cacheTok: 0, outTok: 0, model: "", estimated: true };
  }
}

function parseAnthropicJson(bodyText: string): UsageResult {
  try {
    const j = JSON.parse(bodyText);
    const usage = j.usage;
    if (j.type === "error") return { inTok: 0, cacheTok: 0, outTok: 0, model: "", estimated: false };
    // /messages/count_tokens returns { input_tokens } at the top level.
    if (typeof j.input_tokens === "number") {
      return { inTok: j.input_tokens, cacheTok: 0, outTok: 0, model: "", estimated: false };
    }
    // usage.input_tokens excludes cache hits per the Anthropic spec;
    // cache_read + cache_creation make up the cached bucket.
    return {
      inTok: Number(usage?.input_tokens ?? 0),
      cacheTok: anthropicCacheTok(usage),
      outTok: Number(usage?.output_tokens ?? 0),
      model: typeof j.model === "string" ? j.model : "",
      estimated: !usage,
    };
  } catch {
    return { inTok: 0, cacheTok: 0, outTok: 0, model: "", estimated: true };
  }
}

/**
 * Tee a passthrough SSE stream: every chunk is forwarded untouched while an
 * incremental line parser extracts usage figures and (fallback) output text
 * length. Memory stays O(longest event line), not O(response size).
 */
class StreamMeter {
  private pending = "";
  private decoder = new TextDecoder();
  private currentEvent = "";
  outChars = 0;
  inTok = 0;
  cacheTok = 0;
  outTok = 0;
  model = "";
  sawUsage = false;

  constructor(private proto: Proto) {}

  feed(chunk: Uint8Array): void {
    this.pending += this.decoder.decode(chunk, { stream: true });
    for (;;) {
      const idx = this.pending.indexOf("\n");
      if (idx === -1) break;
      const line = this.pending.slice(0, idx);
      this.pending = this.pending.slice(idx + 1);
      this.processLine(line);
    }
  }

  private processLine(rawLine: string): void {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith("event:")) {
      this.currentEvent = line.slice(6).trim();
      return;
    }
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;

    if (this.proto === "openai") {
      // Only parse JSON when the line hints at usage or text (cheap pre-filter).
      if (!data.includes('"usage"') && !data.includes('"content"') && !data.includes('"model"')) return;
      try {
        const j = JSON.parse(data);
        if (j.usage) {
          if (j.usage.prompt_tokens !== undefined) {
            const s = splitPrompt(j.usage.prompt_tokens, j.usage.prompt_tokens_details);
            this.inTok = s.inTok;
            this.cacheTok = s.cacheTok;
          }
          this.outTok = Number(j.usage.completion_tokens ?? this.outTok) || this.outTok;
          this.sawUsage = true;
        }
        if (typeof j.model === "string" && j.model && !this.model) this.model = j.model;
        const choices = j.choices;
        if (Array.isArray(choices)) {
          for (const c of choices) {
            const delta = c?.delta?.content;
            if (typeof delta === "string") this.outChars += delta.length;
            const text = c?.text; // legacy completions
            if (typeof text === "string") this.outChars += text.length;
          }
        }
      } catch {
        /* partial JSON across lines is impossible per SSE spec; ignore bad lines */
      }
      return;
    }

    // anthropic
    if (this.currentEvent === "message_start") {
      try {
        const j = JSON.parse(data);
        const usage = j?.message?.usage;
        if (usage) {
          this.inTok = Number(usage.input_tokens ?? 0);
          this.cacheTok = anthropicCacheTok(usage);
          this.sawUsage = true;
        }
        if (typeof j?.message?.model === "string" && !this.model) this.model = j.message.model;
      } catch {}
      return;
    }
    if (this.currentEvent === "message_delta") {
      try {
        const j = JSON.parse(data);
        if (j?.usage?.output_tokens !== undefined) {
          this.outTok = Number(j.usage.output_tokens) || this.outTok;
          this.sawUsage = true;
        }
        // Some providers re-report cache counters here; keep the latest.
        const ct = anthropicCacheTok(j?.usage);
        if (ct > 0) this.cacheTok = ct;
      } catch {}
      return;
    }
    if (this.currentEvent === "content_block_delta" && data.includes('"text_delta"')) {
      try {
        const j = JSON.parse(data);
        if (j?.delta?.type === "text_delta" && typeof j.delta.text === "string") {
          this.outChars += j.delta.text.length;
        }
      } catch {}
    }
  }

  result(bodyBytesSent: number): UsageResult {
    if (this.sawUsage && (this.inTok > 0 || this.outTok > 0 || this.cacheTok > 0)) {
      return { inTok: this.inTok, cacheTok: this.cacheTok, outTok: this.outTok, model: this.model, estimated: false };
    }
    return {
      inTok: 0, // input estimate comes from request-body size at call site
      cacheTok: 0,
      outTok: this.outChars > 0 ? estimateTokens(String(this.outChars)) : 0,
      model: this.model,
      estimated: true,
    };
  }
}

// ===== Main handler =====

export async function handleProxy(req: Request, url: URL, server: any): Promise<Response> {
  const { match: route, hint } = matchRoute(url.pathname, req.method, req);
  if (!route) {
    return envelopeError(hint, 404, "unknown endpoint", "invalid_request_error", req);
  }
  const proto = route.proto;
  const ip = clientIp(req, server);

  // ---- authenticate the gateway API key ----
  let token = "";
  const authz = req.headers.get("authorization");
  if (proto === "openai") {
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

    // ---- model registry (routing mode + router-backed /v1/models) ----
    const snap = await routerSnapshot();
    let routedPublicModel: string | null = null;
    let bodyDirty = false;

    if (snap.mode === "router" && route.isModelsList) {
      return registryModelsResponse(req, snap, proto, route.modelId);
    }

    // OpenAI streams: ask upstream to include a terminal usage chunk so
    // accounting stays exact (Anthropic always streams usage events). This
    // and the router-mode per-attempt model rewrite are the ONLY fields we
    // ever mutate, and only when needed — otherwise the original bytes are
    // forwarded untouched.
    if (
      bodyJson &&
      proto === "openai" &&
      (bodyJson as any).stream === true &&
      route.upstreamPath === "/chat/completions"
    ) {
      const so = ((bodyJson as any).stream_options ?? {}) as Record<string, unknown>;
      if (so.include_usage !== true) {
        so.include_usage = true;
        (bodyJson as any).stream_options = so;
        bodyDirty = true;
      }
    }

    // ---- build the failover chain ----
    // Router mode: the model's enabled targets in priority order, each with
    // its provider's usable keys. Passthrough: enabled providers in priority
    // order, each contributing its usable keys. Every attempt is a concrete
    // (provider, key, upstreamModel) triple.
    let candidates: RouteCandidate[];
    if (snap.mode === "router" && req.method === "POST" && bodyJson) {
      const requested = String((bodyJson as any).model);
      const resolution = resolveModelRoute(snap, proto, requested);
      if (!resolution.ok) {
        return envelopeError(proto, resolution.status, resolution.message, resolution.code, req);
      }
      candidates = resolution.candidates;
      routedPublicModel = requested;
    } else {
      candidates = passthroughCandidates(snap, proto);
    }
    if (candidates.length === 0) {
      console.error(`[PROXY] no usable upstream candidate for capability "${proto}"`);
      return envelopeError(proto, 503, "gateway is not configured for this API protocol", "api_error", req);
    }
    if (bodyDirty && bodyJson) bodyText = JSON.stringify(bodyJson);

    const wantsStream = (bodyJson as any)?.stream === true;

    const record = (u: UsageResult, status: number, latencyMs: number, stream: boolean) => {
      let inTok = u.inTok;
      if (u.estimated && bodyJson) {
        inTok = estimateTokens(bodyText);
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
        cacheTok: u.cacheTok,
        outTok: u.outTok,
        latencyMs,
        status,
        stream,
        estimated: u.estimated,
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

    const parseBufferedUsage = (contentType: string, text: string): UsageResult =>
      contentType.includes("application/json")
        ? proto === "openai"
          ? parseOpenAiJson(text)
          : parseAnthropicJson(text)
        : { inTok: 0, cacheTok: 0, outTok: 0, model: "", estimated: false };

    let lastFailure:
      | { kind: "upstream"; status: number; body: string; headers: Headers }
      | { kind: "network"; status: number; timedOut: boolean }
      | null = null;

    // ---- forward, with failover across the candidate chain ----
    for (const cand of candidates.slice(0, LIMITS.maxFailoverAttempts)) {
      if (keyBlockedNow(cand.key.id)) continue;
      // Trailing "/" would produce "//chat/completions" — new rows are
      // stripped at write time, this covers legacy rows still carrying one.
      const base = (proto === "openai" ? cand.provider.row.openai_base_url : cand.provider.row.anthropic_base_url)!
        .replace(/\/+$/, "");
      const breakerId = `${cand.provider.row.id}:${proto}`;
      if (breakerState(breakerId) === "open") continue;

      // Byte-fidelity rule: the original request bytes go upstream untouched;
      // the only per-attempt mutation is the router-mode model rewrite
      // (each failover target may name the model differently).
      let attemptBody = bodyText;
      if (bodyJson && cand.upstreamModel && (bodyJson as any).model !== cand.upstreamModel) {
        attemptBody = JSON.stringify({ ...bodyJson, model: cand.upstreamModel });
      }

      const upstreamUrl = `${base}${route.upstreamPath}`;
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
            proto,
            cand.key.key,
            proto === "openai" ? cand.provider.row.openai_auth_style : cand.provider.row.anthropic_auth_style,
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
          markProviderKeyFailure(cand.key, "transient");
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
        // the (capped) error body, classify it, then either mark this key
        // and move to the next candidate, or deliver the error untouched.
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
        if (cls) {
          markProviderKeyFailure(cand.key, cls);
          lastFailure = { kind: "upstream", status: upstream.status, body: errBody, headers: upstream.headers };
          continue;
        }
        // Client-caused rejection (bad request, too large, ...): every other
        // candidate would answer the same — deliver as-is, no failover. The
        // key itself clearly works, so its transient counters reset.
        markProviderKeyOk(cand.key);
        const ct = upstream.headers.get("content-type") || "";
        record(parseBufferedUsage(ct, errBody), upstream.status, Math.round(performance.now() - started), false);
        return new Response(errBody, {
          status: upstream.status,
          headers: buildClientHeaders(upstream.headers, requestId),
        });
      }

      // ---- success: deliver this candidate's response ----
      markProviderKeyOk(cand.key);
      const contentType = upstream.headers.get("content-type") || "";
      const isSse = contentType.includes("text/event-stream");
      const clientHeaders = buildClientHeaders(upstream.headers, requestId);

      // ---- streaming relay ----
      if (isSse && upstream.body) {
        // The concurrency slot stays held until the stream really ends below —
        // the outer finally must not free it when we hand back the Response.
        slotHeldByStream = true;

        const meter = new StreamMeter(proto);
        let counted = false;
        const finalize = (status: number) => {
          if (counted) return;
          counted = true;
          record(meter.result(0), status, Math.round(performance.now() - started), true);
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
                finalize(req.signal.aborted ? 499 : upstream.status);
                cleanup();
                closeSink(sink);
                return;
              }
              if (value && value.length) {
                resetIdle();
                meter.feed(value); // stats only — the chunk itself goes out as-is
                sink.enqueue(value);
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
      const respText = await upstream.text();
      record(parseBufferedUsage(contentType, respText), upstream.status, Math.round(performance.now() - started), false);

      return new Response(respText, { status: upstream.status, headers: clientHeaders });
    }

    // ---- every candidate failed (or was skipped) ----
    const finalLatency = Math.round(performance.now() - started);
    if (lastFailure?.kind === "upstream") {
      // Deliver the most recent UPSTREAM error (sanitized headers as always):
      // clients want the real cause (e.g. insufficient_quota), not a 503.
      const f = lastFailure;
      record(parseBufferedUsage(f.headers.get("content-type") || "", f.body), f.status, finalLatency, false);
      return new Response(f.body, { status: f.status, headers: buildClientHeaders(f.headers, requestId) });
    }
    if (lastFailure?.kind === "network") {
      recordUsage({
        keyId: keyRow.id, userId: keyRow.user_id, proto, model: routedPublicModel ?? "",
        inTok: 0, cacheTok: 0, outTok: 0, latencyMs: finalLatency,
        status: req.signal.aborted ? 499 : lastFailure.status, stream: wantsStream, estimated: false,
      });
      return envelopeError(
        proto,
        lastFailure.status,
        lastFailure.timedOut ? "upstream took too long to respond" : "upstream is unreachable",
        "api_error",
      );
    }
    // Every candidate was skipped (cooling-down keys / open breakers).
    return envelopeError(
      proto,
      503,
      "no upstream candidate is currently available (keys cooling down or providers circuit-broken)",
      "api_error",
      req,
    );
  } finally {
    if (!slotHeldByStream) release();
    if (usageFlushDue()) flushUsage();
  }
}

let lastTouch = 0;
function touchKey(keyId: string, ip: string): void {
  // Throttle the per-request bookkeeping UPDATE to ~1/min/key.
  const now = Date.now();
  if (now - lastTouch < 60_000) return;
  lastTouch = now;
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
