import { createStore, reconcile } from "solid-js/store";
import { createSignal, untrack } from "solid-js";
import type { TurnBalloon, TurnChangedFile } from "../types";
import type { DaemonCommand } from "../daemon-protocol";

export type { TurnBalloon, TurnChangedFile };

export interface UndoFileResult {
  path: string;
  rel?: string;
  ok: boolean;
  message?: string;
}

/** Accept the old daemon's disk-shaped broadcasts as well as current wire data. */
function normalizeBalloon(b: any): TurnBalloon {
  return { ...b, turnIndex: b?.turnIndex ?? b?.turn_index,
    messageIndex: b?.messageIndex ?? b?.message_index,
    files: Array.isArray(b?.files) ? b.files : [] };
}

/** Per-turn file changes (snapshot-based, no git).
 *
 * The frontend only knows "changes": one balloon per finished turn (sitting
 * below its turn, persistent) plus at most one live balloon for the running
 * turn (floating above the composer). The daemon's incoming snapshot is an
 * internal detail — it only ever surfaces as live changes here.
 */
export function createTurnChanges(opts: {
  send: (payload: DaemonCommand) => void;
  getSessionId: () => string;
  toast: (message: string, kind?: "ok" | "err") => void;
  showConfirm?: (o: {
    title?: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
  }) => Promise<boolean>;
}) {
  const [state, setState] = createStore<{ balloons: TurnBalloon[] }>({ balloons: [] });
  const balloons = () => state.balloons;
  function setBalloons(value: TurnBalloon[] | ((prev: TurnBalloon[]) => TurnBalloon[])) {
    const next = typeof value === "function" ? untrack(() => value(state.balloons)) : value;
    setState("balloons", reconcile(next.map((b) => ({ ...b, id: String(b.turnIndex),
      files: b.files.map((f) => ({ ...f, id: f.path })),
    })), { merge: true }));
  }
  const [undoBusy, setUndoBusy] = createSignal<number | null>(null);
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});

  function reset() {
    setBalloons([]);
    setUndoBusy(null);
    setExpanded({});
  }

  function applySnapshot(r: any) {
    const list = (Array.isArray(r?.fileBalloons) ? r.fileBalloons : []).map(normalizeBalloon);
    setBalloons((prev) => [
      ...prev.filter((b) => b.live && r?.status === "running" && (!r.turnSeq || b.turnIndex === r.turnSeq) && !list.some((item: any) => item.turnIndex === b.turnIndex)),
      ...(Array.isArray(list) ? list : [])
        .filter((b: any) => (b?.files?.length || 0) > 0)
        .map((b: any) => ({ ...b, live: false })),
    ]);
  }

  /** Authoritative tail cut (edit/regenerate): drop balloons anchored
   * past the kept message prefix, mirroring the daemon's
   * dropBalloonsAbove. Unanchored balloons (no messageIndex) are kept. */
  function dropAbove(keepIndex: number) {
    setBalloons((prev) =>
      prev.filter(
        (b) =>
          typeof b.messageIndex !== "number" || b.messageIndex <= 0 || b.messageIndex <= keepIndex + 1,
      ),
    );
  }

  function upsert(balloon: any, live: boolean) {
    balloon = normalizeBalloon(balloon);
    if (!balloon || typeof balloon.turnIndex !== "number") return;
    const files = balloon.files || [];
    if (files.length === 0) {
      setBalloons((prev) => prev.filter((b) => b.turnIndex !== balloon.turnIndex || (live && !b.live)));
      return;
    }
    const next: TurnBalloon = {
      turnIndex: balloon.turnIndex,
      files,
      messageIndex: balloon.messageIndex,
      live,
    };
    setBalloons((prev) => {
      // Delayed live updates cannot replace the committed result.
      if (live && prev.some((b) => b.turnIndex === next.turnIndex && !b.live)) return prev;
      const out = [...prev.filter((b) => b.turnIndex !== next.turnIndex), next];
      out.sort((a, b) => a.turnIndex - b.turnIndex);
      return out;
    });
  }

  function noteBalloon(balloon: any, live: boolean) {
    upsert(balloon, live);
  }

  function requestBalloons() {
    if (!opts.getSessionId()) return;
    opts.send({ type: "get_turn_changes", sessionId: opts.getSessionId(), requestId: crypto.randomUUID() });
  }

  function noteTurnChanges(msg: any) {
    if (msg?.error) return;
    const list: TurnBalloon[] = (Array.isArray(msg?.balloons) ? msg.balloons : [])
      .map(normalizeBalloon)
      .filter((b: any) => typeof b?.turnIndex === "number" && b?.files?.length > 0)
      .map((b: any) => ({ ...b, live: false }));
    if (typeof msg?.live?.turnIndex === "number" && msg.live.files?.length > 0 &&
      !list.some((b) => b.turnIndex === msg.live.turnIndex)) list.push({ ...msg.live, live: true });
    // Apply once: clearing and re-adding live rows would remount their open diffs.
    setBalloons(list.sort((a, b) => a.turnIndex - b.turnIndex));
  }

  async function undoTurn(turnIndex: number, path?: string) {
    if (!opts.getSessionId() || undoBusy() !== null) return;
    if (opts.showConfirm) {
      const balloon = balloons().find((b) => b.turnIndex === turnIndex);
      const pendingFiles = (balloon?.files || []).filter((f) => !f.undone);
      const count = path ? 1 : (pendingFiles.length || balloon?.files?.length || 1);
      const confirmed = await opts.showConfirm({
        title: "Undo turn changes?",
        message: path
          ? `Revert changes to "${path}"? This will restore the file to its state before this turn.`
          : `Revert all file changes from this turn (${count} file${count === 1 ? "" : "s"})? This will restore files to their state before this turn.`,
        confirmText: "Revert changes",
        cancelText: "Cancel",
        danger: true,
      });
      if (!confirmed) return;
    }
    setUndoBusy(turnIndex);
    opts.send({
      type: "undo_turn_changes",
      sessionId: opts.getSessionId(),
      turnIndex,
      path,
      requestId: crypto.randomUUID(),
    });
  }

  function noteUndone(msg: any) {
    setUndoBusy(null);
    const results: UndoFileResult[] = Array.isArray(msg?.results) ? msg.results : [];
    const failed = results.filter((r) => !r.ok);
    if (msg?.error) {
      opts.toast(msg.error, "err");
      return;
    }
    if (msg?.complete === false || failed.length > 0) {
      opts.toast(
        msg?.warning || `Could not apply the complete undo (${failed.length} file(s) left unchanged).`,
        "err",
      );
    } else if (results.length > 0) {
      opts.toast(`Turn changes undone (${results.length} file(s)).`, "ok");
    }
    if (results.length > 0) {
      const okPaths = new Set(results.filter((r) => r.ok).map((r) => r.path));
      if (okPaths.size > 0 && typeof msg?.turnIndex === "number") {
        setBalloons((prev) =>
          prev.map((b) =>
            b.turnIndex !== msg.turnIndex || b.live
              ? b
              : {
                  ...b,
                  files: b.files.map((f) => (okPaths.has(f.path) ? { ...f, undone: true } : f)),
                },
          ),
        );
      }
    }
    requestBalloons();
  }

  function toggleExpanded(key: string) {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  }
  function isExpanded(key: string) {
    return !!expanded()[key];
  }

  return {
    balloons,
    undoBusy,
    reset,
    dropAbove,
    applySnapshot,
    noteBalloon,
    requestBalloons,
    noteTurnChanges,
    noteUndone,
    undoTurn,
    toggleExpanded,
    isExpanded,
  };
}
