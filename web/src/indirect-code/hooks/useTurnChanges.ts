import { createSignal } from "solid-js";

export interface TurnChangedFile {
  path: string;
  rel?: string;
  status: "new" | "modified" | "deleted" | "binary" | "too_large";
  diff?: string;
  additions?: number;
  deletions?: number;
  undone?: boolean;
}

export interface TurnBalloon {
  turnIndex: number;
  at?: number;
  files: TurnChangedFile[];
  messageIndex?: number;
  /** True while the turn is still running (floats above the composer). */
  live?: boolean;
}

export interface UndoFileResult {
  path: string;
  rel?: string;
  ok: boolean;
  message?: string;
}

/** Per-turn file changes (snapshot-based, no git).
 *
 * The frontend only knows "changes": one balloon per finished turn (sitting
 * below its turn, persistent) plus at most one live balloon for the running
 * turn (floating above the composer). The daemon's incoming snapshot is an
 * internal detail — it only ever surfaces as live changes here.
 */
export function createTurnChanges(opts: {
  send: (payload: any) => void;
  getSessionId: () => string;
  toast: (message: string, kind?: "ok" | "err") => void;
}) {
  const [balloons, setBalloons] = createSignal<TurnBalloon[]>([]);
  const [undoBusy, setUndoBusy] = createSignal<number | null>(null);
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});

  function reset() {
    setBalloons([]);
    setUndoBusy(null);
  }

  function applySnapshot(r: any) {
    const list = r?.fileBalloons ?? r?.file_balloons ?? [];
    setBalloons(
      (Array.isArray(list) ? list : []).map((b: any) => ({ ...b, live: false })),
    );
  }

  function upsert(balloon: any, live: boolean) {
    if (!balloon || typeof balloon.turnIndex !== "number") return;
    const next: TurnBalloon = {
      turnIndex: balloon.turnIndex,
      at: balloon.at,
      files: balloon.files || [],
      messageIndex: balloon.messageIndex,
      live,
    };
    setBalloons((prev) => {
      const rest = prev.filter(
        (b) => !(b.turnIndex === next.turnIndex && b.live === next.live),
      );
      // A finished balloon supersedes the live one of the same turn.
      const filtered = live
        ? rest
        : rest.filter((b) => b.turnIndex !== next.turnIndex);
      const out = [...filtered, next];
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
    if (Array.isArray(msg?.balloons)) {
      const list = msg.balloons.filter((b: any) => typeof b?.turnIndex === "number");
      list.sort((a: any, b: any) => a.turnIndex - b.turnIndex);
      setBalloons((prev) => {
        const live = prev.filter((b) => b.live);
        const merged = [...list.map((b: any) => ({ ...b, live: false })), ...live];
        merged.sort((a, b) => a.turnIndex - b.turnIndex);
        return merged;
      });
    }
    if (msg?.live && typeof msg.live.turnIndex === "number") {
      upsert(msg.live, true);
    }
  }

  function undoTurn(turnIndex: number, path?: string) {
    if (!opts.getSessionId() || undoBusy() !== null) return;
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
