import { LIMITS, GOOGLE_CLIENT_ID, SMTP_ENABLED } from "../config";
import { db, stmts, audit } from "../db";
import {
  hashPassword,
  verifyPassword,
  totpVerify,
  randomToken,
  sha256Hex,
} from "../crypto";
import {
  issueSession,
  issue2faTempToken,
  verify2faTempToken,
  rotateRefreshToken,
  requireAuth,
  revokeSession,
  revokeAllUserSessions,
  publicUser,
} from "../auth";
import { verifyGoogleIdToken } from "../google";
import { sendResetEmail, sendSecurityAlert } from "../email";
import { ApiError, clientIp, err, ok, readJsonBody, v } from "../http";
import {
  bruteforceClear,
  bruteforceFail,
  bruteforceLocked,
  consumeTotpCode,
  limits,
} from "../ratelimit";

/**
 * POST /api/auth/* — public credential endpoints. Heavily rate limited and
 * deliberately generic in error messages (no account enumeration).
 */

const DUMMY_HASH =
  "pbkdf2:100000:VGVtcG9yYXJ5U2FsdFZhbHVlMTIzNDU2Nzg5MDEy:QWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg=";

function passwordPolicy(pw: string): void {
  if (pw.length < 10) throw new ApiError(400, "password must be at least 10 characters");
  if (pw.length > 256) throw new ApiError(400, "password is too long");
}

async function finishLogin(userId: string, req: Request, server: any) {
  const user = stmts.userById.get(userId)!;
  const ip = clientIp(req, server);
  const tokens = await issueSession(user, { ip, ua: req.headers.get("user-agent") });
  db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(Date.now(), user.id);
  return ok({ ...tokens, user: publicUser(user) }, req);
}

export async function handleAuthRoute(path: string, req: Request, server: any): Promise<Response | null> {
  const ip = clientIp(req, server);

  // Brute-force bucket (30/min/ip) applies ONLY to credential endpoints —
  // refresh/logout/config are called routinely by the dashboard and must not
  // eat the login budget (authed traffic is covered by the global ip bucket).
  const CREDENTIAL_PATHS = ["/api/auth/login", "/api/auth/2fa", "/api/auth/google"];
  if (CREDENTIAL_PATHS.includes(path)) {
    const retry = limits.authPerMin(ip);
    if (retry > 0) return err(429, `too many attempts, retry in ${retry}s`, req);
  }

  if (path === "/api/auth/config" && req.method === "GET") {
    return ok(
      {
        googleClientId: GOOGLE_CLIENT_ID || null,
        smtpConfigured: SMTP_ENABLED,
      },
      req,
    );
  }

  // ---- login: email + password ----
  if (path === "/api/auth/login" && req.method === "POST") {
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const email = v.email(body, "email");
    const password = v.str(body, "password", { min: 1, max: 256 })!;

    const scope = `login:${email}`;
    const scopeIp = `login-ip:${ip}`;
    const locked = Math.max(bruteforceLocked(scope), bruteforceLocked(scopeIp));
    if (locked > 0) return err(429, `account temporarily locked, retry in ${locked}s`, req);

    const user = stmts.userByEmail.get(email);
    const hash = user?.password_hash ?? DUMMY_HASH;
    const valid = await verifyPassword(password, hash).catch(() => false);

    if (!user || !user.password_hash || !valid) {
      bruteforceFail(scope);
      bruteforceFail(scopeIp, LIMITS.loginIpFailMax);
      audit("login.failed", { target: email, ip });
      return err(401, "invalid email or password", req);
    }
    if (user.status !== "active") return err(403, "account is disabled", req);

    // Password correct — if TOTP is enabled, move to the 2FA step.
    if (user.totp_secret) {
      const tempToken = await issue2faTempToken(user.id);
      return ok({ needs2FA: true, tempToken }, req);
    }

    bruteforceClear(scope);
    audit("login.success", { actorId: user.id, ip });
    return finishLogin(user.id, req, server);
  }

  // ---- 2FA completion ----
  if (path === "/api/auth/2fa" && req.method === "POST") {
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const tempToken = v.str(body, "tempToken", { min: 10, max: 4096 })!;
    const code = v.str(body, "code", { min: 6, max: 6 })!;

    const userId = await verify2faTempToken(tempToken).catch(() => null);
    if (!userId) return err(401, "invalid or expired 2FA token", req);

    const scope = `2fa:${userId}`;
    const locked = bruteforceLocked(scope);
    if (locked > 0) return err(429, `too many 2FA failures, retry in ${locked}s`, req);

    const user = stmts.userById.get(userId);
    if (!user || !user.totp_secret || user.status !== "active") {
      return err(401, "2FA not available for this account", req);
    }

    const valid = await totpVerify(user.totp_secret, code);
    const digest = sha256Hex(`${user.totp_secret}:${code}`);
    if (!valid || !consumeTotpCode(digest)) {
      bruteforceFail(scope);
      audit("2fa.failed", { actorId: userId, ip });
      return err(401, "invalid code", req);
    }

    bruteforceClear(scope);
    bruteforceClear(`login:${user.email}`);
    audit("login.success.2fa", { actorId: userId, ip });
    return finishLogin(userId, req, server);
  }

  // ---- Google sign-in (existing accounts only; auto-links by verified email) ----
  if (path === "/api/auth/google" && req.method === "POST") {
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const idToken = v.str(body, "idToken", { min: 20, max: 8192 })!;

    const identity = await verifyGoogleIdToken(idToken);

    let user = stmts.userByGoogleId.get(identity.sub);
    if (!user) {
      // Auto-link only when Google guarantees email ownership AND the account
      // does not already have a different Google identity bound.
      if (!identity.emailVerified) return err(403, "Google account not linked", req);
      const byEmail = stmts.userByEmail.get(identity.email);
      if (!byEmail || byEmail.google_id) return err(403, "Google account not linked", req);
      db.prepare("UPDATE users SET google_id = ? WHERE id = ?").run(identity.sub, byEmail.id);
      user = stmts.userById.get(byEmail.id)!;
      audit("google.autolink", { actorId: user.id, ip, meta: { email: identity.email } });
    }
    if (user.status !== "active") return err(403, "account is disabled", req);

    audit("login.success.google", { actorId: user.id, ip });
    return finishLogin(user.id, req, server);
  }

  // ---- refresh rotation ----
  if (path === "/api/auth/refresh" && req.method === "POST") {
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const refreshToken = v.str(body, "refreshToken", { min: 20, max: 256 })!;
    const rotated = await rotateRefreshToken(refreshToken);
    return ok(
      {
        accessToken: rotated.accessToken,
        refreshToken: rotated.refreshToken,
        refreshExpiresAt: rotated.refreshExpiresAt,
        user: publicUser(rotated.user),
      },
      req,
    );
  }

  // ---- logout ----
  if (path === "/api/auth/logout" && req.method === "POST") {
    const ctx = await requireAuth(req);
    revokeSession(ctx.session.jti);
    return ok({ loggedOut: true }, req);
  }

  // ---- password reset request ----
  if (path === "/api/auth/password-reset/request" && req.method === "POST") {
    const limited = limits.resetPer10Min(ip);
    if (limited > 0) return err(429, `too many requests, retry in ${limited}s`, req);

    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const email = v.email(body, "email");

    // Always answer identically to avoid account enumeration.
    const user = stmts.userByEmail.get(email);
    if (user && user.status === "active") {
      const token = randomToken(32);
      db.prepare(
        "INSERT INTO password_tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, 'reset', ?)",
      ).run(sha256Hex(token), user.id, Date.now() + LIMITS.passwordTokenTtlMs);
      void sendResetEmail(email, token);
      audit("password.reset.requested", { target: user.id, ip });
    }
    return ok({ message: "If the account exists, a reset email is on its way." }, req);
  }

  // ---- password reset / invite confirm ----
  if (path === "/api/auth/password-reset/confirm" && req.method === "POST") {
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const token = v.str(body, "token", { min: 20, max: 256 })!;
    const password = v.str(body, "password", { min: 1, max: 256 })!;
    passwordPolicy(password);

    const tokenHash = sha256Hex(token);
    const row = db
      .prepare<{ user_id: string; kind: string; expires_at: number; used_at: number | null }, [string]>(
        "SELECT user_id, kind, expires_at, used_at FROM password_tokens WHERE token_hash = ?",
      )
      .get(tokenHash);

    if (!row || row.used_at || row.expires_at < Date.now()) {
      return err(400, "link is invalid or has expired", req);
    }

    const newHash = await hashPassword(password);
    const claimed = db.transaction(() => {
      const result = db.prepare(
        "UPDATE password_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at >= ?",
      ).run(Date.now(), tokenHash, Date.now());
      if (result.changes !== 1) return false;
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(newHash, row.user_id);
      return true;
    })();
    if (!claimed) return err(400, "link is invalid or has expired", req);
    revokeAllUserSessions(row.user_id);
    audit(`password.${row.kind}.completed`, { target: row.user_id, ip });
    const owner = stmts.userById.get(row.user_id);
    if (owner) {
      void sendSecurityAlert(
        owner.email,
        row.kind === "invite" ? "Your account password was set." : "Your password was changed.",
      );
    }

    return ok({ done: true }, req);
  }

  return null; // not an auth route
}
