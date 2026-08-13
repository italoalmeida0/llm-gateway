import { GOOGLE_CLIENT_ID } from "./config";
import { ApiError } from "./http";
import { b64uDecode } from "./crypto";

/**
 * Google Sign-In verification. The client sends the ID token it received from
 * the GSI button; we verify the RS256 signature locally against Google's JWKS
 * (cached), then check issuer, audience, expiry and email verification.
 * No HTTP call to tokeninfo = no extra latency + no third-party dependency.
 */

interface Jwk {
  kty: string;
  kid: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL = 60 * 60 * 1000;

async function getJwk(kid: string, allowRefresh: boolean): Promise<CryptoKey> {
  const now = Date.now();
  if (!jwksCache || now - jwksCache.fetchedAt > JWKS_TTL || allowRefresh) {
    const res = await fetch("https://www.googleapis.com/oauth2/v3/certs", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new ApiError(502, "could not fetch Google signing keys");
    const body = (await res.json()) as { keys: Jwk[] };
    jwksCache = { keys: body.keys, fetchedAt: now };
  }
  const jwk = jwksCache!.keys.find((k) => k.kid === kid && k.kty === "RSA");
  if (!jwk) {
    if (allowRefresh) throw new ApiError(401, "unknown Google key id");
    return getJwk(kid, true);
  }
  return crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: false },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  if (!GOOGLE_CLIENT_ID) throw new ApiError(503, "Google sign-in is not configured");

  const parts = idToken.split(".");
  if (parts.length !== 3) throw new ApiError(400, "malformed ID token");
  const [head, body, sig] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(b64uDecode(head)));
    payload = JSON.parse(new TextDecoder().decode(b64uDecode(body)));
  } catch {
    throw new ApiError(400, "malformed ID token");
  }

  if (header.alg !== "RS256" || !header.kid) throw new ApiError(400, "unsupported ID token");

  const key = await getJwk(header.kid, false);
  const validSig = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64uDecode(sig) as BufferSource,
    new TextEncoder().encode(`${head}.${body}`),
  );
  if (!validSig) throw new ApiError(401, "invalid ID token signature");

  const iss = payload.iss;
  if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") {
    throw new ApiError(401, "invalid token issuer");
  }
  if (payload.aud !== GOOGLE_CLIENT_ID) throw new ApiError(401, "token audience mismatch");
  if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) {
    throw new ApiError(401, "ID token expired");
  }
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
    throw new ApiError(401, "ID token missing identity");
  }

  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
    name: typeof payload.name === "string" ? payload.name.slice(0, 128) : "",
  };
}
