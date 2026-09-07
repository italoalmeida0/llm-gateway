import { createMemo, onCleanup } from "solid-js";
import { createDataLayer } from "../store/sessions";
import { projectsByActivity } from "../paths";
import type { Project, SessionSummary } from "../types";

/** Espelho SignalDB (sessions/projects/config por host). A página nunca é
 * dona destes dados — o daemon é (extraído de RemoteCodePage verbatim). */
export function createMirror(opts: {
  send: (payload: Record<string, any>) => void;
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
  const sessions = createMemo<SessionSummary[]>(() => {
    const st = store();
    if (!st) return [];
    const hid = opts.getHostId();
    return st.sessions
      .find({ hostId: hid })
      .fetch()
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });
  const projects = createMemo<Project[]>(() => {
    const st = store();
    if (!st) return [];
    const hid = opts.getHostId();
    return projectsByActivity(st.projects.find({ hostId: hid }).fetch(), sessions());
  });
  const configDoc = createMemo(() => {
    const st = store();
    if (!st) return null;
    return st.config.find({ hostId: opts.getHostId() }).fetch()[0] ?? null;
  });

  onCleanup(() => dataLayer.disconnect());

  return { dataLayer, store, sessions, projects, configDoc };
}

export type Mirror = ReturnType<typeof createMirror>;
