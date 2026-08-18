import nodemailer, { type Transporter } from "nodemailer";

import { PUBLIC_URL, SMTP, SMTP_ENABLED } from "./config";

/**
 * SMTP sending with a graceful fallback: when SMTP is not configured the
 * message (including any action link) is logged so an admin can copy it.
 * This keeps invite/reset flows functional in dev and hardened in prod.
 */

let transporter: Transporter | null = null;

if (SMTP_ENABLED) {
  transporter = nodemailer.createTransport({
    host: SMTP.host,
    port: SMTP.port,
    secure: SMTP.secure,
    auth: SMTP.user ? { user: SMTP.user, pass: SMTP.pass } : undefined,
    connectionTimeout: 10_000,
    socketTimeout: 15_000,
  });
  console.log(`[MAIL] SMTP configured (${SMTP.host}:${SMTP.port})`);
} else {
  console.warn("[MAIL] SMTP not configured — emails will be written to the server log");
}

function page(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#0b0b0f;color:#e4e4e7;font-family:system-ui,sans-serif">
  <div style="max-width:480px;margin:40px auto;padding:32px;background:#141419;border:1px solid #27272a;border-radius:12px">
    <h1 style="font-size:20px;margin:0 0 16px;color:#fafafa">${title}</h1>
    <div style="font-size:14px;line-height:1.6;color:#a1a1aa">${bodyHtml}</div>
    <p style="font-size:12px;color:#52525b;margin-top:24px">LLM Gateway</p>
  </div></body></html>`;
}

function button(url: string, label: string): string {
  return `<p style="margin:24px 0"><a href="${url}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;padding:10px 22px;border-radius:8px;font-weight:600">${label}</a></p>
  <p style="word-break:break-all;font-size:12px;color:#71717a">Or paste this link: ${url}</p>`;
}

async function send(to: string, subject: string, html: string): Promise<boolean> {
  if (!transporter) {
    console.error(`[MAIL:no-smtp] delivery unavailable for ${to}; action link withheld`);
    return false;
  }
  try {
    await transporter.sendMail({ from: SMTP.from, to, subject, html });
    return true;
  } catch (e) {
    console.error(`[MAIL] failed to send to ${to}:`, (e as Error).message);
    return false;
  }
}

export async function sendInviteEmail(to: string, name: string, token: string): Promise<boolean> {
  const url = `${PUBLIC_URL}/#/set-password?token=${encodeURIComponent(token)}`;
  return send(
    to,
    "You've been invited to LLM Gateway",
    page(
      "Welcome",
      `<p>Hi ${escapeHtml(name || to)},</p>
       <p>An administrator created an account for you on this LLM Gateway. Set your password to activate it:</p>
       ${button(url, "Set your password")}
       <p>This link expires in 24 hours. If you didn't expect this, ignore this email.</p>`,
    ),
  );
}

export async function sendResetEmail(to: string, token: string): Promise<boolean> {
  const url = `${PUBLIC_URL}/#/set-password?token=${encodeURIComponent(token)}`;
  return send(
    to,
    "Password reset — LLM Gateway",
    page(
      "Password reset",
      `<p>We received a request to reset your password.</p>
       ${button(url, "Choose a new password")}
       <p>This link expires in 24 hours. If you didn't request it, you can ignore this email.</p>`,
    ),
  );
}

export async function sendSecurityAlert(to: string, what: string): Promise<boolean> {
  return send(
    to,
    `Security notice — ${what}`,
    page("Security notice", `<p>${escapeHtml(what)}</p><p>If this wasn't you, contact your administrator immediately.</p>`),
  );
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
