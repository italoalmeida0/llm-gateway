import { createSignal, onCleanup } from "solid-js";
import type { DaemonCommand } from "../daemon-protocol";

/**
 * Background tasks (per session, exactly like the todo list).
 *
 * The session owns the tasks (daemon BgTasks, persisted + mirrored in
 * session_data/session_content as bgTasks) and this hook keeps ONE list
 * PER SESSION: switching sessions never leaks tasks across conversations
 * and never loses a running task's live stream (each session's buffers
 * survive until that session's own snapshot reconciles them). Tasks NEVER
 * disappear (no GC) — a finished task stays rendered like a tool call.
 *
 * Live output joins the session tail by the daemon's monotonic `seq`:
 * every bg_output carries the chunk sequence number, so the overlap
 * with the snapshot tail is exact — no line arithmetic, no dup, no gap.
 */
export interface SessionBgTask {
  id: string;
  kind: string;
  label: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  content?: string;
  totalLines?: number;
  droppedLines?: number;
  /** 1-indexed first line covered by content (tail may be shorter). */
  contentFrom?: number;
}
export type BgTask = SessionBgTask;
export type Background = ReturnType<typeof createBackground>;

/** Per-job streamed output cap (tail kept, head dropped). */
const OUTPUT_CAP = 96 * 1024;
/** Stream buffer entries cap (oldest entries pruned first). */
const JOBS_CAP = 50;

interface JobLive {
  /** Concatenated live text (fallback for chunks without seq). */
  text: string;
  /** Numbered segments by daemon seq: the join key with the tail. */
  segs: { seq: number; from: number; text: string }[];
}

export function createBackground(opts: {
  send: (payload: DaemonCommand) => void;
  isOpen: () => boolean;
  /** The open conversation's id — the card reads THIS session's list. */
  getSessionId: () => string;
  toast: (msg: string, kind?: "ok" | "err") => void;
}) {
  /** Tasks BY SESSION (todo-list pattern): a payload for ANY session
   * writes into its own list — the active card just reads its own. */
  const [bySession, setBySession] = createSignal<Record<string, SessionBgTask[]>>({});
  /** Live buffers BY SESSION: {jobId: {text, segs}}. */
  const [liveBySession, setLiveBySession] = createSignal<Record<string, Record<string, JobLive>>>({});

  function tasksOf(sid: string): SessionBgTask[] {
    return bySession()[sid] || [];
  }

  function noteSessionTaskEvent(msg: any) {
    if (!msg || typeof msg.jobId !== "string") return;
    const sid = String(msg.sessionId || opts.getSessionId() || "");
    if (!sid) return;
    setBySession((prev) => {
      const list = [...(prev[sid] || [])];
      const i = list.findIndex((t) => t.id === msg.jobId);
      if (i < 0) {
        // Register: placeholder until the authoritative snapshot lands.
        if (msg.type !== "bg_task_registered") return prev;
        list.push({
          id: msg.jobId,
          kind: String(msg.kind || ""),
          label: String(msg.label || ""),
          status: "running",
          startedAt: typeof msg.startedAt === "number" ? msg.startedAt : Date.now(),
        });
      } else if (msg.type === "bg_task_finished") {
        list[i] = {
          ...list[i],
          status: String(msg.status || "done"),
          endedAt: typeof msg.endedAt === "number" ? msg.endedAt : Date.now(),
          exitCode: typeof msg.exitCode === "number" ? msg.exitCode : list[i].exitCode,
        };
      } else {
        return prev;
      }
      return { ...prev, [sid]: list };
    });
    if (msg.type === "bg_task_registered") ensureClock();
  }

  /** Authoritative session task list (from session payload bgTasks). */
  function noteSessionTasks(list: unknown, sid?: string) {
    if (!Array.isArray(list)) return;
    const owner = String(sid || opts.getSessionId() || "");
    if (!owner) return;
    const parsed: SessionBgTask[] = [];
    for (const t of list as any[]) {
      if (!t || typeof t.id !== "string") continue;
      parsed.push({
        id: t.id,
        kind: String(t.kind || ""),
        label: String(t.label || ""),
        status: String(t.status || "running"),
        startedAt: typeof t.startedAt === "number" ? t.startedAt : 0,
        endedAt: typeof t.endedAt === "number" ? t.endedAt : undefined,
        exitCode: typeof t.exitCode === "number" ? t.exitCode : undefined,
        content: typeof t.content === "string" ? t.content : undefined,
        totalLines: typeof t.totalLines === "number" ? t.totalLines : undefined,
        droppedLines: typeof t.droppedLines === "number" ? t.droppedLines : undefined,
        contentFrom: typeof t.contentFrom === "number" ? t.contentFrom : undefined,
      });
    }
    setBySession((prev) => ({ ...prev, [owner]: parsed }));
    pruneLive(owner, parsed);
    if (parsed.some((t) => t.status === "running")) ensureClock();
  }

  /** Live chunk from the daemon. Written into the OWNING session's
   * buffers (msg.sessionId), never the active one: a stale chunk after a
   * session switch lands where it belongs (or nowhere if unknown). */
  function noteOutput(jobId: string, text: string, sid?: string, from?: number, seq?: number) {
    if (typeof jobId !== "string" || typeof text !== "string" || !text) return;
    const owner = String(sid || opts.getSessionId() || "");
    if (!owner) return;
    const known = tasksOf(owner).some((t) => t.id === jobId);
    const hasBuf = !!liveBySession()[owner]?.[jobId];
    if (!known && !hasBuf) return; // foreign/stale: not ours
    setLiveBySession((prev) => {
      const sess = { ...(prev[owner] || {}) };
      const cur = sess[jobId] || { text: "", segs: [] };
      const segs = [...cur.segs];
      // Only NUMBERED chunks (seq + first line) join by line math; an
      // unnumbered chunk falls back to the text buffer below.
      if (typeof seq === "number" && typeof from === "number" && from >= 1 && segs.every((s) => s.seq !== seq)) {
        segs.push({ seq, from, text });
        segs.sort((a, b) => a.seq - b.seq);
        if (segs.length > 400) segs.splice(0, segs.length - 400);
      }
      const joined = cur.text + text;
      sess[jobId] = {
        text: joined.length > OUTPUT_CAP ? joined.slice(-OUTPUT_CAP) : joined,
        segs,
      };
      return { ...prev, [owner]: sess };
    });
  }

  function pruneLive(owner: string, tasks: SessionBgTask[]) {
    setLiveBySession((prev) => {
      const sess = prev[owner];
      if (!sess) return prev;
      const keys = Object.keys(sess);
      if (keys.length <= JOBS_CAP) return prev;
      const liveIds = new Set(tasks.map((j) => j.id));
      const next: Record<string, JobLive> = {};
      for (const k of keys) {
        if (liveIds.has(k)) next[k] = sess[k];
      }
      const rest = Object.keys(next);
      if (rest.length > JOBS_CAP) {
        for (const k of rest.slice(0, rest.length - JOBS_CAP)) delete next[k];
      }
      return { ...prev, [owner]: next };
    });
  }

  /** 1s ticker (only while a job runs) for elapsed labels. */
  const [clock, setClock] = createSignal(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;

  function anyRunning(): boolean {
    for (const list of Object.values(bySession())) {
      if (list.some((t) => t.status === "running")) return true;
    }
    return false;
  }
  function ensureClock() {
    if (!timer) timer = setInterval(() => setClock(Date.now()), 1000);
  }
  function maybeStopClock() {
    if (timer && !anyRunning()) {
      clearInterval(timer);
      timer = undefined;
    }
  }
  onCleanup(() => clearInterval(timer));

  function stop(jobId: string) {
    if (!opts.isOpen()) return;
    opts.send({ type: "bg_cancel", jobId });
    opts.toast("Background task stopped", "ok");
  }

  function running() {
    return tasksOf(opts.getSessionId()).filter((t) => t.status === "running");
  }

  /** Tasks of the OPEN session — session-owned, never disappear. */
  function sessionJobs() {
    return tasksOf(opts.getSessionId());
  }

  /** Session-owned content for a task (authoritative tail from bgTasks). */
  function sessionContent(jobId: string): string | undefined {
    return tasksOf(opts.getSessionId()).find((t) => t.id === jobId)?.content;
  }

  /**
   * Live tail for a job: the streamed lines the snapshot tail does NOT
   * cover yet. The daemon numbers every chunk (seq + first line), so the
   * cut is exact: keep lines whose absolute number is past the snapshot
   * total. Chunks without numbering (legacy) fall back to the text buffer.
   */
  function liveTail(jobId: string): string {
    const sid = opts.getSessionId();
    const task = tasksOf(sid).find((t) => t.id === jobId);
    const snapTotal = task && typeof task.totalLines === "number" ? task.totalLines : 0;
    const live = liveBySession()[sid]?.[jobId];
    if (!live) return "";
    if (live.segs.length > 0) {
      const parts: string[] = [];
      for (const s of live.segs) {
        const lines = s.text.split("\n");
        // Drop the phantom after a trailing newline (daemon countLines).
        if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
        for (let i = 0; i < lines.length; i++) {
          if (s.from + i > snapTotal) parts.push(lines[i]);
        }
      }
      return parts.join("\n");
    }
    // Legacy (no seq): show the whole buffer — the snapshot tail is
    // authoritative for older lines and the card shows the notice.
    return live.text;
  }

  /** Concatenated live text per job of the OPEN session (tool-row stream). */
  function output(): Record<string, string> {
    const sid = opts.getSessionId();
    const sess = liveBySession()[sid] || {};
    const out: Record<string, string> = {};
    for (const [id, live] of Object.entries(sess)) out[id] = live.text;
    return out;
  }

  return { sessionJobs, sessionContent, liveTail, running, clock, output, noteOutput, noteSessionTasks, noteSessionTaskEvent, stop, maybeStopClock };
}