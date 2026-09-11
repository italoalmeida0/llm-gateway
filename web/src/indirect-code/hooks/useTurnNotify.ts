import { createSignal } from "solid-js";
import type { DaemonMessage } from "../daemon-protocol";
import type { RemoteHostDto } from "../../api";

/**
 * Turn-end browser notification (Camada A: at least one tab open).
 *
 * Trigger: `session_status: idle` arriving for a turn we saw running — the
 * daemon's finishTurn() is the only real turn end. `turn_end` agent events
 * fire per model step (tools continue after them), so they only enrich the
 * text (done/error/cancelled), never notify by themselves.
 *
 * Runs BEFORE the page's active-host filter so turns on any host/session
 * notify (user decision). Click focuses the window and navigates to the
 * finished session.
 */

export type TurnDisposition = "done" | "error" | "cancelled";

export interface TurnNotifyTarget {
  hostId: string;
  sessionId: string;
  title: string;
  hostName: string;
  disposition: TurnDisposition;
}

const MASTER_KEY = "llmgw-rc-turn-notify";
const SOUND_KEY = "llmgw-rc-turn-sound";

export function isTurnNotifyEnabled(): boolean {
  try {
    return localStorage.getItem(MASTER_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setTurnNotifyEnabled(v: boolean): void {
  try {
    localStorage.setItem(MASTER_KEY, v ? "1" : "0");
  } catch {}
}

export function isTurnSoundEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setTurnSoundEnabled(v: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, v ? "1" : "0");
  } catch {}
}

/** Pure text builder (unit-tested without Notification). */
export function turnNotifyText(t: Pick<TurnNotifyTarget, "title" | "hostName" | "disposition">): {
  title: string;
  body: string;
} {
  const title =
    t.disposition === "error"
      ? `Turn failed — ${t.title}`
      : t.disposition === "cancelled"
        ? `Turn cancelled — ${t.title}`
        : `Turn finished — ${t.title}`;
  return { title, body: `${t.hostName} · tap to open` };
}

/** Short WebAudio chime (hand-rolled: zero deps, zero assets). */
function playChime(): void {
  try {
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx: AudioContext = new Ctx();
    void ctx.resume?.().catch(() => {});
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    osc.onended = () => void ctx.close().catch(() => {});
  } catch {}
}

export function createTurnNotify(opts: {
  hosts: () => RemoteHostDto[];
  sessions: () => { id: string; title: string }[];
  toast: (message: string, kind?: "ok" | "err") => void;
  onOpenSession: (hostId: string, sessionId: string) => void;
}) {
  const [notifyOn, setNotifyOn] = createSignal(isTurnNotifyEnabled());
  const [soundOn, setSoundOn] = createSignal(isTurnSoundEnabled());
  const [permission, setPermission] = createSignal<
    typeof Notification.permission | "unsupported"
  >(typeof Notification === "undefined" ? "unsupported" : Notification.permission);

  /** Turns currently running, keyed `hostId:sessionId`. */
  const running = new Map<string, TurnDisposition>();

  function setEnabled(v: boolean): void {
    setTurnNotifyEnabled(v);
    setNotifyOn(v);
    if (v) void ensurePermission();
  }

  function setSound(v: boolean): void {
    setTurnSoundEnabled(v);
    setSoundOn(v);
  }

  async function ensurePermission(): Promise<boolean> {
    if (typeof Notification === "undefined") {
      setPermission("unsupported");
      return false;
    }
    if (Notification.permission === "granted") {
      setPermission("granted");
      return true;
    }
    if (Notification.permission === "denied") {
      setPermission("denied");
      return false;
    }
    try {
      const res = await Notification.requestPermission();
      setPermission(res);
      return res === "granted";
    } catch {
      return false;
    }
  }

  function resolveNames(hostId: string, sessionId: string): { hostName: string; title: string } {
    const host = opts.hosts().find((h) => h.id === hostId);
    const session = opts.sessions().find((s) => s.id === sessionId);
    return {
      hostName: host?.name || host?.hostname || "host",
      title: session?.title || sessionId.slice(0, 12),
    };
  }

  function showNotification(target: TurnNotifyTarget): void {
    const { title, body } = turnNotifyText(target);
    const go = () => opts.onOpenSession(target.hostId, target.sessionId);
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        const n = new Notification(title, { body, tag: `turn-${target.hostId}-${target.sessionId}` });
        n.onclick = () => {
          try {
            window.focus();
          } catch {}
          go();
          n.close();
        };
      } catch {
        opts.toast(`${title} — ${body}`, "ok");
      }
    } else {
      opts.toast(`${title} — ${body}`, "ok");
    }
    if (soundOn()) playChime();
  }

  /**
   * Feed every inbound daemon message BEFORE the active-host filter.
   * Returns true when the message was a turn boundary (for tests).
   */
  function noteMessage(msg: DaemonMessage): boolean {
    if (!notifyOn()) return false;
    if (!msg || typeof msg !== "object" || !("type" in msg)) return false;
    const hostId = (msg as { hostId?: unknown }).hostId;
    if (typeof hostId !== "string" || !hostId) return false;
    if (msg.type === "agent_event") {
      const ev = (msg as { sessionId?: unknown; event?: unknown }).event as
        | { type?: unknown; cancelled?: unknown; error?: unknown }
        | undefined;
      const sessionId = (msg as { sessionId?: unknown }).sessionId;
      if (typeof sessionId !== "string" || !sessionId || !ev || typeof ev !== "object") return false;
      const key = `${hostId}:${sessionId}`;
      if (ev.type === "turn_start") {
        running.set(key, "done");
        return true;
      }
      if (ev.type === "turn_end" && running.has(key)) {
        running.set(
          key,
          ev.cancelled === true ? "cancelled" : typeof ev.error === "string" && ev.error ? "error" : "done",
        );
        return true;
      }
      return false;
    }
    if (msg.type === "session_status") {
      const m = msg as { sessionId?: unknown; status?: unknown };
      if (typeof m.sessionId !== "string" || !m.sessionId) return false;
      const key = `${hostId}:${m.sessionId}`;
      if (m.status === "running") {
        running.set(key, running.get(key) ?? "done");
        return true;
      }
      if (m.status === "idle") {
        const disposition = running.get(key);
        // Only notify for turns we actually saw running: stray idles
        // (reconnect replays, compaction) must stay silent.
        if (disposition === undefined) return false;
        running.delete(key);
        const { hostName, title } = resolveNames(hostId, m.sessionId);
        showNotification({ hostId, sessionId: m.sessionId, title, hostName, disposition });
        return true;
      }
      return false;
    }
    return false;
  }

  /** Manual test button in Settings. */
  function testNotify(): void {
    if (!notifyOn()) {
      opts.toast("Turn notifications are off", "err");
      return;
    }
    void ensurePermission().then((granted) => {
      if (!granted && typeof Notification !== "undefined" && Notification.permission !== "granted") {
        opts.toast("Browser notifications blocked — enable them in site settings", "err");
        return;
      }
      showNotification({
        hostId: "test",
        sessionId: "test",
        title: "Test conversation",
        hostName: "Test host",
        disposition: "done",
      });
    });
  }

  return { notifyOn, soundOn, permission, setEnabled, setSound, ensurePermission, noteMessage, testNotify };
}

export type TurnNotify = ReturnType<typeof createTurnNotify>;
