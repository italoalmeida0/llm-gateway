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
}

/** One mirrored project (host folder grouping conversations). */
export interface RcProject {
  id: string;
  hostId: string;
  name: string;
  path: string;
  createdAt: number;
}

/** Daemon configuration mirror (single doc per host). */
export interface RcConfig {
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
  syncAll: () => void;
}

export interface RcDataLayer {
  storeFor: (hostId: string) => RcHostStore;
  /**
   * Routes an incoming relay message. Returns true when the message belongs
   * to the sync protocol (pull responses / change pings) and was consumed.
   */
  handleMessage: (msg: any) => boolean;
}

interface PendingReq {
  resolve: (msg: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Creates the data layer. `send` transmits over the page's daemon socket and
 * must stamp the hostId itself; `isOpen` reports socket readiness.
 */
export function createDataLayer(opts: {
  send: (payload: Record<string, any>) => void;
  isOpen: () => boolean;
}): RcDataLayer {
  const pending = new Map<number, PendingReq>();
  let nextReqId = 1;
  const changeListeners = new Map<string, Set<() => void>>();
  const stores = new Map<string, RcHostStore>();

  function request(hostId: string, payload: Record<string, any>): Promise<any> {
    if (!opts.isOpen()) return Promise.reject(new Error("daemon socket is closed"));
    const id = nextReqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`pull '${payload.collection}' timed out`));
      }, 12000);
      pending.set(id, { resolve, reject, timer });
      opts.send({ ...payload, hostId, id });
    });
  }

  function normalizeSession(r: any, hostId: string): RcSession {
    return {
      id: r.id,
      hostId,
      cwd: r.cwd || "",
      title: r.title || r.cwd || "",
      model: r.model || "",
      status: r.status === "running" ? "running" : "idle",
      pinned: !!r.pinned,
      createdAt: r.createdAt ?? r.created_at ?? Date.now(),
      updatedAt: r.updatedAt ?? r.updated_at ?? Date.now(),
      messageCount:
        typeof r.messageCount === "number"
          ? r.messageCount
          : typeof r.message_count === "number"
            ? r.message_count
            : Array.isArray(r.messages)
              ? r.messages.length
              : 0,
    };
  }

  function normalizeProject(p: any, hostId: string): RcProject {
    return {
      id: p.id,
      hostId,
      name: p.name || (String(p.path || "").replace(/\/+$/, "").split("/").pop() ?? ""),
      path: p.path || "",
      createdAt: p.createdAt ?? p.created_at ?? Date.now(),
    };
  }

  function normalizeConfig(c: any, hostId: string): RcConfig {
    return {
      id: c.id || "daemon",
      hostId,
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

    return {
      projects,
      sessions,
      config,
      syncAll: () => {
        if (!opts.isOpen()) return;
        mgr.syncAll().catch((e) => console.warn("[rc-sync] syncAll:", e));
      },
    };
  }

  return {
    storeFor(hostId: string) {
      let store = stores.get(hostId);
      if (!store) {
        store = buildStore(hostId);
        stores.set(hostId, store);
      }
      return store;
    },
    handleMessage(msg: any): boolean {
      // pull responses resolve their pending request by numeric id.
      if (typeof msg?.id === "number" && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (typeof msg.error === "string" && msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg);
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
