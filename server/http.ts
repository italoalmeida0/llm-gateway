import { ALLOWED_ORIGINS, TRUST_PROXY } from "./config";

/**
 * HTTP plumbing shared by every route: security headers, CORS, body guards,
 * client-IP resolution, and the `{success, ...}` API envelope.
 */

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function corsOriginFor(req?: Request): string | null {
  if (!req || ALLOWED_ORIGINS.length === 0) return null;
  const origin = req.headers.get("origin");
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return null;
}

export function baseHeaders(req?: Request, isHtml = false): Headers {
  const h = new Headers();
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (isHtml) {
    // Google GSI button needs accounts.google.com scripts/frames; everything
    // else is self-hosted. No inline scripts -> no 'unsafe-inline' for script-src.
    h.set(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' https://accounts.google.com/gsi/client",
        "frame-src https://accounts.google.com/gsi/",
        "connect-src 'self' https://accounts.google.com/gsi/ https://api.iconify.design",
        "img-src 'self' data:",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self' data:",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
  }
  const cors = corsOriginFor(req);
  if (cors) {
    h.set("Access-Control-Allow-Origin", cors);
    h.set("Vary", "Origin");
    h.set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");
    h.set("Access-Control-Max-Age", "600");
  }
  return h;
}

export function json(data: unknown, init: { status?: number; req?: Request } = {}): Response {
  const h = baseHeaders(init.req);
  h.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status: init.status ?? 200, headers: h });
}

export function ok(data: Record<string, unknown> = {}, req?: Request): Response {
  return json({ success: true, ...data }, { req });
}

export function err(status: number, message: string, req?: Request, code?: string): Response {
  return json({ success: false, error: message, ...(code ? { code } : {}) }, { status, req });
}

/** Resolve the real client IP, honoring proxy headers only when configured. */
export function clientIp(req: Request, server?: { requestIP(req: Request): { address: string } | null }): string {
  if (TRUST_PROXY) {
    const cf = req.headers.get("cf-connecting-ip");
    if (cf) return cf.trim();
    const tc = req.headers.get("true-client-ip");
    if (tc) return tc.trim();
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0];
      if (first) return first.trim();
    }
    const real = req.headers.get("x-real-ip");
    if (real) return real.trim();
  }
  return server?.requestIP(req)?.address ?? "unknown";
}

/**
 * Parse a JSON object body with a hard byte cap. Content-Length is checked
 * first (cheap) and the actual body second (chunked transfers lie).
 */
export async function readJsonBody(req: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const cl = req.headers.get("content-length");
  if (cl && Number(cl) > maxBytes) throw new ApiError(413, "payload too large");

  const ctype = req.headers.get("content-type") || "";
  if (!ctype.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "content-type must be application/json");
  }

  const buf = await req.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new ApiError(413, "payload too large");

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new ApiError(400, "invalid JSON body");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, "JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

/** Small validation helpers — deliberately boring, no schema lib. */
export const v = {
  str(body: Record<string, unknown>, key: string, opts: { min?: number; max?: number; optional?: boolean } = {}): string | null {
    const val = body[key];
    if (val === undefined || val === null || val === "") {
      if (opts.optional) return null;
      throw new ApiError(400, `${key} is required`);
    }
    if (typeof val !== "string") throw new ApiError(400, `${key} must be a string`);
    const min = opts.min ?? 0;
    const max = opts.max ?? 512;
    if (val.length < min) throw new ApiError(400, `${key} is too short`);
    if (val.length > max) throw new ApiError(400, `${key} is too long`);
    return val;
  },

  int(body: Record<string, unknown>, key: string, opts: { min?: number; max?: number; optional?: boolean } = {}): number | null {
    const val = body[key];
    if (val === undefined || val === null || val === "") {
      if (opts.optional) return null;
      throw new ApiError(400, `${key} is required`);
    }
    const n = typeof val === "string" && /^\d+$/.test(val) ? Number(val) : val;
    if (typeof n !== "number" || !Number.isInteger(n)) throw new ApiError(400, `${key} must be an integer`);
    if (opts.min !== undefined && n < opts.min) throw new ApiError(400, `${key} is too small`);
    if (opts.max !== undefined && n > opts.max) throw new ApiError(400, `${key} is too large`);
    return n;
  },

  email(body: Record<string, unknown>, key: string): string {
    const val = v.str(body, key, { min: 3, max: 254 })!;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val)) throw new ApiError(400, `${key} must be a valid email`);
    return val.toLowerCase();
  },
};
