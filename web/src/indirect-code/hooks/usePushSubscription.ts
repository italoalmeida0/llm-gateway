import { createSignal } from "solid-js";
import { api } from "../../api";

/**
 * Web Push subscription manager (Camada B: all tabs closed).
 *
 * One subscription per browser: the PushManager endpoint is registered
 * server-side on toggle-ON (with Notification permission granted) and
 * removed on toggle-OFF. The Service Worker (`web/push-sw.js`) renders
 * incoming pushes as OS notifications even with zero tabs open.
 */

function urlBase64ToBytes(base64: string): Uint8Array {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function browserLabel(): string {
  try {
    const ua = navigator.userAgent;
    const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
    const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
    return [browser, os].filter(Boolean).join(" ") || "Browser";
  } catch {
    return "Browser";
  }
}

export function pushSupported(): boolean {
  try {
    return "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
  } catch {
    return false;
  }
}

export function createPushSubscription(opts: {
  enabled: () => boolean;
  toast: (message: string, kind?: "ok" | "err") => void;
}) {
  const [subscribed, setSubscribed] = createSignal(false);
  const [supported] = createSignal(pushSupported());
  let syncing = false;

  async function currentEndpoint(): Promise<string | null> {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      return sub?.endpoint ?? null;
    } catch {
      return null;
    }
  }

  /** Align server state with (toggle, permission): subscribe or unsubscribe. */
  async function sync(): Promise<void> {
    if (syncing || !supported()) return;
    syncing = true;
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription().catch(() => null);
      if (!opts.enabled()) {
        if (existing) {
          const endpoint = existing.endpoint;
          await existing.unsubscribe().catch(() => {});
          await api("POST", "/api/push/unsubscribe", { endpoint }).catch(() => {});
        }
        setSubscribed(false);
        return;
      }
      if (Notification.permission !== "granted") {
        setSubscribed(!!existing);
        return;
      }
      if (existing) {
        setSubscribed(true);
        return;
      }
      const { publicKey } = await api<{ success: boolean; publicKey: string }>(
        "GET",
        "/api/push/vapid-key",
      );
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBytes(publicKey).buffer as ArrayBuffer,
      });
      const raw = sub.toJSON();
      await api("POST", "/api/push/subscribe", {
        endpoint: sub.endpoint,
        keys: { p256dh: raw.keys?.p256dh ?? "", auth: raw.keys?.auth ?? "" },
        label: browserLabel(),
      });
      setSubscribed(true);
    } catch (e: any) {
      console.warn("[push] sync failed:", e);
      opts.toast(`Push setup failed: ${e?.message || e}`, "err");
      setSubscribed(false);
    } finally {
      syncing = false;
    }
  }

  return { subscribed, supported, sync, currentEndpoint };
}

export type PushSubscription = ReturnType<typeof createPushSubscription>;
