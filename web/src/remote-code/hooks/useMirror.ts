import { createMemo, onCleanup } from "solid-js";
import { createDataLayer } from "../store/sessions";
import type { DaemonCommand } from "../daemon-protocol";
import { projectsByActivity } from "../paths";
import type { Project, SessionSummary } from "../types";

/** Espelho SignalDB (sessions/projects/config por host). A página nunca é
 * dona destes dados — o daemon é (extraído de RemoteCodePage verbatim). */
export function createMirror(opts: {
  send: (payload: DaemonCommand) => void;
  isOpen: () => boolean;
  getHostId: () => string;
}) {
  const dataLayer = createDataLayer({
    send: (payload) => opts.send(payload),
    isOpen: opts.isOpen,
  });
  const store = createMemo(() => {
    const hid = opts.getHostId();
    return hid ? dataLayer.storeFor(hid) : null;
  });
  // Ordenação memoizada por identidade rasa: os memos Solid comparam por
  // === e os pings de change chegam à escala de keystrokes — devolver a
  // mesma referência quando nada mudou (mesmos ids+updatedAt) evita
  // recomputar toda a cadeia (sidebar, contadores, default effects).
  let prevSessions: SessionSummary[] | null = null;
  let prevSessionsHid = "";
  const sessions = createMemo<SessionSummary[]>(() => {
    const st = store();
    if (!st) return [];
    const hid = opts.getHostId();
    const sorted = st.sessions
      .find({ hostId: hid })
      .fetch()
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (
      hid === prevSessionsHid &&
      prevSessions &&
      prevSessions.length === sorted.length &&
      prevSessions.every((s, i) => s.id === sorted[i].id && s.updatedAt === sorted[i].updatedAt)
    ) {
      return prevSessions;
    }
    prevSessionsHid = hid;
    prevSessions = sorted;
    return sorted;
  });
  let prevProjects: Project[] | null = null;
  let prevProjectsHid = "";
  const projects = createMemo<Project[]>(() => {
    const st = store();
    if (!st) return [];
    const hid = opts.getHostId();
    const ordered = projectsByActivity(st.projects.find({ hostId: hid }).fetch(), sessions());
    if (
      hid === prevProjectsHid &&
      prevProjects &&
      prevProjects.length === ordered.length &&
      prevProjects.every((p, i) => p.id === ordered[i].id && p.path === ordered[i].path && p.folderStatus === ordered[i].folderStatus)
    ) {
      return prevProjects;
    }
    prevProjectsHid = hid;
    prevProjects = ordered;
    return ordered;
  });
  const configDoc = createMemo(() => {
    const st = store();
    if (!st) return null;
    return st.config.find({ hostId: opts.getHostId() }).fetch()[0] ?? null;
  });

  onCleanup(() => {
    dataLayer.disconnect();
    void dataLayer.disposeAll();
  });

  return { dataLayer, store, sessions, projects, configDoc };
}

export type Mirror = ReturnType<typeof createMirror>;
