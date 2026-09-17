import { createSignal } from "solid-js";
import type { DaemonCommand } from "../daemon-protocol";

export interface DaemonUpdateInfo {
  current: string;
  available: string;
  staged: string;
  checkedAt: number;
  autoUpdate: boolean;
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
      staged: String(msg.staged ?? ""),
      checkedAt: Number(msg.checkedAt ?? 0),
      autoUpdate: msg.autoUpdate !== false,
      error: typeof msg.error === "string" ? msg.error : undefined,
    });
    if (applying() && String(msg.staged ?? "") !== "") {
      // Apply acknowledged (staged arrived after our apply click while a
      // restart was already in flight) — nothing to do.
      setApplying(false);
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
    if (!cur || !cur.staged || cur.staged === cur.current) {
      opts.toast("No staged update to apply", "err");
      return;
    }
    setApplying(true);
    opts.send({ type: "daemon_update_apply" });
    opts.toast(`Restarting into ${cur.staged}…`, "ok");
    // If the daemon never restarts (e.g. apply rejected), unstick.
    setTimeout(() => setApplying(false), 15000);
  }

  return { info, applying, noteUpdate, checkNow, toggle, apply };
}

export type DaemonUpdate = ReturnType<typeof createDaemonUpdate>;
