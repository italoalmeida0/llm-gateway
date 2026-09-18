import { createSignal } from "solid-js";
import type { DaemonCommand } from "../daemon-protocol";

export interface DaemonUpdateInfo {
  current: string;
  available: string;
  checkedAt: number;
  autoUpdate: boolean;
  frozen: boolean;
  freezeStage: string;
  error?: string;
}

/** Per-host update lifecycle: pending -> updating -> done | failed.
 * Persisted in localStorage so F5 / reconnect / host switch never loses
 * the state of an update started on another host. The daemon stays the
 * source of truth for versions (daemon_update), but the lifecycle flags
 * (who is updating, what finished) are owned here per hostId. */
export type UpdateLifecycle = "idle" | "pending" | "updating" | "done" | "failed";

export interface HostUpdateState extends DaemonUpdateInfo {
  lifecycle: UpdateLifecycle;
  target?: string;
  failedReason?: string;
  finishedAt?: number;
}

const LS_KEY = "llmgw-rc-updates";

function readStore(): Record<string, HostUpdateState> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(s: Record<string, HostUpdateState>) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {}
}

function blank(): HostUpdateState {
  return {
    current: "", available: "", checkedAt: 0, autoUpdate: true,
    frozen: false, freezeStage: "", lifecycle: "idle",
  };
}

/** Daemon self-update state, tracked PER HOST: fed by daemon_update
 * events (tagged with hostId by the dispatcher), commands to
 * check/apply/toggle. Auto-update defaults true (daemon-side nil). */
export function createDaemonUpdate(opts: {
  send: (payload: DaemonCommand) => void;
  toast: (message: string, kind?: "ok" | "err") => void;
  getHostId: () => string;
}) {
  const [states, setStates] = createSignal<Record<string, HostUpdateState>>(readStore());

  function persist(next: Record<string, HostUpdateState>) {
    setStates(next);
    writeStore(next);
  }

  function patch(hostId: string, p: Partial<HostUpdateState>) {
    if (!hostId) return;
    const next = { ...states() };
    next[hostId] = { ...(next[hostId] ?? blank()), ...p };
    persist(next);
  }

  /** Foreground host view: the page renders info()/applying() for the
   * active host only; switching hosts swaps the whole world (same rule
   * as sessions/mirror). */
  function info(): HostUpdateState | null {
    return states()[opts.getHostId()] ?? null;
  }

  function stateFor(hostId: string): HostUpdateState | null {
    return states()[hostId] ?? null;
  }

  function applying(): boolean {
    const s = info();
    return !!s && (s.lifecycle === "pending" || s.lifecycle === "updating");
  }

  function applyingFor(hostId: string): boolean {
    const s = states()[hostId];
    return !!s && (s.lifecycle === "pending" || s.lifecycle === "updating");
  }

  function noteUpdate(hostId: string, msg: any) {
    if (!hostId || !msg || typeof msg !== "object") return;
    const prev = states()[hostId];
    const frozen = !!msg.frozen;
    patch(hostId, {
      current: String(msg.current ?? prev?.current ?? ""),
      available: String(msg.available ?? ""),
      checkedAt: Number(msg.checkedAt ?? 0),
      autoUpdate: msg.autoUpdate !== false,
      frozen,
      freezeStage: String(msg.freezeStage ?? ""),
      error: typeof msg.error === "string" ? msg.error : undefined,
      // Freeze broadcast arrived after our apply click: the handoff is
      // really running on this host now (F5-safe: frozen survives).
      lifecycle: frozen ? "updating" : prev?.lifecycle === "updating" && !frozen ? prev.lifecycle : prev?.lifecycle ?? "idle",
    });
  }

  function checkNow(hostId?: string) {
    opts.send({ type: "daemon_update_check", hostId: hostId || opts.getHostId() || undefined });
  }

  function toggle(enabled: boolean, hostId?: string) {
    const hid = hostId || opts.getHostId();
    opts.send({ type: "daemon_update_toggle", enabled, hostId: hid || undefined });
    // Optimistic: daemon broadcasts authoritative state right after.
    if (hid) patch(hid, { autoUpdate: enabled });
  }

  function apply(hostId?: string) {
    const hid = hostId || opts.getHostId();
    const cur = hid ? states()[hid] : info();
    if (!cur || !cur.available || cur.available === cur.current) {
      opts.toast("No update available to apply", "err");
      return;
    }
    // Full-slot handoff: the daemon downloads the launcher, freezes late,
    // copies, takes over and promotes. Failure unfreezes, WS never drops.
    // The daemon reports frozen/freezeStage, then update_done/failed.
    // Lifecycle is per-host + persisted: F5/reconnect/host-switch keeps
    // showing the right host as updating.
    patch(hid, { lifecycle: "pending", target: cur.available, failedReason: undefined });
    opts.send({ type: "daemon_update_apply", hostId: hid || undefined });
    opts.toast(`Updating to ${cur.available}…`, "ok");
  }

  function cancel(hostId?: string) {
    const hid = hostId || opts.getHostId();
    opts.send({ type: "daemon_update_cancel", hostId: hid || undefined });
    if (hid) {
      const s = states()[hid];
      if (s && (s.lifecycle === "pending" || s.lifecycle === "updating")) {
        patch(hid, { lifecycle: "failed", failedReason: "cancelled by user", finishedAt: Date.now() });
      }
    }
  }

  function noteFailed(hostId: string, reason: string) {
    if (hostId) patch(hostId, { lifecycle: "failed", failedReason: reason, finishedAt: Date.now() });
    opts.toast(`Update failed: ${reason}`, "err");
  }

  function noteDone(hostId: string, version: string) {
    if (hostId) {
      patch(hostId, {
        lifecycle: "done", current: version || states()[hostId]?.current || "",
        available: "", frozen: false, freezeStage: "", finishedAt: Date.now(),
      });
    }
    // Reload so the whole SPA reboots against the new daemon (fresh
    // protocol, fresh state). Persist the toast across the reload; the
    // boot path shows it once and clears it (cleanup = no stale-notice
    // breach on the NEXT update).
    try {
      localStorage.setItem("llmgw-update-done", version || "done");
    } catch {}
    setTimeout(() => window.location.reload(), 1200);
    opts.toast(`Daemon updated to ${version} — reloading…`, "ok");
  }

  /** Boot cleanup: show + clear a pending post-reload update toast. */
  function consumePostReloadToast() {
    let v: string | null = null;
    try {
      v = localStorage.getItem("llmgw-update-done");
      if (v) localStorage.removeItem("llmgw-update-done");
    } catch {}
    if (v) opts.toast(`Daemon updated to ${v}`, "ok");
    return v;
  }

  /** Host removed: drop its update state (no ghost "updating" rows). */
  function forgetHost(hostId: string) {
    if (!hostId) return;
    const next = { ...states() };
    if (next[hostId]) {
      delete next[hostId];
      persist(next);
    }
  }

  return { info, stateFor, states, applying, applyingFor, noteUpdate, checkNow, toggle, apply, cancel, noteFailed, noteDone, consumePostReloadToast, forgetHost };
}

export type DaemonUpdate = ReturnType<typeof createDaemonUpdate>;
