/**
 * Typed fetch client for the gateway REST API.
 * - Attaches the bearer token automatically.
 * - On 401 with an expired access token, rotates via the refresh token once
 *   (single-flight) and retries the original request.
 * - On hard auth failure, drops the session and routes to the login page.
 */

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  hasPassword: boolean;
  googleLinked: boolean;
  totpEnabled: boolean;
  status: "active" | "banned";
  createdAt: number;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

const LS = "llm_gateway_session";

let session: Session | null = null;
try {
  const raw = localStorage.getItem(LS);
  if (raw) session = JSON.parse(raw);
} catch {
  localStorage.removeItem(LS);
}

let listeners: Array<(s: Session | null) => void> = [];

export function currentSession(): Session | null {
  return session;
}

export function setSession(s: Session | null): void {
  session = s;
  if (s) localStorage.setItem(LS, JSON.stringify(s));
  else localStorage.removeItem(LS);
  for (const fn of listeners) fn(session);
}

export function onSessionChange(fn: (s: Session | null) => void): () => void {
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((f) => f !== fn);
  };
}

let refreshPromise: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  if (!session) return false;
  try {
    const res = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    const j = await res.json();
    if (!res.ok || !j.success) return false;
    setSession({
      accessToken: j.accessToken,
      refreshToken: j.refreshToken,
      user: j.user,
    });
    return true;
  } catch {
    return false;
  }
}

async function refreshSingleFlight(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = refresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export class ApiFail extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function rawCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (session) headers.Authorization = `Bearer ${session.accessToken}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let j: any = null;
  try {
    j = await res.json();
  } catch {}
  if (!res.ok) throw new ApiFail(res.status, j?.error ?? `HTTP ${res.status}`);
  return j as T;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await rawCall<T>(method, path, body);
  } catch (e) {
    if (e instanceof ApiFail && e.status === 401 && session) {
      const ok = await refreshSingleFlight();
      if (ok) return rawCall<T>(method, path, body);
      setSession(null);
    }
    throw e;
  }
}

/** Unauthenticated calls (login, reset, 2FA step). */
export async function publicApi<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  return rawCall<T>(method, path, body);
}

// ===== Shared DTOs =====

export interface ApiKeyDto {
  id: string;
  userId: string;
  userEmail?: string;
  name: string;
  prefix: string;
  createdAt: number;
  expiresAt: number | null;
  dailyLimit: number | null;
  totalLimit: number | null;
  rpm: number | null;
  status: "active" | "revoked" | "exhausted" | "expired" | "daily_limit" | "total_limit";
  lastUsedAt: number | null;
  /** Output-token burn — budgets cap output only, so these never mix in
   *  input or cached-input tokens. */
  outputToday: number;
  outputTotal: number;
  revealable: boolean;
}

export interface DailyPoint {
  date: string;
  /** Cache-free input tokens. */
  in_tok: number;
  /** Cached input tokens (billed at cache rate upstream). */
  cache_tok: number;
  out_tok: number;
  reqs: number;
  /** Hour buckets carry a short tick label ("13:00"); day buckets don't. */
  label?: string;
}

export interface UsageEventDto {
  id: number;
  key_id: string;
  ts: number;
  proto: "openai" | "anthropic";
  model: string;
  in_tok: number;
  cache_tok: number;
  out_tok: number;
  latency_ms: number;
  status: number;
  stream: number;
}

export type AuthStyle = "bearer" | "x-api-key";

export interface ProviderDto {
  id: string;
  name: string;
  openaiBaseUrl: string | null;
  openaiAuthStyle: AuthStyle;
  anthropicBaseUrl: string | null;
  anthropicAuthStyle: AuthStyle;
  enabled: boolean;
  priority: number;
  createdAt: number;
  hasApiKey: boolean;
  modelCount: number;
}

/** Per-capability result of a model-registry sync (best-effort). */
export interface SyncOutcome {
  added: number;
  skipped: number;
  /** Rows upgraded to proto "both" by a "both"-mode sync. */
  merged: number;
  error?: string;
}

/** How a sync maps listed models to registry protos. */
export type SyncMode = "both" | "separate";

/** Per-capability peek at a provider's GET /models (before importing). */
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

export type RoutingMode = "passthrough" | "router";

/** Protocol surface(s) a registry entry serves. */
export type ModelProto = "openai" | "anthropic" | "both";

/** Admin view of a registered model (camelCase mirror of the models table). */
export interface ModelDto {
  id: string;
  providerId: string | null;
  providerName: string | null;
  upstreamModel: string;
  proto: ModelProto;
  name: string;
  description: string;
  huggingFaceId: string;
  quantization: string;
  openrouterSlug: string;
  alwaysOn: boolean;
  enabled: boolean;
  contextLength: number | null;
  maxOutputLength: number | null;
  created: number | null;
  inputModalities: string[];
  outputModalities: string[];
  samplingParams: string[];
  features: string[];
  reasoningEfforts: string[] | null;
  pricing: Record<string, string> | null;
  datacenters: Array<{ country_code: string }> | null;
  source: "auto" | "manual";
  createdAt: number;
  updatedAt: number;
}

export interface AdminUserDto {
  id: string;
  email: string;
  name: string;
  role: "admin" | "user";
  status: "active" | "banned";
  hasPassword: boolean;
  googleLinked: boolean;
  totpEnabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  keyCount: number;
}
