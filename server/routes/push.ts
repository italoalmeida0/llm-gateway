import { requireAuth } from "../auth";
import { audit, db } from "../db";
import { clientIp, err, json, readJsonBody, v } from "../http";
import { deleteSubscription, listSubscriptions, saveSubscription, vapidPublicKey } from "../push";

/**
 * Web Push REST endpoints (per-device subscriptions):
 *  - GET    /api/push/vapid-key   -> public VAPID key for pushManager.subscribe()
 *  - GET    /api/push/subscriptions -> user's devices (endpoint host + label, never keys)
 *  - POST   /api/push/subscribe   -> upsert this browser's subscription
 *  - POST   /api/push/unsubscribe -> remove one subscription by endpoint
 */

const MAX_SUBS_PER_USER = 20;

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "";
  }
}

export async function handlePushRoute(path: string, req: Request, _url: URL): Promise<Response | null> {
  if (path === "/api/push/vapid-key" && req.method === "GET") {
    return json({ success: true, publicKey: vapidPublicKey() }, { req });
  }

  if (path === "/api/push/subscriptions" && req.method === "GET") {
    const { user } = await requireAuth(req);
    const subs = listSubscriptions(user.id).map((s) => ({
      endpoint: s.endpoint,
      pushService: endpointHost(s.endpoint),
      label: s.label,
      createdAt: s.created_at,
    }));
    return json({ success: true, subscriptions: subs }, { req });
  }

  if (path === "/api/push/subscribe" && req.method === "POST") {
    const { user } = await requireAuth(req);
    const ip = clientIp(req);
    const body = await readJsonBody(req, 8 * 1024);
    const endpoint = v.str(body, "endpoint", { min: 10, max: 2048 })!;
    const label = v.str(body, "label", { max: 64, optional: true }) ?? "";
    const keys = body.keys;
    if (typeof keys !== "object" || keys === null || Array.isArray(keys)) {
      return err(400, "keys must be an object", req);
    }
    const p256dh = (keys as Record<string, unknown>).p256dh;
    const auth = (keys as Record<string, unknown>).auth;
    if (typeof p256dh !== "string" || p256dh.length < 10 || p256dh.length > 512) {
      return err(400, "keys.p256dh is invalid", req);
    }
    if (typeof auth !== "string" || auth.length < 10 || auth.length > 512) {
      return err(400, "keys.auth is invalid", req);
    }
    const count = db
      .prepare<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?")
      .get(user.id)!.n;
    const exists = db
      .prepare<{ endpoint: string }, [string, string]>(
        "SELECT endpoint FROM push_subscriptions WHERE user_id = ? AND endpoint = ?",
      )
      .get(user.id, endpoint);
    if (count >= MAX_SUBS_PER_USER && !exists) {
      return err(429, "too many push subscriptions for this user", req);
    }
    saveSubscription(user.id, { endpoint, keys: { p256dh, auth } }, label);
    audit("push.subscribed", { actorId: user.id, ip, meta: { pushService: endpointHost(endpoint), label } });
    return json({ success: true }, { req });
  }

  if (path === "/api/push/unsubscribe" && req.method === "POST") {
    const { user } = await requireAuth(req);
    const ip = clientIp(req);
    const body = await readJsonBody(req, 8 * 1024);
    const endpoint = v.str(body, "endpoint", { min: 10, max: 2048 })!;
    const removed = deleteSubscription(user.id, endpoint);
    if (removed) audit("push.unsubscribed", { actorId: user.id, ip, meta: { pushService: endpointHost(endpoint) } });
    return json({ success: true, removed }, { req });
  }

  return null;
}
