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

/** Daemon self-update state: fed by daemon_update events, commands to
 * check/apply/toggle. Auto-update defaults true (daemon-side nil). */
export function createDaemonUpdate(opts: {
  send: (payload: DaemonCommand) => void;
  toast: (message: string, kind?: "ok" | "err") => void;
}) {
  const [info, setInfo] = createSignal<DaemonUpdateInfo | null>(null);
  const [applying, setApplying] = createSignal(false);

  function noteUpdate(msg: any) {
    if (!msg || typeof msg !== "object") return;
    setInfo({
      current: String(msg.current ?? ""),
      available: String(msg.available ?? ""),
      checkedAt: Number(msg.checkedAt ?? 0),
      autoUpdate: msg.autoUpdate !== false,
      frozen: !!msg.frozen,
      freezeStage: String(msg.freezeStage ?? ""),
      error: typeof msg.error === "string" ? msg.error : undefined,
    });
    if (applying() && msg.frozen) {
      // Handoff started (freeze broadcast arrived after our apply click).
      // Keep applying=true until update_done/failed or timeout.
    }
  }

  function checkNow() {
    opts.send({ type: "daemon_update_check" });
  }

  function toggle(enabled: boolean) {
    opts.send({ type: "daemon_update_toggle", enabled });
    // Optimistic: daemon broadcasts authoritative state right after.
    setInfo((prev) => (prev ? { ...prev, autoUpdate: enabled } : prev));
  }

  function apply() {
    const cur = info();
    if (!cur || !cur.available || cur.available === cur.current) {
      opts.toast("No update available to apply", "err");
      return;
    }
    // Full-slot handoff: the daemon downloads the launcher, freezes late,
    // copies, takes over and promotes. Failure unfreezes, WS never drops.
    // The daemon reports frozen/freezeStage, then update_done/failed.
    setApplying(true);
    opts.send({ type: "daemon_update_apply" });
    opts.toast(`Updating to ${cur.available}…`, "ok");
    // Unstick if the daemon never reports back (it always broadcasts on
    // freeze/fail/done, but never trust the network).
    setTimeout(() => setApplying(false), 600000);
  }

  function cancel() {
    opts.send({ type: "daemon_update_cancel" });
    setApplying(false);
  }

  function noteFailed(reason: string) {
    setApplying(false);
    opts.toast(`Update failed: ${reason}`, "err");
  }

  function noteDone(version: string) {
    setApplying(false);
    opts.toast(`Daemon updated to ${version}`, "ok");
  }

  return { info, applying, noteUpdate, checkNow, toggle, apply, cancel, noteFailed, noteDone };
}

export type DaemonUpdate = ReturnType<typeof createDaemonUpdate>;
