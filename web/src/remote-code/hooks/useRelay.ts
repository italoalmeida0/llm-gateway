import { createSignal, onCleanup } from "solid-js";
import { currentSession } from "../../api";
import type { DaemonCommand } from "../daemon-protocol";

/** Daemon socket + heartbeat + reconnect with backoff (extracted from
 * RemoteCodePage without behavioral changes).
 *
 * The hook is agnostic regarding the protocol: `send` only stamps the hostId, and
 * lifecycle events (open/close/message) are delegated to the page,
 * which composes the remaining domains. */

export type RelayState = "connecting" | "connected" | "disconnected";

export function createRelay(opts: {
  getHostId: () => string;
  /** Decoded message from relay (page handles parse + batch + dispatch). */
  onMessage: (data: unknown) => void;
  /** Socket open and ready: page syncs (models, mirror, session). */
  onOpen: (hostId: string) => void;
  /** Closed socket (non-dispose): page cleans up per-connection state. */
  onClose: () => void;
  /** Before reconnecting: refreshes auth/hosts (token may have expired). */
  ensureAuth: () => Promise<void>;
  isActiveHost: (hostId: string) => boolean;
}) {
  let ws: WebSocket | null = null;
  const [connectionState, setConnectionState] = createSignal<RelayState>("disconnected");
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let heartbeatTimer: any = null;
  let disposed = false;

  function wsOpen() {
    try {
      return !!ws && (ws as WebSocket).readyState === WebSocket.OPEN;
    } catch {
      return false;
    }
  }

  function isDisposed() {
    return disposed;
  }

  function send(payload: DaemonCommand) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (!payload.hostId && opts.getHostId()) {
        payload.hostId = opts.getHostId();
      }
      ws.send(JSON.stringify(payload));
    }
  }

  function connect(hostId: string) {
    clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    if (disposed || !hostId) { setConnectionState("disconnected"); return; }
    const session = currentSession();
    if (!session) return;
    setConnectionState("connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${location.host}/api/remote/ws?token=${encodeURIComponent(session.accessToken)}`);
    ws = socket;
    socket.onopen = () => {
      if (socket !== ws || disposed) return;
      reconnectAttempt = 0;
      setConnectionState("connected");
      opts.onOpen(hostId);
      heartbeatTimer = setInterval(() => send({ type: "ping", ts: Date.now() }), 15000);
    };
    socket.onmessage = (ev) => {
      if (socket !== ws || disposed) return;
      try {
        opts.onMessage(JSON.parse(ev.data));
      } catch (err) {
        console.error("Remote Code message error:", err);
      }
    };
    socket.onclose = () => {
      if (socket !== ws || disposed) return;
      clearInterval(heartbeatTimer);
      setConnectionState("disconnected");
      opts.onClose();
      const delay = Math.min(1000 * 2 ** reconnectAttempt++, 15000);
      reconnectTimer = setTimeout(async () => {
        // An authenticated request refreshes an expired dashboard token first.
        await opts.ensureAuth();
        if (!disposed && opts.isActiveHost(hostId)) connect(hostId);
      }, delay);
    };
  }

  /** Host switch: resets backoff before reconnecting (as the effect did). */
  function resetBackoff() {
    reconnectAttempt = 0;
  }

  /** Disconnects without reconnecting (host switch): next connect() starts fresh. */
  function shutdown() {    clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
  }

  onCleanup(() => {
    disposed = true;
    clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
  });

  return { connectionState, setConnectionState, wsOpen, isDisposed, send, connect, shutdown, resetBackoff };
}

export type Relay = ReturnType<typeof createRelay>;
