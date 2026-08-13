import { LIMITS } from "../config";
import { stmts, audit, type ApiKeyRow, type ProviderRow, type AuthStyle } from "../db";
import { decryptSecret, randomToken, sha256Hex } from "../crypto";
import { GATEWAY_SECRET } from "../config";
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
    if (forced) return { match: { proto: forced, upstreamPath: p.slice(3) }, hint };
    if (req.headers.get("x-api-key")) {
      return { match: { proto: "anthropic", upstreamPath: p.slice(3) }, hint: "anthropic" };
    }
    if (req.headers.get("authorization")) {
      return { match: { proto: "openai", upstreamPath: p.slice(3) }, hint };
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

// ===== Provider resolution (cached 5s) =====

interface ResolvedProviders {
  openai?: { row: ProviderRow; key: string };
  anthropic?: { row: ProviderRow; key: string };
  fetchedAt: number;
}

let providerCache: ResolvedProviders | null = null;
let providerCachePromise: Promise<ResolvedProviders> | null = null;

async function resolveProviders(): Promise<ResolvedProviders> {
  const now = Date.now();
  if (providerCache && now - providerCache.fetchedAt < 5_000) return providerCache;
  if (providerCachePromise) return providerCachePromise;

  providerCachePromise = (async () => {
    const rows = db
      .prepare<ProviderRow, []>(
        "SELECT * FROM providers WHERE enabled = 1 ORDER BY priority ASC, created_at ASC",
      )
      .all();
    const resolved: ResolvedProviders = { fetchedAt: Date.now() };
    for (const row of rows) {
      if (row.openai_base_url && !resolved.openai) {
        resolved.openai = { row, key: await decryptSecret(row.api_key_enc, GATEWAY_SECRET) };
      }
      if (row.anthropic_base_url && !resolved.anthropic) {
        resolved.anthropic = { row, key: await decryptSecret(row.api_key_enc, GATEWAY_SECRET) };
      }
      if (resolved.openai && resolved.anthropic) break;
    }
    providerCache = resolved;
    providerCachePromise = null;
    return resolved;
  })();
  return providerCachePromise;
}

/** Test hooks: force cache reload (used after admin writes in tests). */
export function invalidateProviderCache(): void {
  providerCache = null;
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

      // OpenAI streams: ask upstream to include a terminal usage chunk so
      // accounting stays exact (Anthropic always streams usage events). This
      // is the ONLY field we ever mutate, and only when the client didn't set
      // it — otherwise the original bytes are forwarded untouched.
      if (
        proto === "openai" &&
        (bodyJson as any).stream === true &&
        route.upstreamPath === "/chat/completions"
      ) {
        const so = ((bodyJson as any).stream_options ?? {}) as Record<string, unknown>;
        if (so.include_usage !== true) {
          so.include_usage = true;
          (bodyJson as any).stream_options = so;
          bodyText = JSON.stringify(bodyJson);
        }
      }
    }

    // ---- resolve provider ----
    const providers = await resolveProviders();
    const target = proto === "openai" ? providers.openai : providers.anthropic;
    if (!target) {
      console.error(`[PROXY] no enabled provider configured for capability "${proto}"`);
      return envelopeError(proto, 503, "gateway is not configured for this API protocol", "api_error", req);
    }
    // Trailing "/" would produce "//chat/completions" — new rows are stripped
    // at write time, this covers legacy rows still carrying one.
    const base = (proto === "openai" ? target.row.openai_base_url : target.row.anthropic_base_url)!
      .replace(/\/+$/, "");
    const breakerId = `${target.row.id}:${proto}`;
    if (breakerState(breakerId) === "open") {
      return envelopeError(proto, 503, "upstream temporarily unavailable", "api_error", req);
    }

    // ---- forward ----
    const wantsStream = (bodyJson as any)?.stream === true;
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
          target.key,
          proto === "openai" ? target.row.openai_auth_style : target.row.anthropic_auth_style,
        ),
        body: req.method === "POST" ? bodyText : undefined,
        signal: controller.signal,
      });
      clearTimeout(headerTimeout);
    } catch (e) {
      clearTimeout(headerTimeout);
      const clientDisconnected = req.signal.aborted;
      const timedOut = controller.signal.aborted && !clientDisconnected;
      // A client giving up on us (short timeout, rage-quit) must NOT trip the
      // breaker — otherwise a few disconnects would 503 the whole gateway for
      // every user. Only genuine upstream network failures and OUR header
      // timeout count as provider trouble.
      if (!clientDisconnected) breakerFail(breakerId);
      console.error(`[PROXY] upstream fetch failed (${upstreamUrl}):`, (e as Error).name);
      recordUsage({
        keyId: keyRow.id, userId: keyRow.user_id, proto, model: "",
        inTok: 0, cacheTok: 0, outTok: 0, latencyMs: Math.round(performance.now() - started),
        status: clientDisconnected ? 499 : timedOut ? 504 : 502, stream: wantsStream, estimated: false,
      });
      return envelopeError(
        proto,
        timedOut ? 504 : 502,
        timedOut ? "upstream took too long to respond" : "upstream is unreachable",
        "api_error",
      );
    } finally {
      req.signal.removeEventListener("abort", onClientAbort);
    }

    // Only infrastructure-level failures count toward the circuit breaker;
    // a 4xx from upstream is just the client's request being rejected there.
    if (upstream.status >= 500 || upstream.status === 429) breakerFail(breakerId);
    else breakerOk(breakerId);

    const contentType = upstream.headers.get("content-type") || "";
    const isSse = contentType.includes("text/event-stream");
    const clientHeaders = buildClientHeaders(upstream.headers, requestId);

    const record = (u: UsageResult, status: number, latencyMs: number, stream: boolean) => {
      let inTok = u.inTok;
      if (u.estimated && bodyJson) {
        inTok = estimateTokens(bodyText);
      }
      recordUsage({
        keyId: keyRow.id,
        userId: keyRow.user_id,
        proto,
        model: u.model || String((bodyJson as any)?.model ?? "").slice(0, 128),
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
    const usage = contentType.includes("application/json")
      ? proto === "openai"
        ? parseOpenAiJson(respText)
        : parseAnthropicJson(respText)
      : { inTok: 0, cacheTok: 0, outTok: 0, model: "", estimated: false };
    const latencyMs = Math.round(performance.now() - started);
    record(usage, upstream.status, latencyMs, false);

    return new Response(respText, { status: upstream.status, headers: clientHeaders });
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
