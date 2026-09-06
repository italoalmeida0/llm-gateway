import type { Server, ServerWebSocket } from "bun";
import { db, stmts, type RemoteHostRow } from "../db";
import { GATEWAY_SECRET } from "../config";
import { jwtVerify, sha256Hex } from "../crypto";

export type WsData =
  | { type: "daemon"; hostId: string; userId: string }
  | { type: "client"; userId: string };

const daemons = new Map<string, ServerWebSocket<WsData>>();
const clientsByUserId = new Map<string, Set<ServerWebSocket<WsData>>>();

export function closeDaemonSocket(hostId: string): void {
  const ws = daemons.get(hostId);
  if (ws) {
    try {
      ws.send(JSON.stringify({ type: "disconnected", reason: "host_deleted" }));
      ws.close(1000, "host_deleted");
    } catch {}
    daemons.delete(hostId);
  }
}

export function isHostOnline(hostId: string): boolean {
  return daemons.has(hostId);
}

export async function handleRemoteUpgrade(
  path: string,
  req: Request,
  url: URL,
  server: Server<WsData>,
): Promise<Response | undefined> {
  // Daemon WebSocket: /api/remote/daemon/ws?token=<daemonToken>
  if (path === "/api/remote/daemon/ws") {
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

  // Client Web WebSocket: /api/remote/client/ws?token=<jwtToken> or /api/remote/ws?token=<jwtToken>
  if (path === "/api/remote/client/ws" || path === "/api/remote/ws") {
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
