import {
  createSignal,
  createEffect,
  createMemo,
  onMount,
  onCleanup,
  For,
  Show,
} from "solid-js";
import {
  api,
  currentSession,
  type RemoteHostDto,
  type RemotePairDto,
} from "../api";
import {
  Btn,
  Card,
  Icon,
  Icons,
  Input,
  Modal,
  copyWithToast,
  fmtDate,
  toast,
} from "../ui";

/**
 * Remote Code interfaces and types
 */

export interface SessionSummary {
  id: string;
  cwd: string;
  title: string;
  model: string;
  status: "idle" | "running";
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface ContentBlock {
  type: "text" | "tool_call" | "tool_result" | "reasoning";
  text?: string;
  toolId?: string;
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
  isError?: boolean;
  reasoning?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  blocks: ContentBlock[];
  time?: number;
}

export interface PendingApproval {
  callId: string;
  tool: string;
  args: string;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  path: string;
}

const DEFAULT_MODELS = [
  { id: "gpt-4o", name: "GPT-4o" },
  { id: "gpt-4o-mini", name: "GPT-4o Mini" },
  { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet" },
  { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku" },
];

/**
 * Safe client-side Markdown formatter (zero deps).
 * Escapes raw HTML, then processes markdown blocks and inline tokens.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderMarkdown(md: string): string {
  if (!md) return "";

  // 1. Extract and preserve fenced code blocks with placeholders
  const codeBlocks: string[] = [];
  const placeholderPrefix = "___CODE_BLOCK_PLACEHOLDER_";

  let processed = md.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    const escapedCode = escapeHtml(code.trimEnd());
    const displayLang = lang ? escapeHtml(lang) : "text";
    const blockHtml = `
      <div class="my-3 overflow-hidden rounded-xl border border-line bg-ink-950 font-mono text-xs shadow-sm">
        <div class="flex items-center justify-between border-b border-line/60 bg-ink-900/70 px-3.5 py-1.5 text-[11px] text-ink-400">
          <span class="font-semibold uppercase tracking-wider text-ink-300">${displayLang}</span>
          <button
            class="text-ink-400 hover:text-ink-100 transition-colors cursor-pointer"
            onclick="navigator.clipboard.writeText(decodeURIComponent('${encodeURIComponent(code)}'))"
            title="Copy snippet"
          >
            Copy
          </button>
        </div>
        <pre class="p-3.5 overflow-x-auto text-ink-100 leading-relaxed"><code>${escapedCode}</code></pre>
      </div>`;
    codeBlocks.push(blockHtml);
    return `${placeholderPrefix}${idx}___`;
  });

  // 2. Escape remaining text
  processed = escapeHtml(processed);

  // 3. Inline formatting
  // Inline code
  processed = processed.replace(/`([^`]+)`/g, '<code class="rounded bg-ink-800/80 px-1.5 py-0.5 font-mono text-[12px] text-brand-400">$1</code>');
  // Bold
  processed = processed.replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold text-ink-100">$1</strong>');
  // Italic
  processed = processed.replace(/\*([^*]+)\*/g, '<em class="italic text-ink-200">$1</em>');
  // Headings
  processed = processed.replace(/^### (.*$)/gm, '<h3 class="text-sm font-semibold text-ink-100 mt-3 mb-1.5">$1</h3>');
  processed = processed.replace(/^## (.*$)/gm, '<h2 class="text-base font-semibold text-ink-100 mt-4 mb-2">$1</h2>');
  processed = processed.replace(/^# (.*$)/gm, '<h1 class="text-lg font-bold text-ink-100 mt-4 mb-2">$1</h1>');
  // Blockquotes
  processed = processed.replace(/^> (.*$)/gm, '<blockquote class="border-l-2 border-brand-500 pl-3 my-2 text-ink-300 italic">$1</blockquote>');
  // Unordered list items
  processed = processed.replace(/^[*-] (.*$)/gm, '<li class="ml-4 list-disc text-ink-200 my-0.5">$1</li>');

  // Links
  processed = processed.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-brand-400 hover:underline inline-flex items-center gap-0.5">$1</a>');

  // Paragraphs
  const paragraphs = processed.split(/\n\n+/);
  processed = paragraphs
    .map((p) => {
      if (p.includes(placeholderPrefix) || p.startsWith("<h") || p.startsWith("<li") || p.startsWith("<block")) {
        return p;
      }
      return `<p class="mb-2 leading-relaxed text-ink-200">${p.replace(/\n/g, "<br/>")}</p>`;
    })
    .join("");

  // 4. Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    processed = processed.replace(`${placeholderPrefix}${i}___`, codeBlocks[i]!);
  }

  return processed;
}

/**
 * Convert backend Go provider.Message array to client ChatMessage array
 */
function normalizeMessages(rawMessages: any[]): ChatMessage[] {
  if (!Array.isArray(rawMessages)) return [];
  const list: ChatMessage[] = [];

  for (let i = 0; i < rawMessages.length; i++) {
    const raw = rawMessages[i];
    const role = raw.role ?? "user";
    const rawBlocks = Array.isArray(raw.content) ? raw.content : [];
    const blocks: ContentBlock[] = [];

    for (const b of rawBlocks) {
      if (b.text !== undefined) {
        blocks.push({ type: "text", text: b.text });
      } else if (b.name !== undefined && b.id !== undefined) {
        let argsStr = "";
        try {
          argsStr = typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments, null, 2);
        } catch {
          argsStr = String(b.arguments ?? "");
        }
        blocks.push({
          type: "tool_call",
          toolId: b.id,
          toolName: b.name,
          toolArgs: argsStr,
        });
      } else if (b.call_id !== undefined) {
        let resStr = "";
        if (Array.isArray(b.content)) {
          resStr = b.content.map((c: any) => c.text ?? "").join("\n");
        } else if (typeof b.content === "string") {
          resStr = b.content;
        }
        blocks.push({
          type: "tool_result",
          toolId: b.call_id,
          toolResult: resStr,
          isError: !!b.is_error,
        });
      } else if (b.summary !== undefined || b.reasoning_id !== undefined) {
        blocks.push({
          type: "reasoning",
          reasoning: b.summary || "Thinking process",
        });
      }
    }

    list.push({
      id: `msg_${i}_${Date.now()}`,
      role,
      blocks,
      time: raw.time ? new Date(raw.time).getTime() : Date.now(),
    });
  }

  return list;
}

export default function RemoteCodePage() {
  // ----- Signals & State -----
  const [hosts, setHosts] = createSignal<RemoteHostDto[]>([]);
  const [hostsLoading, setHostsLoading] = createSignal(true);
  const [activeHostId, setActiveHostId] = createSignal<string | null>(
    localStorage.getItem("llmgw_remote_active_host") || null,
  );

  const [sessions, setSessions] = createSignal<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = createSignal<string | null>(
    localStorage.getItem("llmgw_remote_active_session") || null,
  );

  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [sessionStatus, setSessionStatus] = createSignal<"idle" | "running">("idle");
  const [promptInput, setPromptInput] = createSignal("");
  const [yolo, setYolo] = createSignal<boolean>(
    localStorage.getItem("llmgw_remote_yolo") !== "false",
  );
  const [pendingApproval, setPendingApproval] = createSignal<PendingApproval | null>(null);

  // Models
  const [models, setModels] = createSignal<Array<{ id: string; name: string }>>(DEFAULT_MODELS);
  const [selectedModel, setSelectedModel] = createSignal<string>("gpt-4o");

  // Modals & Drawers
  const [showPairModal, setShowPairModal] = createSignal(false);
  const [pairData, setPairData] = createSignal<RemotePairDto | null>(null);
  const [pairLoading, setPairLoading] = createSignal(false);

  const [showNewSessionModal, setShowNewSessionModal] = createSignal(false);
  const [newCwd, setNewCwd] = createSignal("~");
  const [newTitle, setNewTitle] = createSignal("");
  const [newModel, setNewModel] = createSignal("gpt-4o");

  const [mobileSidebar, setMobileSidebar] = createSignal(false);

  // WebSocket
  let ws: WebSocket | null = null;
  const [wsConnected, setWsConnected] = createSignal(false);
  let reconnectTimer: any = null;
  let chatScrollContainer: HTMLDivElement | undefined;

  // Active host helper
  const activeHost = createMemo(() => {
    const id = activeHostId();
    return hosts().find((h) => h.id === id) ?? null;
  });

  // Active session helper
  const activeSession = createMemo(() => {
    const id = activeSessionId();
    return sessions().find((s) => s.id === id) ?? null;
  });

  // Persist selections
  createEffect(() => {
    const hId = activeHostId();
    if (hId) localStorage.setItem("llmgw_remote_active_host", hId);
    else localStorage.removeItem("llmgw_remote_active_host");
  });

  createEffect(() => {
    const sId = activeSessionId();
    if (sId) localStorage.setItem("llmgw_remote_active_session", sId);
    else localStorage.removeItem("llmgw_remote_active_session");
  });

  createEffect(() => {
    localStorage.setItem("llmgw_remote_yolo", String(yolo()));
  });

  // Auto-scroll chat to bottom
  const scrollToBottom = (smooth = true) => {
    if (!chatScrollContainer) return;
    chatScrollContainer.scrollTo({
      top: chatScrollContainer.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  };

  // ----- API & WebSocket Management -----

  const fetchHosts = async () => {
    try {
      setHostsLoading(true);
      const res = await api<{ hosts: RemoteHostDto[] }>("GET", "/api/remote/hosts");
      setHosts(res.hosts);
      if (res.hosts.length > 0) {
        if (!activeHostId() || !res.hosts.some((h) => h.id === activeHostId())) {
          setActiveHostId(res.hosts[0]!.id);
        }
      } else {
        setActiveHostId(null);
      }
    } catch (e: any) {
      toast(e?.message || "Failed to load remote hosts");
    } finally {
      setHostsLoading(false);
    }
  };

  const fetchModels = async () => {
    try {
      const res = await api<{ models: Array<{ id: string; name: string }> }>("GET", "/api/me/models");
      if (res.models && res.models.length > 0) {
        setModels(res.models);
        setSelectedModel(res.models[0]!.id);
      }
    } catch {
      // Keep defaults
    }
  };

  const sendWs = (payload: any) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      console.error("[WS] Send error:", e);
    }
  };

  const connectWebSocket = () => {
    const session = currentSession();
    if (!session?.accessToken) return;

    if (ws) {
      try {
        ws.close();
      } catch {}
    }

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${proto}//${location.host}/api/remote/client/ws?token=${encodeURIComponent(session.accessToken)}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setWsConnected(true);
      const hId = activeHostId();
      if (hId) {
        sendWs({ hostId: hId, type: "list_sessions" });
      }
    };

    ws.onclose = () => {
      setWsConnected(false);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        connectWebSocket();
      }, 2500);
    };

    ws.onerror = () => {
      setWsConnected(false);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleWsMessage(msg);
      } catch (e) {
        console.error("[WS] Failed to parse message:", e);
      }
    };
  };

  const handleWsMessage = (msg: any) => {
    switch (msg.type) {
      case "host_status": {
        setHosts((prev) =>
          prev.map((h) =>
            h.id === msg.hostId ? { ...h, status: msg.status } : h,
          ),
        );
        if (msg.status === "online" && msg.hostId === activeHostId()) {
          sendWs({ hostId: msg.hostId, type: "list_sessions" });
        }
        break;
      }

      case "session_list":
      case "sessions_list": {
        if (msg.hostId === activeHostId() && Array.isArray(msg.sessions)) {
          setSessions(msg.sessions);
          localStorage.setItem(`llmgw_remote_sessions_${msg.hostId}`, JSON.stringify(msg.sessions));

          // Auto-select first session if active session isn't in list
          if (!activeSessionId() || !msg.sessions.some((s: any) => s.id === activeSessionId())) {
            if (msg.sessions.length > 0) {
              selectSession(msg.sessions[0].id);
            } else {
              setActiveSessionId(null);
              setMessages([]);
            }
          }
        }
        break;
      }

      case "session_created": {
        if (msg.hostId === activeHostId() && msg.session) {
          const newSess: SessionSummary = {
            id: msg.session.id,
            cwd: msg.session.cwd,
            title: msg.session.title,
            model: msg.session.model,
            status: "idle",
            createdAt: msg.session.createdAt,
            updatedAt: msg.session.updatedAt,
            messageCount: (msg.session.messages ?? []).length,
          };
          setSessions((prev) => [newSess, ...prev.filter((s) => s.id !== newSess.id)]);
          selectSession(newSess.id);
          toast(`Session "${newSess.title}" created`);
        }
        break;
      }

      case "session_deleted": {
        if (msg.hostId === activeHostId()) {
          setSessions((prev) => prev.filter((s) => s.id !== msg.sessionId));
          if (activeSessionId() === msg.sessionId) {
            const remaining = sessions();
            if (remaining.length > 0) {
              selectSession(remaining[0]!.id);
            } else {
              setActiveSessionId(null);
              setMessages([]);
            }
          }
        }
        break;
      }

      case "session_data": {
        if (msg.session && msg.session.id === activeSessionId()) {
          const norm = normalizeMessages(msg.session.messages ?? []);
          setMessages(norm);
          setSessionStatus(msg.session.status ?? "idle");
          localStorage.setItem(`llmgw_remote_transcript_${msg.session.id}`, JSON.stringify(norm));
          setTimeout(() => scrollToBottom(false), 50);
        }
        break;
      }

      case "session_status": {
        if (msg.sessionId === activeSessionId()) {
          setSessionStatus(msg.status);
          setSessions((prev) =>
            prev.map((s) => (s.id === msg.sessionId ? { ...s, status: msg.status } : s)),
          );
        }
        break;
      }

      case "tool_approval_request": {
        if (msg.sessionId === activeSessionId()) {
          setPendingApproval({
            callId: msg.callId,
            tool: msg.tool,
            args: typeof msg.args === "string" ? msg.args : JSON.stringify(msg.args, null, 2),
          });
          scrollToBottom(true);
        }
        break;
      }

      case "agent_event": {
        if (msg.sessionId !== activeSessionId()) return;
        const ev = msg.event;
        if (!ev) return;

        handleAgentEvent(ev);
        break;
      }

      case "error": {
        if (msg.message) {
          toast(msg.message);
        }
        setSessionStatus("idle");
        break;
      }
    }
  };

  const handleAgentEvent = (ev: any) => {
    switch (ev.type) {
      case "turn_start": {
        setSessionStatus("running");
        break;
      }

      case "text_delta": {
        setMessages((prev) => {
          const lastMsg = prev[prev.length - 1];
          if (lastMsg && lastMsg.role === "assistant") {
            const blocks = [...lastMsg.blocks];
            const lastBlock = blocks[blocks.length - 1];
            if (lastBlock && lastBlock.type === "text") {
              blocks[blocks.length - 1] = {
                ...lastBlock,
                text: (lastBlock.text || "") + ev.delta,
              };
            } else {
              blocks.push({ type: "text", text: ev.delta });
            }
            return [...prev.slice(0, -1), { ...lastMsg, blocks }];
          } else {
            // New assistant message turn
            return [
              ...prev,
              {
                id: `assistant_${Date.now()}`,
                role: "assistant",
                blocks: [{ type: "text", text: ev.delta }],
                time: Date.now(),
              },
            ];
          }
        });
        scrollToBottom(true);
        break;
      }

      case "tool_call": {
        setMessages((prev) => {
          const lastMsg = prev[prev.length - 1];
          const newBlock: ContentBlock = {
            type: "tool_call",
            toolId: ev.id,
            toolName: ev.name,
            toolArgs: typeof ev.args === "string" ? ev.args : JSON.stringify(ev.args, null, 2),
          };

          if (lastMsg && lastMsg.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              { ...lastMsg, blocks: [...lastMsg.blocks, newBlock] },
            ];
          } else {
            return [
              ...prev,
              {
                id: `assistant_${Date.now()}`,
                role: "assistant",
                blocks: [newBlock],
                time: Date.now(),
              },
            ];
          }
        });
        scrollToBottom(true);
        break;
      }

      case "tool_result": {
        setPendingApproval(null);
        setMessages((prev) => {
          return prev.map((msg) => {
            if (msg.role !== "assistant") return msg;
            const updatedBlocks = msg.blocks.map((b) => {
              if (b.type === "tool_call" && b.toolId === ev.id) {
                return {
                  ...b,
                  toolResult: ev.content,
                  isError: ev.isError,
                };
              }
              return b;
            });
            return { ...msg, blocks: updatedBlocks };
          });
        });
        scrollToBottom(true);
        break;
      }

      case "turn_end": {
        break;
      }

      case "done": {
        setSessionStatus("idle");
        setPendingApproval(null);
        const sId = activeSessionId();
        if (sId) {
          localStorage.setItem(`llmgw_remote_transcript_${sId}`, JSON.stringify(messages()));
        }
        break;
      }
    }
  };

  // ----- Actions & Handlers -----

  const selectHost = (hostId: string) => {
    setActiveHostId(hostId);
    setActiveSessionId(null);
    setMessages([]);
    setSessions([]);

    try {
      const cached = localStorage.getItem(`llmgw_remote_sessions_${hostId}`);
      if (cached) setSessions(JSON.parse(cached));
    } catch {}

    sendWs({ hostId, type: "list_sessions" });
  };

  const selectSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    setPendingApproval(null);

    try {
      const cached = localStorage.getItem(`llmgw_remote_transcript_${sessionId}`);
      if (cached) setMessages(JSON.parse(cached));
    } catch {}

    const hId = activeHostId();
    if (hId) {
      sendWs({ hostId: hId, type: "get_session", sessionId });
    }
    setTimeout(() => scrollToBottom(false), 50);
  };

  const startPairing = async () => {
    try {
      setPairLoading(true);
      setShowPairModal(true);
      const res = await api<RemotePairDto>("POST", "/api/remote/pair");
      setPairData(res);
    } catch (e: any) {
      toast(e?.message || "Failed to generate pairing token");
    } finally {
      setPairLoading(false);
    }
  };

  const deleteHost = async (hostId: string, e: MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to remove this host machine? This will revoke its credentials.")) {
      return;
    }
    try {
      await api("DELETE", `/api/remote/hosts/${hostId}`);
      toast("Host machine removed");
      await fetchHosts();
    } catch (e: any) {
      toast(e?.message || "Failed to remove host");
    }
  };

  const openNewSessionModal = () => {
    const act = activeSession();
    if (act) {
      setNewCwd(act.cwd);
    } else {
      setNewCwd("~");
    }
    setNewTitle("");
    setNewModel(selectedModel());
    setShowNewSessionModal(true);
  };

  const submitCreateSession = () => {
    const hId = activeHostId();
    if (!hId) return;

    sendWs({
      hostId: hId,
      type: "create_session",
      cwd: newCwd().trim() || "~",
      title: newTitle().trim(),
      model: newModel(),
    });

    setShowNewSessionModal(false);
  };

  const deleteSession = (sessId: string, e: MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete this session and its local transcripts?")) return;
    const hId = activeHostId();
    if (!hId) return;

    sendWs({
      hostId: hId,
      type: "delete_session",
      sessionId: sessId,
    });
  };

  const sendPrompt = () => {
    const text = promptInput().trim();
    if (!text) return;
    const hId = activeHostId();
    const sId = activeSessionId();
    if (!hId || !sId) return;

    const userMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      role: "user",
      blocks: [{ type: "text", text }],
      time: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setPromptInput("");
    setSessionStatus("running");
    scrollToBottom(true);

    sendWs({
      hostId: hId,
      type: "prompt",
      sessionId: sId,
      text,
      model: selectedModel(),
      yolo: yolo(),
    });
  };

  const cancelTurn = () => {
    const hId = activeHostId();
    const sId = activeSessionId();
    if (!hId || !sId) return;

    sendWs({
      hostId: hId,
      type: "cancel",
      sessionId: sId,
    });
    setSessionStatus("idle");
    setPendingApproval(null);
  };

  const respondApproval = (approved: boolean) => {
    const appr = pendingApproval();
    const hId = activeHostId();
    const sId = activeSessionId();
    if (!appr || !hId || !sId) return;

    sendWs({
      hostId: hId,
      type: "tool_approval_response",
      sessionId: sId,
      callId: appr.callId,
      approved,
    });
    setPendingApproval(null);
  };

  const handleComposerKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (sessionStatus() === "running") return;
      sendPrompt();
    }
  };

  onMount(() => {
    fetchHosts();
    fetchModels();
    connectWebSocket();
  });

  onCleanup(() => {
    clearTimeout(reconnectTimer);
    if (ws) {
      try {
        ws.close();
      } catch {}
    }
  });

  return (
    <div class="h-[calc(100vh-130px)] flex flex-col min-h-[550px] -my-4 sm:-my-6 lg:-my-8">
      {/* Top action header */}
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4 mb-4">
        <div class="flex items-center gap-3 min-w-0">
          <div class="flex items-center gap-2">
            <span class="inline-flex h-2.5 w-2.5 rounded-full bg-brand-500 animate-pulse" />
            <h1 class="text-xl font-bold tracking-tight text-ink-100">Remote Code</h1>
          </div>

          <Show when={activeHost()}>
            {(host) => (
              <div class="hidden sm:flex items-center gap-2 px-3 py-1 rounded-lg border border-line bg-card text-xs">
                <span
                  class={`h-2 w-2 rounded-full ${host().status === "online" ? "bg-emerald-500" : "bg-ink-600"}`}
                />
                <span class="font-medium text-ink-100">{host().name}</span>
                <span class="text-ink-500">({host().os}/{host().arch})</span>
              </div>
            )}
          </Show>
        </div>

        <div class="flex items-center gap-2">
          {/* YOLO mode toggle */}
          <button
            onClick={() => setYolo(!yolo())}
            class={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all cursor-pointer ${
              yolo()
                ? "border-brand-500/40 bg-brand-500/10 text-brand-400 hover:bg-brand-500/20 shadow-sm"
                : "border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
            }`}
            title={yolo() ? "YOLO Mode: Tools execute automatically without approvals" : "Safe Mode: Tools require interactive confirmation"}
          >
            <Icon name={Icons.shield} size={14} />
            <span>{yolo() ? "YOLO Mode ON" : "Approvals Required"}</span>
          </button>

          {/* Connect Machine button */}
          <Btn variant="secondary" size="sm" onClick={startPairing}>
            <Icon name={Icons.plus} size={14} />
            <span class="hidden sm:inline">Connect Machine</span>
            <span class="sm:hidden">Pair</span>
          </Btn>

          {/* Mobile drawer toggle */}
          <button
            class="md:hidden flex h-8 w-8 items-center justify-center rounded-lg border border-line text-ink-300 hover:bg-ink-800"
            onClick={() => setMobileSidebar(!mobileSidebar())}
            aria-label="Toggle sessions sidebar"
          >
            <Icon name={Icons.menu} size={16} />
          </button>
        </div>
      </div>

      {/* Main Workspace Layout */}
      <Show
        when={hosts().length > 0}
        fallback={
          <Card class="flex-1 flex items-center justify-center py-16 text-center">
            <div class="max-w-md mx-auto space-y-4">
              <div class="w-14 h-14 mx-auto rounded-2xl bg-brand-500/10 text-brand-500 flex items-center justify-center">
                <Icon name={Icons.terminal} size={30} />
              </div>
              <h2 class="text-lg font-bold text-ink-100">No Remote Machines Connected</h2>
              <p class="text-sm text-ink-400">
                Connect your development machine, server, or cloud instance to run code remotely from any browser.
              </p>
              <Btn variant="primary" onClick={startPairing} loading={pairLoading()}>
                <Icon name={Icons.plus} size={16} />
                Connect Machine
              </Btn>
            </div>
          </Card>
        }
      >
        <div class="flex-1 flex gap-4 min-h-0 relative">
          {/* ===== SIDEBAR: Hosts & Sessions ===== */}
          <aside
            class={`
              absolute md:relative inset-y-0 left-0 z-20 w-72 flex flex-col border border-line rounded-2xl bg-card transition-all duration-200
              ${mobileSidebar() ? "translate-x-0 shadow-2xl" : "-translate-x-full md:translate-x-0"}
            `}
          >
            {/* Host switcher */}
            <div class="p-3 border-b border-line flex items-center justify-between gap-2">
              <div class="flex-1 min-w-0">
                <label class="block text-[10px] font-bold uppercase tracking-wider text-ink-500 mb-1">
                  Connected Machine
                </label>
                <select
                  class="w-full rounded-lg border border-line bg-elev px-2.5 py-1.5 text-xs text-ink-100 font-medium truncate outline-none focus:border-brand-500 cursor-pointer"
                  value={activeHostId() ?? ""}
                  onChange={(e) => selectHost(e.currentTarget.value)}
                >
                  <For each={hosts()}>
                    {(h) => (
                      <option value={h.id}>
                        {h.name} ({h.status === "online" ? "● online" : "○ offline"})
                      </option>
                    )}
                  </For>
                </select>
              </div>

              <Show when={activeHost()}>
                {(h) => (
                  <button
                    onClick={(e) => deleteHost(h().id, e)}
                    class="mt-4 p-1.5 text-ink-500 hover:text-rose-500 rounded-lg hover:bg-rose-500/10 transition-colors cursor-pointer"
                    title="Remove host machine"
                  >
                    <Icon name={Icons.trash} size={14} />
                  </button>
                )}
              </Show>
            </div>

            {/* Sessions Header & New Session Button */}
            <div class="p-3 border-b border-line flex items-center justify-between">
              <span class="text-xs font-semibold text-ink-200">Sessions</span>
              <button
                onClick={openNewSessionModal}
                disabled={activeHost()?.status !== "online"}
                class="flex items-center gap-1 text-xs font-medium text-brand-400 hover:text-brand-300 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                <Icon name={Icons.plus} size={13} />
                <span>New Session</span>
              </button>
            </div>

            {/* Session List */}
            <div class="flex-1 overflow-y-auto p-2 space-y-1">
              <Show
                when={sessions().length > 0}
                fallback={
                  <div class="p-4 text-center text-xs text-ink-500">
                    No sessions yet. Click "New Session" to start.
                  </div>
                }
              >
                <For each={sessions()}>
                  {(sess) => {
                    const isActive = () => sess.id === activeSessionId();
                    return (
                      <div
                        onClick={() => {
                          selectSession(sess.id);
                          setMobileSidebar(false);
                        }}
                        class={`group relative flex flex-col p-2.5 rounded-xl border transition-all cursor-pointer ${
                          isActive()
                            ? "border-brand-500/50 bg-brand-500/10 text-ink-100"
                            : "border-transparent hover:border-line hover:bg-elev text-ink-300"
                        }`}
                      >
                        <div class="flex items-center justify-between gap-1 mb-1">
                          <span class="text-xs font-semibold truncate text-ink-100">
                            {sess.title || "Untitled Session"}
                          </span>
                          <Show when={sess.status === "running"}>
                            <span class="h-2 w-2 rounded-full bg-brand-500 animate-ping" />
                          </Show>
                        </div>
                        <div class="flex items-center gap-1.5 text-[11px] text-ink-500 font-mono truncate">
                          <Icon name={Icons.folder} size={11} />
                          <span class="truncate">{sess.cwd}</span>
                        </div>
                        <div class="flex items-center justify-between text-[10px] text-ink-500 mt-1">
                          <span>{fmtDate(sess.updatedAt)}</span>
                          <button
                            onClick={(e) => deleteSession(sess.id, e)}
                            class="opacity-0 group-hover:opacity-100 hover:text-rose-500 p-0.5 transition-opacity"
                            title="Delete session"
                          >
                            <Icon name={Icons.trash} size={12} />
                          </button>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </Show>
            </div>
          </aside>

          {/* ===== MAIN CHAT / TERMINAL AREA ===== */}
          <main class="flex-1 flex flex-col min-w-0 border border-line rounded-2xl bg-card overflow-hidden">
            {/* Chat header */}
            <div class="h-12 border-b border-line bg-elev/50 px-4 flex items-center justify-between gap-3 shrink-0">
              <div class="flex items-center gap-2 min-w-0">
                <Show
                  when={activeSession()}
                  fallback={
                    <span class="text-xs text-ink-500">Select or create a session</span>
                  }
                >
                  {(sess) => (
                    <>
                      <div class="flex items-center gap-1 text-xs font-semibold text-ink-100 truncate">
                        <Icon name={Icons.terminal} size={14} class="text-brand-400" />
                        <span class="truncate">{sess().title}</span>
                      </div>
                      <span class="text-ink-600">•</span>
                      <div class="hidden sm:flex items-center gap-1 text-xs font-mono text-ink-400 truncate">
                        <Icon name={Icons.folder} size={12} />
                        <span class="truncate">{sess().cwd}</span>
                      </div>
                    </>
                  )}
                </Show>
              </div>

              <div class="flex items-center gap-2">
                {/* Model Selector */}
                <select
                  class="rounded-lg border border-line bg-ink-950 px-2 py-1 text-xs text-ink-200 outline-none focus:border-brand-500 cursor-pointer"
                  value={selectedModel()}
                  onChange={(e) => setSelectedModel(e.currentTarget.value)}
                >
                  <For each={models()}>
                    {(m) => <option value={m.id}>{m.name}</option>}
                  </For>
                </select>

                {/* Stop button when running */}
                <Show when={sessionStatus() === "running"}>
                  <button
                    onClick={cancelTurn}
                    class="flex items-center gap-1 rounded-lg bg-rose-500/20 text-rose-400 border border-rose-500/40 px-2.5 py-1 text-xs font-semibold hover:bg-rose-500/30 transition-colors cursor-pointer"
                  >
                    <Icon name={Icons.stop} size={12} />
                    <span>Stop</span>
                  </button>
                </Show>
              </div>
            </div>

            {/* Chat message timeline */}
            <div
              ref={chatScrollContainer}
              class="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4"
            >
              <Show
                when={messages().length > 0}
                fallback={
                  <div class="h-full flex flex-col items-center justify-center text-center p-6 space-y-3">
                    <div class="w-12 h-12 rounded-2xl bg-brand-500/10 text-brand-500 flex items-center justify-center">
                      <Icon name={Icons.terminal} size={24} />
                    </div>
                    <div class="max-w-md space-y-1">
                      <h3 class="text-sm font-semibold text-ink-100">Ready to Code</h3>
                      <p class="text-xs text-ink-400">
                        Ask questions, build features, fix bugs, or run commands. Your remote agent executes in{" "}
                        <span class="font-mono text-ink-200">{activeSession()?.cwd ?? "~"}</span>.
                      </p>
                    </div>

                    <div class="flex flex-wrap justify-center gap-2 pt-2">
                      {[
                        "List files in this project",
                        "Run tests and check status",
                        "Explain the project structure",
                      ].map((prompt) => (
                        <button
                          onClick={() => {
                            setPromptInput(prompt);
                          }}
                          class="rounded-xl border border-line bg-elev/60 px-3 py-1.5 text-xs text-ink-300 hover:text-ink-100 hover:border-brand-500/40 transition-colors cursor-pointer"
                        >
                          {prompt}
                        </button>
                      ))}
                    </div>
                  </div>
                }
              >
                <For each={messages()}>
                  {(msg) => (
                    <div
                      class={`flex gap-3 text-sm ${
                        msg.role === "user" ? "justify-end" : "justify-start"
                      }`}
                    >
                      <Show when={msg.role === "assistant"}>
                        <div class="w-7 h-7 rounded-xl bg-brand-500/20 text-brand-400 flex items-center justify-center shrink-0 mt-0.5">
                          <Icon name={Icons.bolt} size={15} />
                        </div>
                      </Show>

                      <div
                        class={`max-w-[90%] sm:max-w-[80%] rounded-2xl p-4 shadow-sm ${
                          msg.role === "user"
                            ? "bg-brand-500 text-white font-medium"
                            : "bg-elev border border-line text-ink-200"
                        }`}
                      >
                        <For each={msg.blocks}>
                          {(block) => (
                            <>
                              {/* Text Block */}
                              <Show when={block.type === "text" && block.text}>
                                <div
                                  class="prose-sm leading-relaxed select-text"
                                  innerHTML={
                                    msg.role === "user"
                                      ? escapeHtml(block.text || "").replace(/\n/g, "<br/>")
                                      : renderMarkdown(block.text || "")
                                  }
                                />
                              </Show>

                              {/* Reasoning Block */}
                              <Show when={block.type === "reasoning" && block.reasoning}>
                                <details class="my-2 rounded-xl border border-line/60 bg-ink-950/40 p-2.5 text-xs">
                                  <summary class="font-semibold text-ink-400 cursor-pointer hover:text-ink-200 select-none">
                                    Thinking process
                                  </summary>
                                  <div class="mt-2 text-ink-400 whitespace-pre-wrap font-mono text-[11px] leading-relaxed border-t border-line/40 pt-2">
                                    {block.reasoning}
                                  </div>
                                </details>
                              </Show>

                              {/* Tool Call Card */}
                              <Show when={block.type === "tool_call"}>
                                <ToolCard block={block} />
                              </Show>
                            </>
                          )}
                        </For>
                      </div>

                      <Show when={msg.role === "user"}>
                        <div class="w-7 h-7 rounded-xl bg-ink-800 text-ink-200 flex items-center justify-center shrink-0 mt-0.5 text-xs font-bold">
                          U
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>

              {/* Interactive Tool Approval Banner when YOLO is OFF */}
              <Show when={pendingApproval()}>
                {(appr) => (
                  <div class="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-3 anim-fade-in shadow-lg">
                    <div class="flex items-center gap-2 text-amber-400 font-semibold text-sm">
                      <Icon name={Icons.warning} size={18} />
                      <span>Tool Execution Approval Required</span>
                    </div>

                    <div class="rounded-xl bg-ink-950 p-3 font-mono text-xs text-ink-200 border border-line">
                      <div class="text-[11px] text-ink-500 font-bold uppercase mb-1">
                        Tool: <span class="text-brand-400">{appr().tool}</span>
                      </div>
                      <pre class="overflow-x-auto whitespace-pre-wrap">{appr().args}</pre>
                    </div>

                    <div class="flex items-center justify-end gap-2">
                      <Btn variant="danger" size="sm" onClick={() => respondApproval(false)}>
                        <Icon name={Icons.x} size={14} />
                        Reject
                      </Btn>
                      <Btn variant="primary" size="sm" onClick={() => respondApproval(true)}>
                        <Icon name={Icons.check} size={14} />
                        Approve &amp; Run
                      </Btn>
                    </div>
                  </div>
                )}
              </Show>
            </div>

            {/* Composer / Prompt input */}
            <div class="p-3 sm:p-4 border-t border-line bg-elev/30">
              <div class="relative flex items-end gap-2 rounded-2xl border border-line bg-ink-950 px-3 py-2 shadow-inner focus-within:border-brand-500 focus-within:ring-1 focus-within:ring-brand-500/30">
                <textarea
                  value={promptInput()}
                  onInput={(e) => setPromptInput(e.currentTarget.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder={
                    activeSession()
                      ? `Message agent in ${activeSession()?.cwd}... (Shift+Enter for newline)`
                      : "Create or select a session to begin..."
                  }
                  disabled={!activeSession() || activeHost()?.status !== "online"}
                  rows={2}
                  class="flex-1 max-h-40 min-h-[44px] resize-none bg-transparent text-sm text-ink-100 placeholder-ink-500 outline-none leading-relaxed disabled:opacity-50 disabled:cursor-not-allowed"
                />

                <Show
                  when={sessionStatus() === "running"}
                  fallback={
                    <button
                      onClick={sendPrompt}
                      disabled={!promptInput().trim() || !activeSession() || activeHost()?.status !== "online"}
                      class="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer shrink-0"
                      aria-label="Send prompt"
                    >
                      <Icon name={Icons.send} size={16} />
                    </button>
                  }
                >
                  <button
                    onClick={cancelTurn}
                    class="flex h-9 w-9 items-center justify-center rounded-xl bg-rose-500 text-white hover:bg-rose-600 transition-all cursor-pointer shrink-0"
                    aria-label="Stop generation"
                  >
                    <Icon name={Icons.stop} size={16} />
                  </button>
                </Show>
              </div>
              <div class="flex items-center justify-between text-[11px] text-ink-500 px-2 mt-2">
                <span>Enter sends • Shift+Enter adds newline</span>
                <span class="flex items-center gap-1">
                  <span
                    class={`h-1.5 w-1.5 rounded-full ${wsConnected() ? "bg-emerald-500" : "bg-rose-500"}`}
                  />
                  <span>{wsConnected() ? "Relay Connected" : "Connecting..."}</span>
                </span>
              </div>
            </div>
          </main>
        </div>
      </Show>

      {/* ===== PAIRING MODAL ===== */}
      <Modal
        title="Connect Machine"
        open={showPairModal()}
        onClose={() => setShowPairModal(false)}
      >
        <div class="space-y-4">
          <p class="text-sm text-ink-400 leading-relaxed">
            Run the single static daemon on your machine. Once paired, it persists configuration and stays ready for any directory.
          </p>

          <Show when={pairData()}>
            {(data) => {
              const cmd = `./llmgw-daemon --connect "${data().connectUrl}"`;
              return (
                <div class="space-y-3">
                  <div class="rounded-xl border border-line bg-ink-950 p-3 font-mono text-xs text-ink-100 flex items-center justify-between gap-2 overflow-hidden">
                    <span class="truncate">{cmd}</span>
                    <button
                      onClick={() => copyWithToast(cmd, "Command copied to clipboard")}
                      class="text-brand-400 hover:text-brand-300 font-sans font-semibold shrink-0 cursor-pointer"
                    >
                      Copy
                    </button>
                  </div>

                  <div class="flex items-center gap-2 text-xs text-ink-400">
                    <span class="inline-flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span>Listening for daemon connection...</span>
                  </div>

                  <div class="rounded-xl bg-elev p-3 text-xs text-ink-400 space-y-1.5 border border-line/60">
                    <div class="font-semibold text-ink-200">How it works:</div>
                    <ul class="list-disc pl-4 space-y-1 text-ink-300">
                      <li>The daemon connects to the gateway via WebSocket relay.</li>
                      <li>Transcripts and files remain 100% local on your machine.</li>
                      <li>Token expires in 15 minutes.</li>
                    </ul>
                  </div>
                </div>
              );
            }}
          </Show>

          <div class="flex justify-end pt-2">
            <Btn variant="secondary" onClick={() => setShowPairModal(false)}>
              Close
            </Btn>
          </div>
        </div>
      </Modal>

      {/* ===== NEW SESSION MODAL ===== */}
      <Modal
        title="Create New Session"
        open={showNewSessionModal()}
        onClose={() => setShowNewSessionModal(false)}
      >
        <div class="space-y-4">
          <Input
            label="Working Directory (CWD)"
            value={newCwd()}
            onInput={setNewCwd}
            placeholder="~/projects/my-app"
            hint="The daemon will execute tools relative to this path"
          />

          <Input
            label="Session Title (Optional)"
            value={newTitle()}
            onInput={setNewTitle}
            placeholder="e.g. Implement user auth"
          />

          <div>
            <label class="block text-xs font-semibold text-ink-200 mb-1.5">
              Model
            </label>
            <select
              class="w-full rounded-xl border border-line bg-elev px-3 py-2 text-sm text-ink-100 outline-none focus:border-brand-500 cursor-pointer"
              value={newModel()}
              onChange={(e) => setNewModel(e.currentTarget.value)}
            >
              <For each={models()}>
                {(m) => <option value={m.id}>{m.name}</option>}
              </For>
            </select>
          </div>

          <div class="flex items-center justify-end gap-2 pt-3 border-t border-line">
            <Btn variant="secondary" onClick={() => setShowNewSessionModal(false)}>
              Cancel
            </Btn>
            <Btn variant="primary" onClick={submitCreateSession}>
              Create Session
            </Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/**
 * Collapsible Tool Execution Card Component
 */
function ToolCard(props: { block: ContentBlock }) {
  const [expanded, setExpanded] = createSignal(true);
  const toolName = () => props.block.toolName || "tool";
  const hasResult = () => props.block.toolResult !== undefined;
  const isError = () => !!props.block.isError;

  return (
    <div class="my-2.5 overflow-hidden rounded-xl border border-line/80 bg-ink-950 font-mono text-xs shadow-sm">
      {/* Tool Header */}
      <div
        onClick={() => setExpanded(!expanded())}
        class="flex items-center justify-between border-b border-line/60 bg-ink-900/80 px-3.5 py-2 cursor-pointer select-none hover:bg-ink-850/80 transition-colors"
      >
        <div class="flex items-center gap-2 min-w-0">
          <span class="rounded bg-brand-500/20 px-1.5 py-0.5 text-[10px] font-bold text-brand-400 uppercase tracking-wider">
            {toolName()}
          </span>
          <span class="text-ink-400 font-sans text-xs truncate">
            {props.block.toolArgs?.slice(0, 60)}
          </span>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <Show
            when={hasResult()}
            fallback={
              <span class="flex items-center gap-1 text-[11px] text-amber-400 font-sans">
                <span class="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                running
              </span>
            }
          >
            <span
              class={`flex items-center gap-1 text-[11px] font-sans font-medium ${
                isError() ? "text-rose-400" : "text-emerald-400"
              }`}
            >
              <Icon name={isError() ? Icons.x : Icons.check} size={12} />
              {isError() ? "failed" : "success"}
            </span>
          </Show>
          <Icon
            name={Icons.chevronDown}
            size={12}
            class={`text-ink-400 transition-transform ${expanded() ? "rotate-180" : ""}`}
          />
        </div>
      </div>

      {/* Tool Body */}
      <Show when={expanded()}>
        <div class="p-3 space-y-2.5 text-ink-200">
          {/* Tool arguments */}
          <div>
            <div class="text-[10px] uppercase tracking-wider text-ink-500 font-bold mb-1 font-sans">
              Arguments
            </div>
            <pre class="overflow-x-auto rounded-lg bg-ink-900/60 p-2.5 text-[11px] leading-relaxed text-ink-300 max-h-48">
              {props.block.toolArgs}
            </pre>
          </div>

          {/* Tool result */}
          <Show when={props.block.toolResult !== undefined}>
            <div>
              <div class="flex items-center justify-between text-[10px] uppercase tracking-wider text-ink-500 font-bold mb-1 font-sans">
                <span>Output</span>
                <button
                  class="text-brand-400 hover:underline cursor-pointer lowercase"
                  onClick={() => copyWithToast(props.block.toolResult || "", "Output copied")}
                >
                  copy
                </button>
              </div>
              <pre
                class={`overflow-x-auto rounded-lg p-2.5 text-[11px] leading-relaxed max-h-60 ${
                  isError()
                    ? "bg-rose-950/20 text-rose-300 border border-rose-500/20"
                    : "bg-ink-900/60 text-ink-100"
                }`}
              >
                {props.block.toolResult || "(empty output)"}
              </pre>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
