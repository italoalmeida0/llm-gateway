import { createSignal, onCleanup } from "solid-js";
import type { DaemonCommand } from "../daemon-protocol";

/**
 * Background tasks (per session).
 *
 * The session owns the tasks (daemon BgTasks, persisted + mirrored in
 * session_data/session_content as bgTasks). The hook keeps the session
 * list as the source of truth: tasks NEVER disappear (no GC) — a
 * finished task stays rendered like a tool call. Live output streams as
 * `bg_output` chunks glued after the session tail.
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
export type BgTask = SessionBgTask;

/** Per-job streamed output cap (tail kept, head dropped). */
const OUTPUT_CAP = 96 * 1024;
/** Stream buffer entries cap (oldest entries pruned first). */
const JOBS_CAP = 50;

export function createBackground(opts: {
  send: (payload: DaemonCommand) => void;
  isOpen: () => boolean;
  /** The open conversation's id — the card is scoped to it. */
  getSessionId: () => string;
  toast: (msg: string, kind?: "ok" | "err") => void;
}) {
  const [output, setOutput] = createSignal<Record<string, string>>({});
  /** Session-owned tasks (bgTasks from session_data/session_content). */
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
    pruneOutput(parsed);
  }
  /** 1s ticker (only while a job runs) for elapsed labels. */
  const [clock, setClock] = createSignal(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;

  function ensureClock() {
    if (!timer) timer = setInterval(() => setClock(Date.now()), 1000);
  }
  function maybeStopClock() {
    if (timer && !sessionTasks().some((t) => t.status === "running")) {
      clearInterval(timer);
      timer = undefined;
    }
  }
  onCleanup(() => clearInterval(timer));

  function appendOutput(jobId: string, text: string) {
    if (!jobId || !text) return;
    setOutput((prev) => {
      const next = (prev[jobId] || "") + text;
      return { ...prev, [jobId]: next.length > OUTPUT_CAP ? next.slice(-OUTPUT_CAP) : next };
    });
  }

  /** Live chunk from the daemon (post-detach output). */
  function noteOutput(jobId: string, text: string) {
    if (typeof jobId !== "string" || typeof text !== "string" || !text) return;
    appendOutput(jobId, text);
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

  function stop(jobId: string) {
    if (!opts.isOpen()) return;
    opts.send({ type: "bg_cancel", jobId });
    opts.toast("Background task stopped", "ok");
  }

  function running() {
    return sessionTasks().filter((t) => t.status === "running");
  }

  /** Tasks of the OPEN session — session-owned, never disappear. */
  function sessionJobs() {
    return sessionTasks();
  }

  /** Session-owned content for a task (authoritative tail from bgTasks). */
  function sessionContent(jobId: string): string | undefined {
    return sessionTasks().find((t) => t.id === jobId)?.content;
  }

  return { sessionJobs, sessionContent, running, output, clock, noteOutput, noteSessionTasks, noteSessionTaskEvent, stop };
}

export type Background = ReturnType<typeof createBackground>;
