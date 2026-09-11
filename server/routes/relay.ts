import type { Server, ServerWebSocket } from "bun";
import { db, stmts, type RemoteHostRow } from "../db";
import { GATEWAY_SECRET } from "../config";
import { jwtVerify, sha256Hex } from "../crypto";
import { sendTurnPush, type TurnPush } from "../push";

export type WsData =
  | { type: "daemon"; hostId: string; userId: string }
  | { type: "client"; userId: string };

const daemons = new Map<string, ServerWebSocket<WsData>>();
const clientsByUserId = new Map<string, Set<ServerWebSocket<WsData>>>();

export function closeDaemonSocket(hostId: string): void {
  const ws = daemons.get(hostId);
  if (ws) {
    try {
      // "shutdown" is the remote-kill signal: the daemon self-terminates
      // (quiesce + exit) instead of entering its reconnect backoff.
      // "disconnected" is kept for old daemons that only log it.
      ws.send(JSON.stringify({ type: "shutdown", hostId, reason: "host_deleted" }));
      ws.send(JSON.stringify({ type: "disconnected", reason: "host_deleted" }));
      ws.close(1000, "host_deleted");
    } catch {}
    daemons.delete(hostId);
  }
}

export function isHostOnline(hostId: string): boolean {
  return daemons.has(hostId);
}

export async function handleIndirectCodeUpgrade(
  path: string,
  req: Request,
  url: URL,
  server: Server<WsData>,
): Promise<Response | undefined> {
  // Daemon WebSocket: /api/indirect-code/daemon/ws?token=<daemonToken>
  if (path === "/api/indirect-code/daemon/ws") {
    let token = url.searchParams.get("token") || "";
    if (!token) {
      const authHeader = req.headers.get("authorization") || "";
      if (authHeader.startsWith("Bearer ")) token = authHeader.slice(7).trim();
    }
    if (!token) {
      return new Response("missing daemon token", { status: 401 });
    }

    const tokenHash = sha256Hex(token);
    const host = db
      .prepare<RemoteHostRow, [string]>(
        "SELECT * FROM remote_hosts WHERE daemon_token_hash = ?",
      )
      .get(tokenHash);

    if (!host) {
      return new Response("unauthorized daemon token", { status: 401 });
    }

    const upgraded = server.upgrade(req, {
      data: { type: "daemon", hostId: host.id, userId: host.user_id },
    });
    if (upgraded) return undefined;
    return new Response("upgrade failed", { status: 400 });
  }

  // Client Web WebSocket: /api/indirect-code/client/ws?token=<jwtToken> or /api/indirect-code/ws?token=<jwtToken>
  if (path === "/api/indirect-code/client/ws" || path === "/api/indirect-code/ws") {
    let token = url.searchParams.get("token") || "";
    if (!token) {
      const authHeader = req.headers.get("authorization") || "";
      if (authHeader.startsWith("Bearer ")) token = authHeader.slice(7).trim();
    }
    if (!token) {
      return new Response("missing access token", { status: 401 });
    }

    const res = await jwtVerify(token, GATEWAY_SECRET);
    if (!res.ok || res.payload.type !== "access") {
      return new Response("unauthorized access token", { status: 401 });
    }

    const session = stmts.sessionByJti.get(res.payload.jti);
    if (!session || session.revoked || session.expires_at < Date.now()) {
      return new Response("session expired or revoked", { status: 401 });
    }

    const upgraded = server.upgrade(req, {
      data: { type: "client", userId: res.payload.sub },
    });
    if (upgraded) return undefined;
    return new Response("upgrade failed", { status: 400 });
  }

  return new Response("not found", { status: 404 });
}

export const remoteRelayWsHandlers = {
  open(ws: ServerWebSocket<WsData>) {
    if (ws.data.type === "daemon") {
      const { hostId, userId } = ws.data;
      daemons.set(hostId, ws);

      const now = Date.now();
      db.prepare(
        "UPDATE remote_hosts SET status = 'online', last_seen_at = ? WHERE id = ?",
      ).run(now, hostId);

      // Notify connected clients of this user
      broadcastToUser(userId, {
        type: "host_status",
        hostId,
        status: "online",
      });
      console.log(`[RELAY] Daemon online: ${hostId} (user: ${userId})`);
    } else if (ws.data.type === "client") {
      const { userId } = ws.data;
      let set = clientsByUserId.get(userId);
      if (!set) {
        set = new Set();
        clientsByUserId.set(userId, set);
      }
      set.add(ws);

      try {
        ws.send(JSON.stringify({ type: "relay_connected", userId }));
      } catch {}
    }
  },

  message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
    const rawStr = typeof message === "string" ? message : message.toString("utf8");
    let parsed: any;
    try {
      parsed = JSON.parse(rawStr);
    } catch {
      return;
    }

    if (ws.data.type === "daemon") {
      // Message originating from Daemon -> forward to user's web client(s)
      const { userId } = ws.data;
      broadcastToUser(userId, rawStr);
      // Turn finished while the user has no tab open: wake the browser
      // via Web Push. Tabs open (Camada A) already notified — skip.
      maybePushTurnEnd(userId, ws.data.hostId, parsed);
    } else if (ws.data.type === "client") {
      // Message originating from Web Client -> route to target daemon
      const hostId = parsed.hostId;
      if (!hostId || typeof hostId !== "string") return;

      const daemonWs = daemons.get(hostId);
      if (daemonWs && daemonWs.data.type === "daemon" && daemonWs.data.userId === ws.data.userId) {
        try {
          daemonWs.send(rawStr);
        } catch (e) {
          console.error(`[RELAY] Error sending to daemon ${hostId}:`, e);
        }
      } else {
        // Daemon offline or not owned by user
        try {
          ws.send(
            JSON.stringify({
              type: "error",
              hostId,
              message: "Remote host is offline",
              replyTo: parsed.type,
              id: typeof parsed.id === "number" ? parsed.id : undefined,
              requestId: typeof parsed.requestId === "string" ? parsed.requestId : undefined,
              sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
            }),
          );
        } catch {}
      }
    }
  },

  close(ws: ServerWebSocket<WsData>, code: number, _reason: string) {
    if (ws.data.type === "daemon") {
      const { hostId, userId } = ws.data;
      if (daemons.get(hostId) === ws) {
        daemons.delete(hostId);
        const now = Date.now();
        db.prepare(
          "UPDATE remote_hosts SET status = 'offline', last_seen_at = ? WHERE id = ?",
        ).run(now, hostId);

        broadcastToUser(userId, {
          type: "host_status",
          hostId,
          status: "offline",
        });
        console.log(`[RELAY] Daemon offline: ${hostId} (code: ${code})`);
      }
    } else if (ws.data.type === "client") {
      const { userId } = ws.data;
      const set = clientsByUserId.get(userId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) clientsByUserId.delete(userId);
      }
    }
  },
};

/** Last-seen session titles from `session_data` (push needs a human name;
 *  `session_status` carries only ids). Bounded best-effort cache. */
const lastSessionTitle = new Map<string, string>();
/** Last `turn_end` disposition per turn (error/cancelled vary the push text). */
const lastDisposition = new Map<string, TurnPush["disposition"]>();

function turnKey(hostId: string, sessionId: string): string {
  return `${hostId}:${sessionId}`;
}

/**
 * Turn-end fan-out for closed tabs. Fires only when the user has zero
 * connected browser tabs (open tabs notify locally via Camada A) and the
 * daemon reports the real turn end: `session_status: idle` from finishTurn().
 * `turn_end` agent events are per-model-step, never a turn boundary.
 * Fire-and-forget: never blocks the relay hot path.
 */
function maybePushTurnEnd(userId: string, hostId: string, parsed: any): void {
  if (!parsed || typeof parsed !== "object") return;
  const sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
  if (!sessionId) return;
  const key = turnKey(hostId, sessionId);
  if (parsed.type === "session_data" && parsed.session && typeof parsed.session === "object") {
    const title = parsed.session.title;
    if (typeof title === "string" && title) {
      lastSessionTitle.set(key, title);
      if (lastSessionTitle.size > 2000) {
        const first = lastSessionTitle.keys().next();
        if (!first.done) lastSessionTitle.delete(first.value);
      }
    }
    return;
  }
  if (parsed.type === "agent_event" && parsed.event && typeof parsed.event === "object") {
    const ev = parsed.event;
    if (ev.type === "turn_end") {
      lastDisposition.set(
        key,
        ev.cancelled === true ? "cancelled" : typeof ev.error === "string" && ev.error ? "error" : "done",
      );
    }
    return;
  }
  if (parsed.type !== "session_status" || parsed.status !== "idle") return;
  const disposition = lastDisposition.get(key) ?? "done";
  lastDisposition.delete(key);
  const clients = clientsByUserId.get(userId);
  if (clients && clients.size > 0) return;
  const host = db
    .prepare<{ name: string; hostname: string }, [string]>("SELECT name, hostname FROM remote_hosts WHERE id = ?")
    .get(hostId);
  const title = lastSessionTitle.get(key) ?? sessionId.slice(0, 12);
  const push: TurnPush = {
    title,
    host: host?.name || host?.hostname || "host",
    disposition,
    url: "/#/code",
  };
  void sendTurnPush(userId, push).catch((e) => console.warn("[PUSH] fan-out failed:", e));
}

function broadcastToUser(userId: string, data: string | object): void {
  const set = clientsByUserId.get(userId);
  if (!set || set.size === 0) return;
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  for (const client of set) {
    try {
      client.send(payload);
    } catch {
      set.delete(client);
    }
  }
}
