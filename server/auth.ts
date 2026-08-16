import { GATEWAY_SECRET, LIMITS } from "./config";
import { db, stmts, audit, type UserRow, type SessionRow } from "./db";
import { jwtSign, jwtVerify, randomToken, sha256Hex } from "./crypto";
import { ApiError } from "./http";

/**
 * Session model:
 *  - Access token: HS256 JWT (12h), carries { sub, jti, role, type:'access' }.
 *  - Refresh token: opaque 256-bit, stored as SHA-256 in the sessions row,
 *    30d sliding expiry + 180d absolute cap, rotated on every use.
 *  - Revocation: the session row (keyed by jti) gates BOTH tokens, so banning
 *    a user or revoking a session kills access immediately (checked per request).
 */

export interface AuthContext {
  user: UserRow;
  session: SessionRow;
}

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    hasPassword: !!u.password_hash,
    googleLinked: !!u.google_id,
    totpEnabled: !!u.totp_secret,
    status: u.status,
    createdAt: u.created_at,
  };
}

export async function issueSession(
  user: UserRow,
  meta: { ip?: string | null; ua?: string | null; label?: string | null; family?: string | null } = {},
): Promise<{ accessToken: string; refreshToken: string; refreshExpiresAt: number }> {
  const jti = randomToken(16);
  const refreshToken = randomToken(32);
  const now = Date.now();
  const refreshExpiresAt = now + LIMITS.refreshTokenTtlMs;

  db.prepare(
    `INSERT INTO sessions (jti, user_id, refresh_hash, created_at, last_used_at, expires_at, abs_expires_at, revoked, ip, ua, label, family)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  ).run(
    jti,
    user.id,
    sha256Hex(refreshToken),
    now,
    now,
    refreshExpiresAt,
    now + LIMITS.refreshAbsoluteTtlMs,
    meta.ip ?? null,
    meta.ua?.slice(0, 200) ?? null,
    meta.label ?? null,
    meta.family ?? jti, // a fresh login starts a new rotation family
  );

  const accessToken = await jwtSign(
    { sub: user.id, jti, role: user.role, type: "access" },
    GATEWAY_SECRET,
    LIMITS.accessTokenTtlSec,
  );
  return { accessToken, refreshToken, refreshExpiresAt };
}

/** Sign a short-lived token that only proves "password step passed, awaiting 2FA". */
export async function issue2faTempToken(userId: string): Promise<string> {
  return jwtSign(
    { sub: userId, jti: randomToken(8), type: "2fa" },
    GATEWAY_SECRET,
    LIMITS.twoFaTempTtlSec,
  );
}

export async function verify2faTempToken(token: string): Promise<string> {
  const res = await jwtVerify(token, GATEWAY_SECRET);
  if (!res.ok || res.payload.type !== "2fa") throw new ApiError(401, "invalid or expired 2FA token");
  return res.payload.sub;
}

export function revokeSession(jti: string): void {
  db.prepare("UPDATE sessions SET revoked = 1 WHERE jti = ?").run(jti);
}

export function revokeAllUserSessions(userId: string, exceptJti?: string): void {
  if (exceptJti) {
    db.prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ? AND jti != ?").run(
      userId,
      exceptJti,
    );
  } else {
    db.prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ?").run(userId);
  }
}

/** Rotate a refresh token -> new session row (old jti revoked).
 *
 *  Reuse detection: a refresh token whose session row is ALREADY revoked has
 *  been presented before (rotation happened, or the user logged out). Since
 *  tokens are one-time, a replay means someone is holding a stolen copy — so
 *  the WHOLE rotation family is revoked: the attacker's rotated-forward
 *  session dies with it (OWASP refresh-token reuse handling).
 */
export async function rotateRefreshToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: number;
  user: UserRow;
}> {
  const session = stmts.sessionByRefreshHash.get(sha256Hex(refreshToken));
  if (!session) throw new ApiError(401, "invalid refresh token");

  const now = Date.now();
  if (session.revoked) {
    // A session that lapsed by expiry and was swept is just old — but one
    // revoked MID-LIFE (rotated away or logged out) being replayed is theft
    // evidence: kill the whole rotation family so the stolen copy's
    // rotated-forward session dies too.
    const lapsedNaturally = session.expires_at < now || session.abs_expires_at < now;
    if (!lapsedNaturally && session.family) {
      db.prepare("UPDATE sessions SET revoked = 1 WHERE family = ?").run(session.family);
      audit("session.refresh_reuse", {
        target: session.jti,
        meta: { user: session.user_id, family: session.family },
      });
    }
    throw new ApiError(401, "session expired, please log in again");
  }
  if (session.abs_expires_at < now) {
    throw new ApiError(401, "session expired, please log in again");
  }
  if (session.expires_at < now) throw new ApiError(401, "session expired, please log in again");

  const user = stmts.userById.get(session.user_id);
  if (!user || user.status !== "active") throw new ApiError(401, "account unavailable");

  // Rotate: kill old session, create a fresh one (device label and family
  // are carried over — the chain stays auditable as one login).
  revokeSession(session.jti);
  const tokens = await issueSession(user, {
    ip: session.ip,
    ua: session.ua,
    label: session.label,
    family: session.family ?? session.jti,
  });
  return { ...tokens, user };
}

/**
 * Verify the Authorization Bearer token on dashboard requests.
 * Throws ApiError(401/403) on any problem.
 */
export async function requireAuth(req: Request): Promise<AuthContext> {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw new ApiError(401, "missing bearer token");

  const res = await jwtVerify(token, GATEWAY_SECRET);
  if (!res.ok || res.payload.type !== "access") throw new ApiError(401, "invalid or expired token");

  const session = stmts.sessionByJti.get(res.payload.jti);
  const now = Date.now();
  if (!session || session.revoked || session.abs_expires_at < now) {
    throw new ApiError(401, "session revoked");
  }

  const user = stmts.userById.get(session.user_id);
  if (!user) throw new ApiError(401, "unknown user");
  if (user.status !== "active") throw new ApiError(403, "account is disabled");

  // Sliding refresh of the session bookkeeping (cheap update, throttled).
  if (now - session.last_used_at > 60_000) {
    db.prepare("UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE jti = ?").run(
      now,
      Math.min(now + LIMITS.refreshTokenTtlMs, session.abs_expires_at),
      session.jti,
    );
  }

  return { user, session };
}

export async function requireAdmin(req: Request): Promise<AuthContext> {
  const ctx = await requireAuth(req);
  if (ctx.user.role !== "admin") throw new ApiError(403, "admin only");
  return ctx;
}

/** Express an admin action in the audit log. */
export function auditAdmin(actor: UserRow, action: string, target?: string, meta?: unknown, ip?: string) {
  audit(action, { actorId: actor.id, target, meta, ip });
}
