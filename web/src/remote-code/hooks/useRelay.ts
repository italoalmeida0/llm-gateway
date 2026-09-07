import { createSignal, onCleanup } from "solid-js";
import { currentSession } from "../../api";

/** Socket do daemon + heartbeat + reconnect com backoff (extraído de
 * RemoteCodePage sem mudança de comportamento).
 *
 * O hook é burro quanto ao protocolo: `send` só carimba o hostId, e os
 * eventos de ciclo de vida (open/close/message) são delegados à página,
 * que compõe os restantes domínios. */

export type RelayState = "connecting" | "connected" | "disconnected";

export function createRelay(opts: {
  getHostId: () => string;
  /** Mensagem decodificada vinda do relay (página faz batch + dispatch). */
  onMessage: (msg: any) => void;
  /** Socket aberto e pronto: página sincroniza (modelos, mirror, sessão). */
  onOpen: (hostId: string) => void;
  /** Socket fechado (não-dispose): página limpa estado por-conexão. */
  onClose: () => void;
  /** Antes de religar: refresca auth/hosts (token pode ter expirado). */
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

  function send(payload: any) {
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

  /** Troca de host: zera o backoff antes de religar (como o efeito fazia). */
  function resetBackoff() {
    reconnectAttempt = 0;
  }

  /** Desliga sem religar (troca de host): a próxima connect() recomeça. */
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
