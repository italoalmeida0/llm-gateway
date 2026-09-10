/**
 * SignalDB data layer for Remote Code.
 *
 * The Go daemon is the single source of truth (projects / sessions / config
 * live on its disk). This module mirrors each host's data into per-host
 * SignalDB collections persisted in IndexedDB, so the UI paints instantly
 * from cache — even offline or on another device — and self-corrects on
 * every {type:"change"} ping the daemon broadcasts after a mutation.
 *
 * The web client is a dumb monitor: it never owns state, only renders the
 * collections and sends commands. There is no push: every mutation goes
 * through an explicit daemon command, and the resulting change ping makes
 * sync pull the fresh snapshot (stale local items simply disappear).
 */
import { Collection } from "@signaldb/core";
import solidReactivityAdapter from "@signaldb/solid";
import createIndexedDBAdapter from "@signaldb/indexeddb";
import { SyncManager } from "@signaldb/sync";
import type { DaemonCommand, DaemonMessage, PullCommand, PullWireMessage } from "../daemon-protocol";

/** One mirrored conversation summary (SessionSummary shape from the daemon). */
export interface RcSession {
  id: string;
  hostId: string;
  cwd: string;
  title: string;
  model: string;
  status: "idle" | "running";
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  draft?: string;
  todosOpen?: boolean;
  editingMsg?: { index: number; text: string } | null;
  options?: { effort: string; mode: string; skills: string[]; access: string };
}

/** One mirrored project (host folder grouping conversations). */
export interface RcProject {
  folderStatus?: "available" | "missing" | "unavailable";
  id: string;
  hostId: string;
  name: string;
  path: string;
  createdAt: number;
  /** The default (home) project — present but never deletable. */
  protected?: boolean;
  collapsed?: boolean;
}

/** Daemon configuration mirror (single doc per host). */
export interface RcConfig {
  newDraft?: string;
  lastSelection?: { model: string; effort: string; mode?:string; access?:string; skills?:string[] };
  id: string;
  hostId: string;
  settings?: Record<string, any>;
  mcpServers?: Record<string, any>;
  skills?: Record<string, any>;
  name?: string;
}

export interface RcHostStore {
  projects: Collection<RcProject>;
  sessions: Collection<RcSession>;
  config: Collection<RcConfig>;
  /** (Re)pull everything from the daemon, if the socket is up. */
  syncAll: () => Promise<void>;
}

export interface RcDataLayer {
  storeFor: (hostId: string) => RcHostStore;
  disconnect: () => void;
  /**
   * Routes an incoming relay message. Returns true when the message belongs
   * to the sync protocol (pull responses / change pings) and was consumed.
   */
  handleMessage: (msg: DaemonMessage) => boolean;
  /** Releases a host's collections + sync manager (e.g. after host removal). */
  disposeHost: (hostId: string) => Promise<void>;
  /** Releases every host store (e.g. on page unmount). */
  disposeAll: () => Promise<void>;
}

interface PendingReq {
  hostId: string;
  resolve: (msg: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Creates the data layer. `send` transmits over the page's daemon socket and
 * must stamp the hostId itself; `isOpen` reports socket readiness.
 */
export function createDataLayer(opts: {
  send: (payload: DaemonCommand) => void;
  isOpen: () => boolean;
}): RcDataLayer {
  const pending = new Map<number, PendingReq>();
  // Replies are broadcast to every browser. Per-page namespaces prevent one
  // tab's pull from resolving another tab's request with the same counter.
  let nextReqId = crypto.getRandomValues(new Uint32Array(1))[0] * 1_000_000;
  const changeListeners = new Map<string, Set<() => void>>();
  const stores = new Map<string, {
    api: RcHostStore;
    mgr: SyncManager<{ name: string }>;
    cols: Array<{ dispose(): Promise<void> }>;
  }>();

  function request(hostId: string, pull: PullCommand): Promise<any> {
    if (!opts.isOpen()) return Promise.reject(new Error("daemon socket is closed"));
    const id = nextReqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`pull '${pull.collection}' timed out`));
      }, 12000);
      pending.set(id, { hostId, resolve, reject, timer });
      opts.send({ ...pull, hostId, id });
    });
  }

  function normalizeSession(r: any, hostId: string): RcSession {
    const rawEditing = r.editingMsg;
    const editingMsg = rawEditing && typeof rawEditing.index === "number"
      ? { index: rawEditing.index, text: String(rawEditing.text || "") }
      : null;
    return {
      id: r.id,
      hostId,
      cwd: r.cwd || "",
      title: r.title || r.cwd || "New conversation",
      model: r.model || "",
      status: r.status === "running" ? "running" : "idle",
      pinned: !!r.pinned,
      // Zero/negative timestamps are corruption, not 1970: fall back to
      // now instead of rendering "20706d" via timeAgo.
      createdAt: typeof r.createdAt === "number" && r.createdAt > 0 ? r.createdAt : Date.now(),
      updatedAt: typeof r.updatedAt === "number" && r.updatedAt > 0 ? r.updatedAt : Date.now(),
      messageCount:
        typeof r.messageCount === "number"
          ? r.messageCount
          : Array.isArray(r.messages)
            ? r.messages.length
            : 0,
      draft: r.draft || "",
      todosOpen: typeof r.todosOpen === "boolean" ? r.todosOpen : undefined,
      editingMsg,
      options: r.options ? {
        effort: r.options.effort || "medium",
        mode: r.options.mode || "build",
        skills: Array.isArray(r.options.skills) ? r.options.skills : [],
        access: r.options.access || "full",
      } : undefined,
    };
  }

  function normalizeProject(p: any, hostId: string): RcProject {
    const rawPath = String(p.path || "");
    const fallback = rawPath.replace(/\/+$/, "").split("/").pop() || rawPath || "/";
    return {
      id: p.id,
      hostId,
      name: p.name || fallback,
      path: rawPath,
      createdAt: p.createdAt ?? Date.now(),
      protected: !!p.protected,
      folderStatus: p.folderStatus,
      collapsed: !!p.collapsed,
    };
  }

  function normalizeConfig(c: any, hostId: string): RcConfig {
    return {
      id: c.id || "daemon",
      hostId,
      newDraft: c.newDraft ?? c.new_draft ?? "",
      lastSelection: c.lastSelection ?? c.last_selection,
      settings: c.settings && typeof c.settings === "object" ? c.settings : {},
      mcpServers: c.mcpServers ?? c.mcp_servers ?? {},
      skills: c.skills ?? {},
      name: c.name,
    };
  }

  function buildStore(hostId: string): RcHostStore {
    const mk = <T extends { id: string }>(name: string) => {
      const col = new Collection<T>({
        reactivity: solidReactivityAdapter,
        persistence: createIndexedDBAdapter(`rc:${hostId}:${name}`),
      });
      col.on("persistence.error", (error: Error) =>
        console.warn(`[rc-sync] persistence ${name}:`, error),
      );
      return col;
    };
    const projects = mk<RcProject>("projects");
    const sessions = mk<RcSession>("sessions");
    const config = mk<RcConfig>("config");

    const mgr = new SyncManager<{ name: string }>({
      id: `rc-${hostId}`,
      reactivity: solidReactivityAdapter,
      persistenceAdapter: (syncId) =>
        createIndexedDBAdapter(`rc:${hostId}:sync:${syncId}`),
      onError: (o, e) => console.warn(`[rc-sync] ${o?.name}:`, e),
      pull: async ({ name }) => {
        const resp = await request(hostId, { type: "pull", collection: name });
        const raw = Array.isArray(resp.items) ? resp.items : [];
        if (name === "projects") {
          return { items: raw.map((p: any) => normalizeProject(p, hostId)) };
        }
        if (name === "sessions") {
          return { items: raw.map((s: any) => normalizeSession(s, hostId)) };
        }
        return { items: raw.map((c: any) => normalizeConfig(c, hostId)) };
      },
      // No client-side pushes: mutations are daemon commands; the daemon's
      // change ping pulls the corrected snapshot back down.
      push: async () => {},
      registerRemoteChange: ({ name }, onChange) => {
        const key = `${hostId}:${name}`;
        let set = changeListeners.get(key);
        if (!set) {
          set = new Set();
          changeListeners.set(key, set);
        }
        const fire = () => {
          void onChange();
        };
        set.add(fire);
        return () => {
          set.delete(fire);
        };
      },
    });
    mgr.addCollection(projects, { name: "projects" });
    mgr.addCollection(sessions, { name: "sessions" });
    mgr.addCollection(config, { name: "config" });

    const api: RcHostStore = {
      projects,
      sessions,
      config,
      syncAll: () => {
        if (!opts.isOpen()) return Promise.resolve();
        return mgr.syncAll();
      },
    };
    stores.set(hostId, { api, mgr, cols: [projects, sessions, config] });
    return api;
  }

  async function disposeHost(hostId: string) {
    const entry = stores.get(hostId);
    if (!entry) return;
    stores.delete(hostId);
    for (const key of [...changeListeners.keys()]) {
      if (key === hostId || key.startsWith(`${hostId}:`)) changeListeners.delete(key);
    }
    for (const [id, request] of [...pending.entries()]) {
      if (request.hostId === hostId) {
        pending.delete(id);
        clearTimeout(request.timer);
        request.reject(new Error(`host '${hostId}' disposed`));
      }
    }
    await entry.mgr.dispose();
    await Promise.all(entry.cols.map((c) => c.dispose()));
  }

  return {
    disconnect() {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("daemon socket disconnected"));
      }
      pending.clear();
    },
    storeFor(hostId: string) {
      return stores.get(hostId)?.api ?? buildStore(hostId);
    },
    disposeHost(hostId: string) {
      return disposeHost(hostId);
    },
    disposeAll() {
      return (async () => {
        for (const hostId of [...stores.keys()]) await disposeHost(hostId);
      })();
    },
    handleMessage(msg: DaemonMessage): boolean {
      // pull responses resolve their pending request by numeric id.
      const replyId = (msg as { id?: unknown }).id;
      if (typeof replyId === "number" && pending.has(replyId)) {
        const pull = msg as PullWireMessage;
        const p = pending.get(replyId)!;
        // A reply for another host (or another tab's namespace) must NOT be
        // swallowed here: returning false lets it fall through instead of
        // resolving the wrong request.
        if (pull.hostId !== p.hostId) return false;
        pending.delete(replyId);
        clearTimeout(p.timer);
        if (typeof pull.error === "string" && pull.error) p.reject(new Error(pull.error));
        else p.resolve(pull);
        return true;
      }
      // change pings wake the matching collection's sync.
      if (msg?.type === "change" && typeof msg.collection === "string" && msg.hostId) {
        const set = changeListeners.get(`${msg.hostId}:${msg.collection}`);
        if (set) for (const cb of set) cb();
        return true;
      }
      return false;
    },
  };
}
