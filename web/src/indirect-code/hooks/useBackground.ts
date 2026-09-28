import { createSignal, onCleanup } from "solid-js";
import type { BgJobWire, DaemonCommand } from "../daemon-protocol";

/**
 * Background tasks (per session).
 *
 * The session owns the tasks (daemon BgTasks, persisted + mirrored in
 * session_data/session_content as bgTasks). The hook keeps the session
 * list as the source of truth: tasks NEVER disappear (no GC) — a
 * finished task stays rendered like a tool call. Live output still
 * streams as `bg_output` chunks; the `bg_update`/`bg_list` registry
 * remains as a fallback for sessions recorded before the split.
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
}
export type BgTask = BgJobWire | SessionBgTask;

/** Per-job streamed output cap (tail kept, head dropped). */
const OUTPUT_CAP = 96 * 1024;
/** Stream buffer entries cap (oldest terminal jobs pruned first). */
const JOBS_CAP = 50;

export function createBackground(opts: {
  send: (payload: DaemonCommand) => void;
  isOpen: () => boolean;
  /** The open conversation's id — the card is scoped to it. */
  getSessionId: () => string;
  toast: (msg: string, kind?: "ok" | "err") => void;
  /** Fired when a bash/python job of the open session finishes:
   * the transcript folds the result into the originating tool row. */
  onTerminalResult?: (job: BgTask) => void;
}) {
  const [jobs, setJobs] = createSignal<BgTask[]>([]);
  const [output, setOutput] = createSignal<Record<string, string>>({});
  /** Session-owned tasks (bgTasks from session_data/session_content).
   * Merged with registry jobs by id; session wins on conflict. */
  const [sessionTasks, setSessionTasks] = createSignal<SessionBgTask[]>([]);
  /** Session task events (bg_task_registered/bg_task_finished): force
   * the card to re-render even without a session_data refresh. */
  function noteSessionTaskEvent(msg: any) {
    if (!msg || typeof msg.jobId !== "string") return;
    const sid = opts.getSessionId();
    if (msg.sessionId && sid && msg.sessionId !== sid) return;
    // Touch the list so dependents re-evaluate; the authoritative
    // content arrives via session_data/session_content (pingChange).
    setSessionTasks((prev) => {
      const i = prev.findIndex((t) => t.id === msg.jobId);
      if (i < 0) {
        return [...prev, { id: msg.jobId, kind: String(msg.kind || ""), label: String(msg.label || ""), status: msg.type === "bg_task_finished" ? String(msg.status || "done") : "running", startedAt: Date.now() }];
      }
      const next = [...prev];
      if (msg.type === "bg_task_finished") next[i] = { ...next[i], status: String(msg.status || "done") };
      return next;
    });
  }
  /** Authoritative session task list (from session payload bgTasks). */
  function noteSessionTasks(list: unknown) {
    if (!Array.isArray(list)) return;
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
      });
    }
    setSessionTasks(parsed);
    if (parsed.some((t) => t.status === "running")) ensureClock();
    else maybeStopClock();
  }
  /** 1s ticker (only while a job runs) for elapsed labels. */
  const [clock, setClock] = createSignal(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  const pendingTails = new Map<string, (text: string) => void>();
  // Tail-requested jobs whose .log tail hasn't arrived yet: live chunks
  // are BUFFERED (not appended) until the tail lands, then tail + buffer
  // join in order — no lost pre-detach history, no duplicated boundary.
  // A 10s flush covers a tail that never arrives.
  const tailPending = new Set<string>();
  const tailBuf: Record<string, string> = {};

  function ensureClock() {
    if (!timer) timer = setInterval(() => setClock(Date.now()), 1000);
  }
  function maybeStopClock() {
    if (timer && !jobs().some((j) => j.status === "running")) {
      clearInterval(timer);
      timer = undefined;
    }
  }
  onCleanup(() => clearInterval(timer));

  function noteJobs(list: unknown) {
    if (!Array.isArray(list)) return;
    const parsed: BgTask[] = [];
    const sid = opts.getSessionId();
    for (const j of list as any[]) {
      if (!j || typeof j.id !== "string") continue;
      parsed.push({
        id: j.id,
        kind: String(j.kind || ""),
        sessionId: String(j.sessionId || ""),
        label: String(j.label || ""),
        status: String(j.status || ""),
        startedAt: typeof j.startedAt === "number" ? j.startedAt : 0,
        endedAt: typeof j.endedAt === "number" ? j.endedAt : undefined,
        result: typeof j.result === "string" ? j.result : undefined,
        logPath: typeof j.logPath === "string" && j.logPath ? j.logPath : undefined,
      });
    }
    // Every terminal bash/python job of this session folds its result
    // into the originating tool row on EVERY snapshot (the fold is
    // idempotent): a missed bg_update — or a row that mounted late —
    // heals on the next bg_list instead of showing the AI notice forever.
    // Newly sighted running jobs fetch the .log tail (pre-detach history
    // this client never streamed).
    if (opts.onTerminalResult) {
      const prev = jobs();
      for (const job of parsed) {
        if ((job as BgJobWire).sessionId !== sid) continue;
        if (job.kind !== "bash" && job.kind !== "python") continue;
        if (job.status === "running") {
          if (!prev.some((p) => (p as BgJobWire).id === job.id)) requestTail(job.id);
          continue;
        }
        flushTailBuffer(job.id);
        opts.onTerminalResult(job);
      }
    }
    if (parsed.some((j) => j.status === "running")) ensureClock();
    setJobs(parsed);
    maybeStopClock();
    pruneOutput(parsed);
  }

  function appendOutput(jobId: string, text: string) {
    if (!jobId || !text) return;
    setOutput((prev) => {
      const next = (prev[jobId] || "") + text;
      return { ...prev, [jobId]: next.length > OUTPUT_CAP ? next.slice(-OUTPUT_CAP) : next };
    });
  }

  /** Live chunk from the daemon (post-detach output). While the .log
   * tail is still in flight the chunk is buffered, not appended. */
  function noteOutput(jobId: string, text: string) {
    if (typeof jobId !== "string" || typeof text !== "string" || !text) return;
    if (tailPending.has(jobId)) {
      const next = (tailBuf[jobId] || "") + text;
      tailBuf[jobId] = next.length > OUTPUT_CAP ? next.slice(-OUTPUT_CAP) : next;
      return;
    }
    appendOutput(jobId, text);
  }

  /** Tail served for a bg_tail request: tail + buffered live chunks join
   * in order (exact history, no duplicated boundary). */
  function noteTail(jobId: string, text: string) {
    const resolve = pendingTails.get(jobId);
    if (resolve) {
      pendingTails.delete(jobId);
      resolve(typeof text === "string" ? text : "");
    }
    if (typeof jobId !== "string" || typeof text !== "string" || !text) return;
    if (tailPending.has(jobId)) {
      tailPending.delete(jobId);
      const buffered = tailBuf[jobId] || "";
      delete tailBuf[jobId];
      const merged = text + buffered;
      setOutput((prev) => {
        if (prev[jobId]) return prev;
        return { ...prev, [jobId]: merged.length > OUTPUT_CAP ? merged.slice(-OUTPUT_CAP) : merged };
      });
      return;
    }
    setOutput((prev) => {
      if (prev[jobId]) return prev;
      return { ...prev, [jobId]: text.length > OUTPUT_CAP ? text.slice(-OUTPUT_CAP) : text };
    });
  }

  /** A tail that never arrives must not park live chunks forever. */
  function flushTailBuffer(jobId: string) {
    if (!tailPending.has(jobId)) return;
    tailPending.delete(jobId);
    const buffered = tailBuf[jobId] || "";
    delete tailBuf[jobId];
    if (buffered) appendOutput(jobId, buffered);
  }

  function requestTail(jobId: string) {
    if (!opts.isOpen() || tailPending.has(jobId)) return;
    tailPending.add(jobId);
    opts.send({ type: "bg_tail", jobId });
    setTimeout(() => flushTailBuffer(jobId), 10000);
  }

  /** Full .log tail for a job (missed history on reconnect). */
  function tail(jobId: string): Promise<string> {
    const known = output()[jobId];
    if (known) return Promise.resolve(known);
    if (!opts.isOpen()) return Promise.resolve("");
    return new Promise((resolve) => {
      pendingTails.set(jobId, resolve);
      opts.send({ type: "bg_tail", jobId });
      setTimeout(() => {
        if (pendingTails.get(jobId) === resolve) {
          pendingTails.delete(jobId);
          resolve(output()[jobId] || "");
        }
      }, 10000);
    });
  }

  function pruneOutput(live: BgTask[]) {
    setOutput((prev) => {
      const keys = Object.keys(prev);
      if (keys.length <= JOBS_CAP) return prev;
      const liveIds = new Set(live.map((j) => j.id));
      const next: Record<string, string> = {};
      for (const k of keys) {
        if (liveIds.has(k)) next[k] = prev[k];
      }
      // Still over cap (huge history): keep the newest entries.
      const rest = Object.keys(next);
      if (rest.length > JOBS_CAP) {
        for (const k of rest.slice(0, rest.length - JOBS_CAP)) delete next[k];
      }
      return next;
    });
  }

  function refresh() {
    if (!opts.isOpen()) return;
    opts.send({ type: "bg_list" });
  }

  function stop(jobId: string) {
    if (!opts.isOpen()) return;
    opts.send({ type: "bg_cancel", jobId });
    opts.toast("Background task stopped", "ok");
  }

  function running() {
    return jobs().filter((j) => j.status === "running");
  }

  /** Jobs owned by the OPEN session (the daemon registry is per host; the
   * card must never show another conversation's tasks). Session-owned
   * tasks (bgTasks) merge in by id — session wins — and NEVER disappear. */
  function sessionJobs() {
    const sid = opts.getSessionId();
    if (!sid) return [];
    const reg = jobs().filter((j) => (j as BgJobWire).sessionId === sid || !(j as BgJobWire).sessionId);
    const sess = sessionTasks();
    if (sess.length === 0) return reg;
    const ids = new Set(sess.map((t) => t.id));
    return [...sess, ...reg.filter((j) => !ids.has(j.id))];
  }

  /** Session-owned content for a task (authoritative tail from bgTasks). */
  function sessionContent(jobId: string): string | undefined {
    return sessionTasks().find((t) => t.id === jobId)?.content;
  }

  return { jobs, sessionJobs, sessionContent, running, output, clock, noteJobs, noteOutput, noteTail, noteSessionTasks, noteSessionTaskEvent, tail, refresh, stop };
}

export type Background = ReturnType<typeof createBackground>;
