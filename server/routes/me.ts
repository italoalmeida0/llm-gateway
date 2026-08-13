import QRCode from "qrcode";

import { LIMITS } from "../config";
import { db, stmts, audit } from "../db";
import {
  hashPassword,
  verifyPassword,
  newTotpSecret,
  totpUri,
  totpVerify,
  sha256Hex,
} from "../crypto";
import {
  requireAuth,
  revokeAllUserSessions,
  revokeSession,
  publicUser,
} from "../auth";
import { verifyGoogleIdToken } from "../google";
import { sendSecurityAlert } from "../email";
import { ApiError, clientIp, err, ok, readJsonBody, v } from "../http";
import { bruteforceFail, bruteforceLocked, consumeTotpCode } from "../ratelimit";

/**
 * /api/me/* — profile, password, TOTP, Google linking, session management.
 * Everything here requires a valid Bearer access token.
 */

export async function handleMeRoute(path: string, req: Request): Promise<Response | null> {
  // ---- profile ----
  if (path === "/api/me" && req.method === "GET") {
    const ctx = await requireAuth(req);
    return ok({ user: publicUser(ctx.user) }, req);
  }

  if (path === "/api/me" && req.method === "PATCH") {
    const ctx = await requireAuth(req);
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const name = v.str(body, "name", { min: 1, max: 128 })!;
    db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, ctx.user.id);
    return ok({ user: publicUser(stmts.userById.get(ctx.user.id)!) }, req);
  }

  // ---- password set/change ----
  if (path === "/api/me/password" && req.method === "POST") {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const newPassword = v.str(body, "newPassword", { min: 1, max: 256 })!;
    if (newPassword.length < 10) throw new ApiError(400, "password must be at least 10 characters");

    if (ctx.user.password_hash) {
      const current = v.str(body, "currentPassword", { min: 1, max: 256 })!;
      const locked = bruteforceLocked(`pwchange:${ctx.user.id}`);
      if (locked > 0) return err(429, `too many attempts, retry in ${locked}s`, req);
      if (!(await verifyPassword(current, ctx.user.password_hash))) {
        bruteforceFail(`pwchange:${ctx.user.id}`);
        return err(401, "current password is incorrect", req);
      }
    }

    const newHash = await hashPassword(newPassword);
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(newHash, ctx.user.id);
    revokeAllUserSessions(ctx.user.id, ctx.session.jti); // keep this session
    audit("password.changed", { actorId: ctx.user.id, ip });
    void sendSecurityAlert(ctx.user.email, "Your password was changed.");
    return ok({ done: true }, req);
  }

  // ---- TOTP setup: generate pending secret + QR ----
  if (path === "/api/me/2fa/setup" && req.method === "POST") {
    const ctx = await requireAuth(req);
    const secret = newTotpSecret();
    db.prepare("UPDATE users SET totp_pending = ? WHERE id = ?").run(secret, ctx.user.id);
    const uri = totpUri(secret, ctx.user.email);
    const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 220 });
    return ok({ secret, otpauthUri: uri, qrDataUrl }, req);
  }

  if (path === "/api/me/2fa/enable" && req.method === "POST") {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    if (!ctx.user.totp_pending) return err(400, "run setup first", req);
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const code = v.str(body, "code", { min: 6, max: 6 })!;

    if (!(await totpVerify(ctx.user.totp_pending, code))) {
      return err(400, "invalid code — check your authenticator clock", req);
    }
    db.prepare("UPDATE users SET totp_secret = totp_pending, totp_pending = NULL WHERE id = ?").run(
      ctx.user.id,
    );
    audit("2fa.enabled", { actorId: ctx.user.id, ip });
    void sendSecurityAlert(ctx.user.email, "Two-factor authentication was enabled.");
    return ok({ enabled: true }, req);
  }

  if (path === "/api/me/2fa/disable" && req.method === "POST") {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    if (!ctx.user.totp_secret) return err(400, "2FA is not enabled", req);
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const code = v.str(body, "code", { min: 6, max: 6 })!;

    const locked = bruteforceLocked(`2fadisable:${ctx.user.id}`);
    if (locked > 0) return err(429, `too many attempts, retry in ${locked}s`, req);
    const valid = await totpVerify(ctx.user.totp_secret, code);
    if (!valid || !consumeTotpCode(sha256Hex(`${ctx.user.totp_secret}:${code}`))) {
      bruteforceFail(`2fadisable:${ctx.user.id}`);
      return err(401, "invalid code", req);
    }

    db.prepare("UPDATE users SET totp_secret = NULL, totp_pending = NULL WHERE id = ?").run(
      ctx.user.id,
    );
    audit("2fa.disabled", { actorId: ctx.user.id, ip });
    void sendSecurityAlert(ctx.user.email, "Two-factor authentication was disabled.");
    return ok({ disabled: true }, req);
  }

  // ---- Google link / unlink ----
  if (path === "/api/me/google/link" && req.method === "POST") {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const idToken = v.str(body, "idToken", { min: 20, max: 8192 })!;

    const identity = await verifyGoogleIdToken(idToken);
    if (!identity.emailVerified) return err(400, "Google email must be verified", req);
    if (identity.email !== ctx.user.email.toLowerCase()) {
      return err(400, "Google account email does not match your account email", req);
    }
    const existing = stmts.userByGoogleId.get(identity.sub);
    if (existing && existing.id !== ctx.user.id) {
      return err(409, "this Google account is linked to another user", req);
    }

    db.prepare("UPDATE users SET google_id = ? WHERE id = ?").run(identity.sub, ctx.user.id);
    audit("google.linked", { actorId: ctx.user.id, ip });
    return ok({ linked: true }, req);
  }

  if (path === "/api/me/google/link" && req.method === "DELETE") {
    const ctx = await requireAuth(req);
    const ip = clientIp(req);
    if (!ctx.user.google_id) return err(400, "no Google account linked", req);
    if (!ctx.user.password_hash) {
      return err(400, "set a password before unlinking Google", req);
    }
    db.prepare("UPDATE users SET google_id = NULL WHERE id = ?").run(ctx.user.id);
    audit("google.unlinked", { actorId: ctx.user.id, ip });
    return ok({ linked: false }, req);
  }

  // ---- sessions ----
  if (path === "/api/me/sessions" && req.method === "GET") {
    const ctx = await requireAuth(req);
    const rows = db
      .prepare(
        `SELECT jti, created_at, last_used_at, expires_at, ip, ua, label
         FROM sessions WHERE user_id = ? AND revoked = 0 AND abs_expires_at > ?
         ORDER BY last_used_at DESC LIMIT 50`,
      )
      .all(ctx.user.id, Date.now()) as any[];
    return ok(
      {
        sessions: rows.map((s) => ({
          jti: s.jti,
          createdAt: s.created_at,
          lastUsedAt: s.last_used_at,
          expiresAt: s.expires_at,
          ip: s.ip,
          ua: s.ua,
          label: s.label,
          current: s.jti === ctx.session.jti,
        })),
      },
      req,
    );
  }

  if (path.startsWith("/api/me/sessions/") && req.method === "PATCH") {
    const ctx = await requireAuth(req);
    const jti = path.slice("/api/me/sessions/".length).trim();
    if (!jti || jti.length > 128) return err(400, "invalid session id", req);
    const target = stmts.sessionByJti.get(jti);
    if (!target || target.user_id !== ctx.user.id) return err(404, "session not found", req);
    const body = await readJsonBody(req, LIMITS.authBodyBytes);
    const label = v.str(body, "label", { max: 64, optional: true });
    db.prepare("UPDATE sessions SET label = ? WHERE jti = ?").run(label || null, jti);
    return ok({ done: true }, req);
  }

  if (path.startsWith("/api/me/sessions/") && req.method === "DELETE") {
    const ctx = await requireAuth(req);
    const jti = path.slice("/api/me/sessions/".length).trim();
    if (!jti || jti.length > 128) return err(400, "invalid session id", req);
    const target = stmts.sessionByJti.get(jti);
    if (!target || target.user_id !== ctx.user.id) return err(404, "session not found", req);
    revokeSession(jti);
    return ok({ revoked: true }, req);
  }

  return null;
}
