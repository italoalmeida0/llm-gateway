import { createMemo, onCleanup } from "solid-js";
import { createDataLayer } from "../store/sessions";
import type { DaemonCommand } from "../daemon-protocol";
import { projectsByActivity } from "../paths";
import type { Project, SessionSummary } from "../types";

/** SignalDB mirror (sessions/projects/config per host). The page never
 * owns this data — the daemon does (extracted verbatim from RemoteCodePage). */
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
  // Compare complete summaries: timestamps alone do not change for every
  // mutation (project rename, session options, pin/status updates).
  const sessions = createMemo<SessionSummary[]>(() => {
    const st = store();
    return st ? st.sessions.find({ hostId: opts.getHostId() }).fetch().slice()
      .sort((a, b) => b.updatedAt - a.updatedAt) : [];
  }, [], { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
  const projects = createMemo<Project[]>(() => {
    const st = store();
    return st ? projectsByActivity(st.projects.find({ hostId: opts.getHostId() }).fetch(), sessions()) : [];
  }, [], { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) });
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
