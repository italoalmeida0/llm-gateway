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
 * disappear (no GC) — finished tasks remain available in the archive.
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
  totalBytes?: number;
  seq?: number;
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
  /** Numbered segments by daemon seq: byte offsets join live output to the snapshot tail. */
  segs: { seq: number; from: number; totalBytes?: number; text: string; bytes: number; bytesMode: boolean }[];
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
    else if (msg.type === "bg_task_finished") maybeStopClock();
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
        totalBytes: typeof t.totalBytes === "number" ? t.totalBytes : undefined,
        seq: typeof t.seq === "number" ? t.seq : undefined,
      });
    }
    setBySession((prev) => ({ ...prev, [owner]: parsed }));
    pruneLive(owner, parsed);
    if (parsed.some((t) => t.status === "running")) ensureClock();
    else maybeStopClock();
  }

  /** Live chunk from the daemon. Written into the OWNING session's
   * buffers (msg.sessionId), never the active one: a stale chunk after a
   * session switch lands where it belongs (or nowhere if unknown). */
  function noteOutput(jobId: string, text: string, sid?: string, from?: number, seq?: number, totalBytes?: number, byteOffset = false) {
    if (typeof jobId !== "string" || typeof text !== "string" || !text) return;
    const owner = String(sid || opts.getSessionId() || "");
    if (!owner) return;
    const known = tasksOf(owner).some((t) => t.id === jobId);
    const hasBuf = !!liveBySession()[owner]?.[jobId];
    if (!known && !hasBuf) return; // foreign/stale: not ours
    let accepted = false;
    setLiveBySession((prev) => {
      const sess = { ...(prev[owner] || {}) };
      const cur = sess[jobId] || { text: "", segs: [] };
      const segs = [...cur.segs];
      // Numbered chunks join to the authoritative snapshot; legacy chunks
      // without offsets remain available through the text fallback.
      const numbered = typeof seq === "number" && typeof from === "number" &&
        (byteOffset ? from >= 0 : from >= 1);
      if (numbered && segs.every((s) => s.seq !== seq)) {
        const bytes = new TextEncoder().encode(text).byteLength;
        segs.push({ seq: seq!, from: from!, totalBytes, text, bytes, bytesMode: byteOffset });
        segs.sort((a, b) => a.seq - b.seq);
        if (segs.length > 400) segs.splice(0, segs.length - 400);
        let retainedBytes = segs.reduce((sum, segment) => sum + segment.bytes, 0);
        while (segs.length > 1 && retainedBytes - segs[0].bytes >= OUTPUT_CAP) {
          retainedBytes -= segs.shift()!.bytes;
        }
        if (retainedBytes > OUTPUT_CAP) {
          const first = segs[0];
          const encoded = new TextEncoder().encode(first.text);
          let cut = retainedBytes - OUTPUT_CAP;
          // Start the retained tail on a UTF-8 boundary.
          while (cut < encoded.length && (encoded[cut] & 0xc0) === 0x80) cut++;
          const removed = new TextDecoder().decode(encoded.subarray(0, cut));
          segs[0] = { ...first,
            text: new TextDecoder().decode(encoded.subarray(cut)),
            bytes: encoded.length - cut,
            from: first.from + (first.bytesMode ? cut : (removed.match(/\n/g)?.length || 0)),
          };
        }
        accepted = true;
      }
      // Duplicate numbered chunks are replayed after reconnect; do not
      // append them to the unnumbered fallback buffer either.
      const joined = (numbered && !accepted) ? cur.text : cur.text + text;
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
    if (!timer) {
      setClock(Date.now());
      timer = setInterval(() => setClock(Date.now()), 1000);
    }
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
   * Live tail for a job: streamed bytes/lines the snapshot does NOT cover
   * yet. New daemons provide zero-based UTF-8 byte offsets and a snapshot
   * sequence; older line-numbered chunks retain the legacy path.
   */
  function liveTail(jobId: string): string {
    const sid = opts.getSessionId();
    const task = tasksOf(sid).find((t) => t.id === jobId);
    const snapTotal = task && typeof task.totalLines === "number" ? task.totalLines : 0;
    const snapBytes = task && typeof task.totalBytes === "number" ? task.totalBytes : undefined;
    const live = liveBySession()[sid]?.[jobId];
    if (!live) return "";
    if (live.segs.length > 0) {
      const byteSegments = live.segs.some((s) => s.bytesMode);
      const segments = byteSegments
        ? live.segs.filter((s) => s.bytesMode)
        : live.segs;
      const fresh = typeof task?.seq === "number"
        ? segments.filter((s) => s.seq > task.seq!)
        : segments;
      if (fresh.length === 0) return "";
      if (byteSegments && snapBytes == null) return fresh.map((s) => s.text).join("");
      if (byteSegments && snapBytes != null) {
        const decoder = new TextDecoder();
        const parts: string[] = [];
        let covered = snapBytes;
        for (const s of fresh) {
          const bytes = new TextEncoder().encode(s.text);
          const start = Math.max(0, covered - s.from);
          if (start >= bytes.byteLength) continue;
          parts.push(decoder.decode(bytes.slice(start)));
          covered = Math.max(covered, s.from + bytes.byteLength);
        }
        return parts.join("");
      }
      const parts: string[] = [];
      for (const s of fresh) {
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

  function purgeSession(sid: string) {
    if (!sid) return;
    setBySession((prev) => {
      if (!(sid in prev)) return prev;
      const next = { ...prev };
      delete next[sid];
      return next;
    });
    setLiveBySession((prev) => {
      if (!(sid in prev)) return prev;
      const next = { ...prev };
      delete next[sid];
      return next;
    });
    maybeStopClock();
  }

  function reset() {
    setBySession({});
    setLiveBySession({});
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  return { sessionJobs, sessionContent, liveTail, running, clock, output, noteOutput, noteSessionTasks, noteSessionTaskEvent, stop, maybeStopClock, purgeSession, reset };
}
