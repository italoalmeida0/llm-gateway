/**
 * Token estimation — btdby4 (WebAssembly, universal).
 *
 * btdby4 is the project's own estimator, the same BPE engine the
 * indirect-code daemon uses (Go module github.com/italoalmeida0/btdby4):
 * real BPE counting (not chars/4 heuristics), per-protocol request
 * counters (chat / anthropic / responses, framing included), image token
 * counting (dimensions/base64/bytes), encrypted-reasoning estimation and
 * the KV-cache prefix provider (`kvCache`) used for zero-usage inference.
 *
 * The WASM build (`btdby4-wasm`, npm) runs everywhere with zero native
 * deps — linux/mac/windows, glibc/musl (Alpine included), no per-platform
 * packages, no bun:ffi segfaults. One 8MB btdby4.wasm ships inside the npm
 * package (committed upstream, downloaded by `bun install` like any dep).
 * ~66ms one-time init (async, warmed at gateway boot), ~21µs per call —
 * fast enough for the streaming hot path.
 *
 * API note (btdby4-wasm >= 1.1): every request-level counter takes the
 * request as a JSON **string**, not an object — the wasm boundary is
 * crossed once per call (1x stringify + 1x UTF-8 copy) instead of once
 * per field. Callers holding the original request bytes should pass them
 * straight through; callers holding an object stringify once here.
 *
 * There is NO tokenx fallback: btdby4-wasm loads on every platform we
 * ship. If it cannot initialize, the gateway fails fast at boot with a
 * clear error instead of silently billing on a worse estimator.
 */

// Local structural minimal type (NOT imported from the package — the
// package's index.js is a bundled build; a static type import would still
// resolve its TS sources under tsc. Keep the surface structural here).
interface TokenOptions {
  tight?: boolean;
  ignoreImages?: boolean;
}

type KvProtocol = "anthropic" | "chat" | "responses";

interface KvResult {
  total: number;
  cached: number;
  fresh: number;
  written: number;
  hit: boolean;
  hit_ratio: number;
  prefix_blocks: number;
  total_blocks: number;
  breakdown: {
    system: number;
    messages: number;
    tools: number;
    images: number;
    by_message?: number[];
    by_tool?: number[];
    text_tokens: number;
    total: number;
    image_count: number;
  };
}

interface KvStats {
  namespaces: number;
  nodes: number;
  branches: number;
  tokens: number;
  bytes: number;
  max_bytes: number;
  /** Free cache memory before LRU eviction kicks in. */
  available_bytes: number;
  /** Configured sliding TTL in seconds. */
  ttl_seconds: number;
}

interface BTDby4Instance {
  countText(text: string): number;
  estimateThinkingTokens(encryptedPayload: string): number;
  countImageSize(width: number, height: number): number;
  countImageBase64(base64Str: string): number;
  countImageBytes(bytes: Uint8Array | ArrayBuffer): number;
  countChatTotal(request: string, options?: TokenOptions): number;
  countAnthropicTotal(request: string, options?: TokenOptions): number;
  countResponsesTotal(request: string, options?: TokenOptions): number;
  kvCache(request: string, protocol: KvProtocol, namespace: string, options?: TokenOptions): KvResult;
  kvStats(): KvStats;
  kvInit(options?: { ttlSeconds?: number; maxMB?: number; separateProtocol?: boolean }): unknown;
  kvClear(namespace?: string): void;
}

let native: BTDby4Instance | null = null;
let initPromise: Promise<BTDby4Instance> | null = null;

async function loadEngine(): Promise<BTDby4Instance> {
  // Dynamic import: keeps tsc on the structural type above (never opens
  // the package's bundled sources) and works from any importer.
  const mod = (await import("btdby4-wasm")) as unknown as {
    default: (opts?: { wasmSource?: Uint8Array | ArrayBuffer | string }) => Promise<BTDby4Instance>;
  };
  return mod.default();
}

/** Synchronously get the engine; throws with a clear message if not ready. */
function engine(): BTDby4Instance {
  if (!native) {
    throw new Error(
      "btdby4-wasm not initialized: await initTokenEstimator() at gateway boot before counting tokens",
    );
  }
  return native;
}

/**
 * Initialize the WASM engine. MUST be awaited once at gateway boot (before
 * serving requests) — after that every counter below is synchronous.
 * Idempotent; concurrent callers share the same init.
 */
export async function initTokenEstimator(): Promise<void> {
  if (native) return;
  if (!initPromise) {
    initPromise = loadEngine().then(
      (inst) => {
        // Sanity check — a broken wasm must not silently poison accounting.
        if (!inst || inst.countText("hello world") < 1) {
          throw new Error("btdby4-wasm sanity check failed (countText returned 0)");
        }
        // The KV provider owns all prefix-cache state (trie + LFU + TTL,
        // 10min TTL / 400MB cap / per-protocol isolation by default). The
        // gateway keeps no cache bookkeeping of its own.
        try {
          inst.kvInit({ ttlSeconds: 600, maxMB: 400, separateProtocol: true });
        } catch (err) {
          throw new Error(`btdby4-wasm kvInit failed: ${(err as Error).message}`, { cause: err });
        }
        native = inst;
        return inst;
      },
      (err) => {
        initPromise = null;
        throw new Error(`btdby4-wasm failed to initialize: ${(err as Error).message}`, { cause: err });
      },
    );
  }
  await initPromise;
}

/** True once initTokenEstimator() has resolved. */
export function tokensReady(): boolean {
  return native !== null;
}

/** Raw text → tokens. Used for streamed output samples. */
export function countTextTokens(text: string): number {
  return Math.max(1, engine().countText(text));
}

/** Encrypted/opaque reasoning payload → estimated thinking tokens. */
export function estimateThinkingTokens(encryptedPayload: string): number {
  return Math.max(0, engine().estimateThinkingTokens(encryptedPayload));
}

export type TokenImageInput =
  | { width: number; height: number }
  | { base64: string }
  | { bytes: Uint8Array | ArrayBuffer };

/** Image → tokens (dimensions, base64 payload or raw bytes). */
export function countImageTokens(image: TokenImageInput): number {
  const e = engine();
  if ("width" in image) return Math.max(0, e.countImageSize(image.width, image.height));
  if ("base64" in image) return Math.max(0, e.countImageBase64(image.base64));
  return Math.max(0, e.countImageBytes(image.bytes));
}

export type Proto = "openai" | "anthropic" | "responses";

/** Gateway proto → btdby4 KV protocol (openai serves chat completions). */
function toKvProtocol(proto: Proto): KvProtocol {
  return proto === "openai" ? "chat" : proto;
}

/**
 * Request JSON string → input-token total, counted with the estimator
 * matching the body's own protocol (framing included — btdby4 counts the
 * real wire shape, images included). Never returns zero for parseable
 * input; unparseable input returns 1 (never a zero lie).
 */
export function countRequestJson(proto: Proto, requestJson: string): number {
  const e = engine();
  try {
    const total =
      proto === "anthropic"
        ? e.countAnthropicTotal(requestJson)
        : proto === "responses"
          ? e.countResponsesTotal(requestJson)
          : e.countChatTotal(requestJson);
    return Math.max(1, total);
  } catch {
    return 1;
  }
}

/**
 * Whole request body → input-token estimate, counted with the estimator
 * matching the body's own protocol (framing included — btdby4 counts the
 * real wire shape, images included).
 */
export function countRequestTokens(proto: Proto, body: Record<string, unknown>): number {
  let json: string;
  try {
    json = JSON.stringify(body);
  } catch {
    return 1;
  }
  return countRequestJson(proto, json);
}

export interface KvSplit {
  inTok: number;
  cacheTok: number;
  total: number;
  hit: boolean;
}

/**
 * Request JSON string → (fresh, cached) split from the btdby4 KV provider.
 *
 * The wasm owns the whole cache: block-level prefix trie with fork
 * branches, LFU eviction and TTL, keyed by `namespace` (the gateway passes
 * key + provider + provider key + upstream model + egress lane) with
 * per-protocol isolation built in. One call tokenizes, looks up the
 * longest stable prefix and advances the run — the gateway keeps no
 * fingerprint, no Map, no LRU of its own.
 *
 * Never returns a zero total for a non-trivial body: a wasm failure falls
 * back to the plain request total as 100% fresh.
 */
export function splitKvInput(requestJson: string, proto: Proto, namespace: string): KvSplit {
  const e = engine();
  try {
    const r = e.kvCache(requestJson, toKvProtocol(proto), namespace);
    const total = Math.max(1, r.total);
    const cached = Math.max(0, Math.min(r.cached, total));
    return { inTok: total - cached, cacheTok: cached, total, hit: r.hit };
  } catch {
    const total = countRequestJson(proto, requestJson);
    return { inTok: total, cacheTok: 0, total, hit: false };
  }
}

/**
 * Cached KV-cache snapshot for the admin dashboard chip.
 *
 * Cache bookkeeping stays INSIDE the wasm (trie + LFU + TTL); this layer
 * only caches the *reporting* call: kvStats() is re-read from the engine
 * at most once per minute, and every stats endpoint served in between
 * reuses the memoized object (with its captured_at timestamp). No
 * frontend polling needed — the page reads whatever is current on load
 * and the 60s staleness bound keeps the chip truthful.
 */
const KV_STATS_TTL_MS = 60_000;
let kvSnapshot: { at: number; stats: KvStats } | null = null;

export interface KvSnapshot extends KvStats {
  /** Unix ms when this snapshot was read from the engine. */
  captured_at: number;
  /** True when the snapshot is older than KV_STATS_TTL_MS. */
  stale: boolean;
}

export function kvSnapshotCached(): KvSnapshot {
  const now = Date.now();
  if (!kvSnapshot || now - kvSnapshot.at >= KV_STATS_TTL_MS) {
    kvSnapshot = { at: now, stats: engine().kvStats() };
  }
  return { ...kvSnapshot.stats, captured_at: kvSnapshot.at, stale: now - kvSnapshot.at >= KV_STATS_TTL_MS };
}

/** KV provider stats (namespaces, nodes, branches, tokens, bytes). */
export function kvStats(): KvStats {
  return engine().kvStats();
}

/** Clear KV state for one namespace, or everything when omitted (tests). */
export function kvClear(namespace?: string): void {
  engine().kvClear(namespace);
}
