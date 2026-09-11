import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import webpush from "web-push";

import { DATA_DIR, PUBLIC_URL } from "./config";
import { db } from "./db";

/**
 * Web Push for turn-end notifications with no tab open.
 *
 * Flow: the browser subscribes its PushManager (VAPID) and POSTs the
 * subscription here; when the relay sees a turn finish while the user has
 * zero connected tabs, it fans out an encrypted push per subscription.
 * Payloads carry only display text (title/body/url) — never secrets.
 */

export interface PushSubscriptionRow {
  endpoint: string;
  user_id: string;
  p256dh: string;
  auth: string;
  label: string;
  created_at: number;
}

export interface TurnPush {
  /** Public session title (or id fallback), safe for the lock screen. */
  title: string;
  /** Host display name. */
  host: string;
  /** "done" | "error" | "cancelled" — varies the notification text. */
  disposition: "done" | "error" | "cancelled";
  /** Deep link the Service Worker opens on click. */
  url: string;
}

const VAPID_FILE = path.join(DATA_DIR, "vapid.json");

function loadVapidKeys(): { publicKey: string; privateKey: string } {
  try {
    if (existsSync(VAPID_FILE)) {
      const raw = JSON.parse(readFileSync(VAPID_FILE, "utf8")) as {
        publicKey?: unknown;
        privateKey?: unknown;
      };
      if (typeof raw.publicKey === "string" && typeof raw.privateKey === "string") {
        return { publicKey: raw.publicKey, privateKey: raw.privateKey };
      }
    }
  } catch {}
  const keys = webpush.generateVAPIDKeys();
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(VAPID_FILE, JSON.stringify(keys), { mode: 0o600 });
  } catch (e) {
    console.warn("[PUSH] could not persist VAPID keys:", e);
  }
  return keys;
}

const vapidKeys = loadVapidKeys();
webpush.setVapidDetails(`mailto:${process.env.ADMIN_EMAIL || "admin@localhost"}`, vapidKeys.publicKey, vapidKeys.privateKey);

/** Public VAPID key the browser uses in pushManager.subscribe(). */
export function vapidPublicKey(): string {
  return vapidKeys.publicKey;
}

export function listSubscriptions(userId: string): PushSubscriptionRow[] {
  return db
    .prepare<PushSubscriptionRow, [string]>("SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at ASC")
    .all(userId);
}

export function saveSubscription(
  userId: string,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  label: string,
): void {
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
       auth = excluded.auth, label = excluded.label`,
  ).run(sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, label, Date.now());
}

export function deleteSubscription(userId: string, endpoint: string): boolean {
  const row = db
    .prepare<{ endpoint: string }, [string, string]>("SELECT endpoint FROM push_subscriptions WHERE user_id = ? AND endpoint = ?")
    .get(userId, endpoint);
  if (!row) return false;
  db.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").run(userId, endpoint);
  return true;
}

/** Push payload: display-only, no secrets (lock screens show these). */
export function buildTurnPayload(push: TurnPush): string {
  const title =
    push.disposition === "error"
      ? `Turn failed — ${push.title}`
      : push.disposition === "cancelled"
        ? `Turn cancelled — ${push.title}`
        : `Turn finished — ${push.title}`;
  return JSON.stringify({
    title,
    body: `${push.host} · tap to open`,
    url: push.url || `${PUBLIC_URL}/#/code`,
    // Unique per event so the OS stacks instead of replacing (same
    // behavior as the in-tab Notification tag).
    tag: `turn-${push.host}-${push.title}-${Math.floor(Math.random() * 0xffffff)
      .toString(16)
      .padStart(6, "0")}`,
  });
}

/**
 * Fire-and-forget fan-out. Never throws: delivery failures only log, and
 * dead subscriptions (410/404 from the push service) are pruned so the
 * table does not rot.
 */
export async function sendTurnPush(userId: string, push: TurnPush): Promise<void> {
  const subs = listSubscriptions(userId);
  if (subs.length === 0) return;
  const payload = buildTurnPayload(push);
  await Promise.allSettled(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { TTL: 3600 },
        );
      } catch (e: any) {
        const code = e?.statusCode;
        if (code === 404 || code === 410) {
          try {
            db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(s.endpoint);
          } catch {}
        } else {
          console.warn(`[PUSH] send failed (${code ?? e?.message ?? e})`);
        }
      }
    }),
  );
}
