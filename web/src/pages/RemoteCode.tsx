import {
  createSignal,
  createEffect,
  createMemo,
  onMount,
  onCleanup,
  For,
  Show,
} from "solid-js";
import { marked } from "marked";
import hljs from "highlight.js";
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
 * Interfaces & Types
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

export interface FileEntry {
  name: string;
  isDir: boolean;
  path: string;
  sizeBytes?: number;
  isOpen?: boolean;
  children?: FileEntry[];
  isLoading?: boolean;
}

export interface EditorTab {
  path: string;
  name: string;
  content: string;
  savedContent: string;
  isDirty: boolean;
  isLoading: boolean;
  viewMode: "code" | "diff" | "preview";
}

export interface GitFileStatus {
  status: string; // "M", "A", "D", "??"
  path: string;
}

export interface TerminalLog {
  id: string;
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timestamp: number;
}

export interface ZotSettings {
  model?: string;
  reasoning?: string;
  temperature?: number;
  auto_compact_threshold?: number;
  jail_by_default?: boolean;
  tool_render?: string;
  compact_input?: boolean;
  compact_mode?: boolean;
  recursive_file_suggest?: boolean;
  respect_gitignore?: boolean;
  insecure?: boolean;
  http_proxy?: string;
}

const DEFAULT_MODELS = [
  { id: "gpt-4o", name: "GPT-4o" },
  { id: "gpt-4o-mini", name: "GPT-4o Mini" },
  { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet" },
  { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku" },
];

const SLASH_COMMANDS = [
  { name: "/compact", desc: "Summarize and compact conversation to free up context", icon: "📦" },
  { name: "/clear", desc: "Clear the current chat transcript", icon: "🧹" },
  { name: "/jail", desc: "Confine agent tools strictly to session directory", icon: "🔒" },
  { name: "/unjail", desc: "Allow agent tools to access external paths", icon: "🔓" },
  { name: "/model", desc: "Switch the active model (/model <id>)", icon: "🤖" },
  { name: "/reasoning", desc: "Set reasoning effort (/reasoning <off|low|med|high>)", icon: "🧠" },
  { name: "/skills", desc: "List discovered agent tools and capabilities", icon: "🛠️" },
  { name: "/help", desc: "Show complete command reference", icon: "❓" },
];

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Custom renderer for marked with highlight.js syntax highlighting
const customRenderer = {
  code({ text, lang }: { text: string; lang?: string }) {
    const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
    let highlighted = "";
    try {
      highlighted = hljs.highlight(text, { language }).value;
    } catch {
      highlighted = escapeHtml(text);
    }
    return `
      <div class="my-2.5 overflow-hidden rounded-xl border border-line bg-ink-950 font-mono text-xs shadow-sm">
        <div class="flex items-center justify-between border-b border-line/60 bg-ink-900/80 px-3 py-1.5 text-[11px] text-ink-400">
          <span class="font-semibold uppercase tracking-wider text-ink-300">${escapeHtml(language)}</span>
          <button
            class="text-ink-400 hover:text-ink-100 transition-colors cursor-pointer text-[11px]"
            onclick="navigator.clipboard.writeText(decodeURIComponent('${encodeURIComponent(text)}'))"
            title="Copy code"
          >
            Copy
          </button>
        </div>
        <pre class="p-3 overflow-x-auto text-ink-100 leading-relaxed font-mono"><code>${highlighted}</code></pre>
      </div>`;
  },
};
marked.use({ renderer: customRenderer as any, breaks: true, gfm: true });

function renderMarkdown(md: string): string {
  if (!md) return "";
  try {
    return marked.parse(md) as string;
  } catch {
    return escapeHtml(md).replace(/\n/g, "<br/>");
  }
}

function getFileIcon(name: string): { label: string; color: string } {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (name === "package.json" || ext === "json") return { label: "{}", color: "text-amber-400" };
  if (name.startsWith(".git") || ext === "gitignore") return { label: "git", color: "text-orange-400" };
  if (name === "Dockerfile" || ext === "dockerfile") return { label: "🐳", color: "text-sky-400" };
  if (ext === "ts" || ext === "tsx") return { label: "TS", color: "text-blue-400 font-bold" };
  if (ext === "js" || ext === "jsx" || ext === "mjs") return { label: "JS", color: "text-yellow-400 font-bold" };
  if (ext === "go") return { label: "GO", color: "text-cyan-400 font-bold" };
  if (ext === "py") return { label: "PY", color: "text-emerald-400 font-bold" };
  if (ext === "md" || ext === "txt") return { label: "MD", color: "text-purple-400 font-bold" };
  if (ext === "css" || ext === "scss" || ext === "less") return { label: "#", color: "text-pink-400" };
  if (ext === "html") return { label: "<>", color: "text-orange-500 font-bold" };
  if (ext === "yaml" || ext === "yml") return { label: "YML", color: "text-amber-300 font-bold" };
  if (ext === "sh" || ext === "bash") return { label: "$", color: "text-green-400 font-bold" };
  return { label: "📄", color: "text-ink-400" };
}

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
  // ----- Hosts & Session State -----
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

  // Layout & Activity Bar
  type ActivityTab = "explorer" | "chat" | "git" | "terminal" | "machines" | "settings";
  const [activeActivityTab, setActiveActivityTab] = createSignal<ActivityTab>("explorer");
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [layoutMode, setLayoutMode] = createSignal<"split" | "editor" | "chat">("split");
  const [terminalOpen, setTerminalOpen] = createSignal(false);

  // File Explorer Tree
  const [fileTree, setFileTree] = createSignal<FileEntry[]>([]);
  const [fileTreeLoading, setFileTreeLoading] = createSignal(false);
  const [showNewFileModal, setShowNewFileModal] = createSignal(false);
  const [newFilePath, setNewFilePath] = createSignal("");

  // Editor Tabs
  const [openTabs, setOpenTabs] = createSignal<EditorTab[]>([]);
  const [activeTabPath, setActiveTabPath] = createSignal<string | null>(null);

  // Git State
  const [gitBranch, setGitBranch] = createSignal<string>("");
  const [gitFiles, setGitFiles] = createSignal<GitFileStatus[]>([]);
  const [gitLoading, setGitLoading] = createSignal(false);
  const [commitMessage, setCommitMessage] = createSignal("");

  // Terminal Runner
  const [terminalLogs, setTerminalLogs] = createSignal<TerminalLog[]>([]);
  const [terminalCmd, setTerminalCmd] = createSignal("");
  const [terminalHistory, setTerminalHistory] = createSignal<string[]>([]);
  const [historyIndex, setHistoryIndex] = createSignal(-1);

  // Zot Configuration Settings
  const [zotSettings, setZotSettings] = createSignal<ZotSettings>({
    model: "gpt-4o",
    reasoning: "medium",
    temperature: 0.7,
    auto_compact_threshold: 85,
    jail_by_default: false,
    tool_render: "box",
    compact_input: false,
    compact_mode: false,
    recursive_file_suggest: false,
    respect_gitignore: true,
    insecure: false,
    http_proxy: "",
  });

  // Slash Commands Auto-suggest Overlay
  const [showSlashPopup, setShowSlashPopup] = createSignal(false);
  const [slashFilter, setSlashFilter] = createSignal("");

  // Models
  const [models, setModels] = createSignal<Array<{ id: string; name: string }>>(DEFAULT_MODELS);
  const [selectedModel, setSelectedModel] = createSignal<string>("gpt-4o");

  // Modals
  const [showPairModal, setShowPairModal] = createSignal(false);
  const [pairData, setPairData] = createSignal<RemotePairDto | null>(null);
  const [pairLoading, setPairLoading] = createSignal(false);

  const [showNewSessionModal, setShowNewSessionModal] = createSignal(false);
  const [newCwd, setNewCwd] = createSignal("~");
  const [newTitle, setNewTitle] = createSignal("");
  const [newModel, setNewModel] = createSignal("gpt-4o");

  // WebSocket
  let ws: WebSocket | null = null;
  const [wsConnected, setWsConnected] = createSignal(false);
  let reconnectTimer: any = null;
  let chatScrollContainer: HTMLDivElement | undefined;
  let terminalScrollContainer: HTMLDivElement | undefined;
  let editorTextArea: HTMLTextAreaElement | undefined;

  // Active host & session memos
  const activeHost = createMemo(() => {
    const id = activeHostId();
    return hosts().find((h) => h.id === id) ?? null;
  });

  const activeSession = createMemo(() => {
    const id = activeSessionId();
    return sessions().find((s) => s.id === id) ?? null;
  });

  const activeTab = createMemo(() => {
    const p = activeTabPath();
    return openTabs().find((t) => t.path === p) ?? null;
  });

  // Filtered slash commands
  const filteredSlashCommands = createMemo(() => {
    const filter = slashFilter().toLowerCase();
    return SLASH_COMMANDS.filter((cmd) => cmd.name.toLowerCase().includes(filter));
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

  const scrollTerminalToBottom = () => {
    if (!terminalScrollContainer) return;
    terminalScrollContainer.scrollTo({
      top: terminalScrollContainer.scrollHeight,
      behavior: "smooth",
    });
  };

  // ----- API & WebSocket Handlers -----

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
        sendWs({ hostId: hId, type: "get_config" });
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
          sendWs({ hostId: msg.hostId, type: "get_config" });
        }
        break;
      }

      case "session_list":
      case "sessions_list": {
        if (msg.hostId === activeHostId() && Array.isArray(msg.sessions)) {
          setSessions(msg.sessions);
          localStorage.setItem(`llmgw_remote_sessions_${msg.hostId}`, JSON.stringify(msg.sessions));

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

      case "session_content": {
        if (msg.sessionId === activeSessionId()) {
          const norm = normalizeMessages(msg.messages ?? []);
          setMessages(norm);
          setSessionStatus("idle");
          localStorage.setItem(`llmgw_remote_transcript_${msg.sessionId}`, JSON.stringify(norm));
          setTimeout(() => scrollToBottom(true), 50);
        }
        break;
      }

      case "session_compacted": {
        if (msg.sessionId === activeSessionId()) {
          const norm = normalizeMessages(msg.messages ?? []);
          setMessages(norm);
          setSessionStatus("idle");
          toast("Transcript compacted successfully");
          setTimeout(() => scrollToBottom(true), 50);
        }
        break;
      }

      case "session_cleared": {
        if (msg.sessionId === activeSessionId()) {
          setMessages([]);
          setSessionStatus("idle");
          toast("Chat transcript cleared");
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

      case "dir_list": {
        if (msg.hostId === activeHostId()) {
          setFileTreeLoading(false);
          const entries: FileEntry[] = (msg.entries ?? []).map((e: any) => ({
            name: e.name,
            isDir: e.isDir,
            path: e.path,
            sizeBytes: e.sizeBytes,
            isOpen: false,
          }));

          const reqPath = msg.path;
          const currentCwd = activeSession()?.cwd || "~";

          if (reqPath === currentCwd || reqPath === fileTree()[0]?.path || !fileTree().length) {
            setFileTree(entries);
          } else {
            // Merge children recursively
            const updateNode = (nodes: FileEntry[]): FileEntry[] => {
              return nodes.map((node) => {
                if (node.path === reqPath) {
                  return { ...node, children: entries, isOpen: true, isLoading: false };
                }
                if (node.children) {
                  return { ...node, children: updateNode(node.children) };
                }
                return node;
              });
            };
            setFileTree(updateNode(fileTree()));
          }
        }
        break;
      }

      case "file_content": {
        if (msg.hostId === activeHostId()) {
          const targetPath = msg.path;
          if (msg.error) {
            toast(`Failed to read file: ${msg.error}`);
            setOpenTabs((prev) => prev.filter((t) => t.path !== targetPath));
            return;
          }
          setOpenTabs((prev) =>
            prev.map((tab) =>
              tab.path === targetPath
                ? {
                    ...tab,
                    content: msg.content ?? "",
                    savedContent: msg.content ?? "",
                    isLoading: false,
                    isDirty: false,
                  }
                : tab,
            ),
          );
        }
        break;
      }

      case "file_saved": {
        if (msg.hostId === activeHostId()) {
          const targetPath = msg.path;
          if (msg.error) {
            toast(`Failed to save file: ${msg.error}`);
            return;
          }
          setOpenTabs((prev) =>
            prev.map((tab) =>
              tab.path === targetPath
                ? {
                    ...tab,
                    savedContent: tab.content,
                    isDirty: false,
                  }
                : tab,
            ),
          );
          toast(`Saved ${targetPath.split("/").pop()}`);
          refreshGitStatus();
        }
        break;
      }

      case "git_status_result": {
        if (msg.hostId === activeHostId()) {
          setGitLoading(false);
          setGitBranch(msg.branch ?? "");
          setGitFiles(msg.files ?? []);
        }
        break;
      }

      case "command_result": {
        if (msg.hostId === activeHostId()) {
          const logItem: TerminalLog = {
            id: `cmd_${Date.now()}`,
            command: msg.requestId ? undefined : terminalCmd(),
            stdout: msg.stdout,
            stderr: msg.stderr,
            exitCode: msg.exitCode,
            timestamp: Date.now(),
          };
          setTerminalLogs((prev) => [...prev, logItem]);
          setTimeout(scrollTerminalToBottom, 50);
          refreshGitStatus();
        }
        break;
      }

      case "config_data":
      case "config_updated": {
        if (msg.hostId === activeHostId() && msg.settings) {
          setZotSettings(msg.settings);
          if (msg.type === "config_updated") {
            toast("Zot settings updated on host");
          }
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
        refreshGitStatus();
        refreshFileTree();
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
        refreshGitStatus();
        refreshFileTree();
        break;
      }
    }
  };

  // ----- Workspace Actions -----

  const selectHost = (hostId: string) => {
    setActiveHostId(hostId);
    setActiveSessionId(null);
    setMessages([]);
    setSessions([]);
    setOpenTabs([]);
    setActiveTabPath(null);
    setFileTree([]);

    try {
      const cached = localStorage.getItem(`llmgw_remote_sessions_${hostId}`);
      if (cached) setSessions(JSON.parse(cached));
    } catch {}

    sendWs({ hostId, type: "list_sessions" });
    sendWs({ hostId, type: "get_config" });
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

    // Refresh directory & git for this session's CWD
    refreshFileTree();
    refreshGitStatus();
  };

  const refreshFileTree = () => {
    const hId = activeHostId();
    const act = activeSession();
    if (!hId || !act) return;

    setFileTreeLoading(true);
    sendWs({
      hostId: hId,
      type: "list_dir",
      path: act.cwd,
    });
  };

  const toggleFolder = (node: FileEntry) => {
    const hId = activeHostId();
    if (!hId) return;

    if (node.isOpen) {
      // Close folder
      const updateNode = (nodes: FileEntry[]): FileEntry[] => {
        return nodes.map((n) => {
          if (n.path === node.path) return { ...n, isOpen: false };
          if (n.children) return { ...n, children: updateNode(n.children) };
          return n;
        });
      };
      setFileTree(updateNode(fileTree()));
    } else {
      // Open folder - if children loaded, just expand; otherwise fetch
      if (node.children) {
        const updateNode = (nodes: FileEntry[]): FileEntry[] => {
          return nodes.map((n) => {
            if (n.path === node.path) return { ...n, isOpen: true };
            if (n.children) return { ...n, children: updateNode(n.children) };
            return n;
          });
        };
        setFileTree(updateNode(fileTree()));
      } else {
        sendWs({
          hostId: hId,
          type: "list_dir",
          path: node.path,
        });
      }
    }
  };

  const openFileInEditor = (path: string, name: string) => {
    const existing = openTabs().find((t) => t.path === path);
    if (existing) {
      setActiveTabPath(path);
      return;
    }

    const newTab: EditorTab = {
      path,
      name,
      content: "",
      savedContent: "",
      isDirty: false,
      isLoading: true,
      viewMode: name.endsWith(".md") ? "code" : "code",
    };

    setOpenTabs((prev) => [...prev, newTab]);
    setActiveTabPath(path);

    const hId = activeHostId();
    if (hId) {
      sendWs({
        hostId: hId,
        type: "read_file",
        path,
      });
    }
  };

  const closeTab = (path: string, e?: MouseEvent) => {
    e?.stopPropagation();
    const tab = openTabs().find((t) => t.path === path);
    if (tab && tab.isDirty) {
      if (!confirm(`Save changes to ${tab.name} before closing?`)) {
        // close without saving
      } else {
        saveActiveFile();
      }
    }

    const remaining = openTabs().filter((t) => t.path !== path);
    setOpenTabs(remaining);

    if (activeTabPath() === path) {
      if (remaining.length > 0) {
        setActiveTabPath(remaining[remaining.length - 1]!.path);
      } else {
        setActiveTabPath(null);
      }
    }
  };

  const updateEditorContent = (val: string) => {
    const p = activeTabPath();
    if (!p) return;
    setOpenTabs((prev) =>
      prev.map((t) => {
        if (t.path === p) {
          return {
            ...t,
            content: val,
            isDirty: val !== t.savedContent,
          };
        }
        return t;
      }),
    );
  };

  const saveActiveFile = () => {
    const tab = activeTab();
    const hId = activeHostId();
    if (!tab || !hId) return;

    sendWs({
      hostId: hId,
      type: "write_file",
      path: tab.path,
      content: tab.content,
    });
  };

  const refreshGitStatus = () => {
    const hId = activeHostId();
    const act = activeSession();
    if (!hId || !act) return;

    setGitLoading(true);
    sendWs({
      hostId: hId,
      type: "git_status",
      cwd: act.cwd,
    });
  };

  const commitGitChanges = () => {
    const msg = commitMessage().trim();
    if (!msg) {
      toast("Please enter a commit message");
      return;
    }
    const hId = activeHostId();
    const act = activeSession();
    if (!hId || !act) return;

    const cmd = `git add -A && git commit -m "${msg.replace(/"/g, '\\"')}"`;
    executeTerminalCommand(cmd);
    setCommitMessage("");
  };

  const executeTerminalCommand = (rawCmd?: string) => {
    const cmd = (rawCmd ?? terminalCmd()).trim();
    if (!cmd) return;

    const hId = activeHostId();
    const act = activeSession();
    if (!hId || !act) return;

    setTerminalHistory((prev) => [cmd, ...prev.filter((c) => c !== cmd)]);
    setHistoryIndex(-1);

    const logItem: TerminalLog = {
      id: `cmd_${Date.now()}`,
      command: cmd,
      timestamp: Date.now(),
    };
    setTerminalLogs((prev) => [...prev, logItem]);
    setTerminalCmd("");
    setTerminalOpen(true);

    sendWs({
      hostId: hId,
      type: "exec_command",
      command: cmd,
      cwd: act.cwd,
    });
  };

  const saveZotSettings = () => {
    const hId = activeHostId();
    if (!hId) return;

    sendWs({
      hostId: hId,
      type: "update_config",
      settings: zotSettings(),
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
    setShowSlashPopup(false);
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
    if (!confirm("Are you sure you want to remove this host machine?")) return;
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
    setNewCwd(act ? act.cwd : "~");
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

  // Keyboard shortcut listener: Cmd+S / Ctrl+S to save file
  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      saveActiveFile();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "b") {
      e.preventDefault();
      setSidebarOpen(!sidebarOpen());
    } else if ((e.metaKey || e.ctrlKey) && e.key === "`") {
      e.preventDefault();
      setTerminalOpen(!terminalOpen());
    }
  };

  // Chat Prompt input listener for slash commands
  const handlePromptInput = (e: InputEvent & { currentTarget: HTMLTextAreaElement }) => {
    const val = e.currentTarget.value;
    setPromptInput(val);
    if (val.startsWith("/")) {
      setShowSlashPopup(true);
      setSlashFilter(val);
    } else {
      setShowSlashPopup(false);
    }
  };

  const handleComposerKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (sessionStatus() === "running") return;
      sendPrompt();
    } else if (e.key === "Escape") {
      setShowSlashPopup(false);
    }
  };

  onMount(() => {
    window.addEventListener("keydown", handleKeyDown);
    fetchHosts();
    fetchModels();
    connectWebSocket();
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleKeyDown);
    clearTimeout(reconnectTimer);
    if (ws) {
      try {
        ws.close();
      } catch {}
    }
  });

  return (
    <div class="h-[calc(100vh-110px)] flex flex-col min-h-[600px] -my-4 sm:-my-6 lg:-my-8 bg-ink-950 rounded-2xl border border-line overflow-hidden select-none font-sans text-xs">
      {/* ===== TOP TITLE & TOOLBAR BAR ===== */}
      <header class="h-10 border-b border-line bg-ink-900/90 px-3 flex items-center justify-between gap-3 shrink-0">
        <div class="flex items-center gap-3 min-w-0">
          <div class="flex items-center gap-2">
            <span class="inline-flex h-2 w-2 rounded-full bg-brand-500 animate-pulse" />
            <span class="font-bold text-ink-100 tracking-tight text-[13px]">Remote IDE</span>
          </div>

          <Show when={activeHost()}>
            {(host) => (
              <div class="hidden sm:flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-line bg-ink-850/80 text-[11px]">
                <span class={`h-1.5 w-1.5 rounded-full ${host().status === "online" ? "bg-emerald-500" : "bg-ink-600"}`} />
                <span class="font-medium text-ink-200">{host().name}</span>
                <span class="text-ink-500 font-mono">({host().os}/{host().arch})</span>
              </div>
            )}
          </Show>

          <Show when={activeSession()}>
            {(sess) => (
              <div class="hidden md:flex items-center gap-1.5 text-[11px] text-ink-400 font-mono truncate max-w-xs">
                <Icon name={Icons.folder} size={12} class="text-brand-400" />
                <span class="truncate">{sess().cwd}</span>
              </div>
            )}
          </Show>
        </div>

        {/* Right Toolbar Controls */}
        <div class="flex items-center gap-1.5">
          {/* Layout Switcher */}
          <div class="hidden sm:flex items-center rounded-lg border border-line bg-ink-950 p-0.5">
            <button
              onClick={() => setLayoutMode("editor")}
              class={`px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                layoutMode() === "editor" ? "bg-elev text-ink-100 shadow-sm" : "text-ink-400 hover:text-ink-200"
              }`}
              title="Editor Only"
            >
              Editor
            </button>
            <button
              onClick={() => setLayoutMode("split")}
              class={`px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                layoutMode() === "split" ? "bg-elev text-ink-100 shadow-sm" : "text-ink-400 hover:text-ink-200"
              }`}
              title="Split View (Editor + Agent Chat)"
            >
              Split
            </button>
            <button
              onClick={() => setLayoutMode("chat")}
              class={`px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                layoutMode() === "chat" ? "bg-elev text-ink-100 shadow-sm" : "text-ink-400 hover:text-ink-200"
              }`}
              title="Agent Chat Only"
            >
              Chat
            </button>
          </div>

          {/* Terminal Toggle Button */}
          <button
            onClick={() => setTerminalOpen(!terminalOpen())}
            class={`flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11px] font-medium transition-colors cursor-pointer ${
              terminalOpen()
                ? "border-brand-500/50 bg-brand-500/10 text-brand-400"
                : "border-line bg-ink-850 hover:bg-elev text-ink-300"
            }`}
            title="Toggle Remote Terminal (Cmd+`)"
          >
            <Icon name={Icons.terminal} size={12} />
            <span class="hidden md:inline">Terminal</span>
          </button>

          {/* YOLO Mode Toggle */}
          <button
            onClick={() => setYolo(!yolo())}
            class={`flex items-center gap-1 px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition-colors cursor-pointer ${
              yolo()
                ? "border-brand-500/40 bg-brand-500/10 text-brand-400"
                : "border-amber-500/40 bg-amber-500/10 text-amber-400"
            }`}
            title={yolo() ? "YOLO Mode Active: Tools run automatically" : "Safe Mode: Interactive approval required"}
          >
            <Icon name={Icons.shield} size={12} />
            <span>{yolo() ? "YOLO" : "Safe"}</span>
          </button>

          {/* Connect Machine */}
          <button
            onClick={startPairing}
            class="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-line bg-ink-850 hover:bg-elev text-ink-200 text-[11px] font-medium transition-colors cursor-pointer"
          >
            <Icon name={Icons.plus} size={12} />
            <span>Connect</span>
          </button>
        </div>
      </header>

      {/* ===== WORKSPACE BODY ===== */}
      <div class="flex-1 flex min-h-0 relative">
        {/* ===== ACTIVITY BAR (VS Code far-left 44px bar) ===== */}
        <aside class="w-11 bg-ink-950 border-r border-line flex flex-col items-center py-2 justify-between shrink-0 z-10">
          <div class="flex flex-col items-center gap-2">
            {/* Explorer icon */}
            <button
              onClick={() => {
                if (activeActivityTab() === "explorer" && sidebarOpen()) {
                  setSidebarOpen(false);
                } else {
                  setActiveActivityTab("explorer");
                  setSidebarOpen(true);
                }
              }}
              class={`p-2 rounded-xl transition-colors cursor-pointer relative ${
                activeActivityTab() === "explorer" && sidebarOpen()
                  ? "bg-brand-500/20 text-brand-400 border border-brand-500/30"
                  : "text-ink-400 hover:text-ink-100 hover:bg-ink-900"
              }`}
              title="File Explorer (Cmd+B)"
            >
              <Icon name={Icons.folder} size={16} />
            </button>

            {/* Agent Chat icon */}
            <button
              onClick={() => {
                if (activeActivityTab() === "chat" && sidebarOpen()) {
                  setSidebarOpen(false);
                } else {
                  setActiveActivityTab("chat");
                  setSidebarOpen(true);
                }
              }}
              class={`p-2 rounded-xl transition-colors cursor-pointer relative ${
                activeActivityTab() === "chat" && sidebarOpen()
                  ? "bg-brand-500/20 text-brand-400 border border-brand-500/30"
                  : "text-ink-400 hover:text-ink-100 hover:bg-ink-900"
              }`}
              title="Agent Sessions"
            >
              <Icon name={Icons.sparkles} size={16} />
              <Show when={sessionStatus() === "running"}>
                <span class="absolute top-1 right-1 h-2 w-2 rounded-full bg-brand-500 animate-ping" />
              </Show>
            </button>

            {/* Git Source Control icon */}
            <button
              onClick={() => {
                if (activeActivityTab() === "git" && sidebarOpen()) {
                  setSidebarOpen(false);
                } else {
                  setActiveActivityTab("git");
                  setSidebarOpen(true);
                  refreshGitStatus();
                }
              }}
              class={`p-2 rounded-xl transition-colors cursor-pointer relative ${
                activeActivityTab() === "git" && sidebarOpen()
                  ? "bg-brand-500/20 text-brand-400 border border-brand-500/30"
                  : "text-ink-400 hover:text-ink-100 hover:bg-ink-900"
              }`}
              title="Source Control (Git)"
            >
              <Icon name={Icons.git} size={16} />
              <Show when={gitFiles().length > 0}>
                <span class="absolute -top-0.5 -right-0.5 px-1 min-w-3.5 h-3.5 rounded-full bg-amber-500 text-ink-950 font-bold text-[9px] flex items-center justify-center">
                  {gitFiles().length}
                </span>
              </Show>
            </button>

            {/* Terminal Runner icon */}
            <button
              onClick={() => {
                if (activeActivityTab() === "terminal" && sidebarOpen()) {
                  setSidebarOpen(false);
                } else {
                  setActiveActivityTab("terminal");
                  setSidebarOpen(true);
                  setTerminalOpen(true);
                }
              }}
              class={`p-2 rounded-xl transition-colors cursor-pointer relative ${
                activeActivityTab() === "terminal" && sidebarOpen()
                  ? "bg-brand-500/20 text-brand-400 border border-brand-500/30"
                  : "text-ink-400 hover:text-ink-100 hover:bg-ink-900"
              }`}
              title="Terminal Command Runner"
            >
              <Icon name={Icons.terminal} size={16} />
            </button>

            {/* Machines icon */}
            <button
              onClick={() => {
                if (activeActivityTab() === "machines" && sidebarOpen()) {
                  setSidebarOpen(false);
                } else {
                  setActiveActivityTab("machines");
                  setSidebarOpen(true);
                }
              }}
              class={`p-2 rounded-xl transition-colors cursor-pointer relative ${
                activeActivityTab() === "machines" && sidebarOpen()
                  ? "bg-brand-500/20 text-brand-400 border border-brand-500/30"
                  : "text-ink-400 hover:text-ink-100 hover:bg-ink-900"
              }`}
              title="Connected Machines"
            >
              <Icon name={Icons.server} size={16} />
            </button>
          </div>

          {/* Bottom Activity Bar Controls */}
          <div class="flex flex-col items-center gap-2">
            {/* Zot Settings icon */}
            <button
              onClick={() => {
                if (activeActivityTab() === "settings" && sidebarOpen()) {
                  setSidebarOpen(false);
                } else {
                  setActiveActivityTab("settings");
                  setSidebarOpen(true);
                }
              }}
              class={`p-2 rounded-xl transition-colors cursor-pointer ${
                activeActivityTab() === "settings" && sidebarOpen()
                  ? "bg-brand-500/20 text-brand-400 border border-brand-500/30"
                  : "text-ink-400 hover:text-ink-100 hover:bg-ink-900"
              }`}
              title="Zot Settings & Parameters"
            >
              <Icon name={Icons.cog} size={16} />
            </button>
          </div>
        </aside>

        {/* ===== PRIMARY SIDEBAR (collapsible ~260px) ===== */}
        <Show when={sidebarOpen()}>
          <aside class="w-64 sm:w-72 bg-ink-900 border-r border-line flex flex-col shrink-0 z-10 transition-all duration-150">
            {/* Sidebar View: File Explorer */}
            <Show when={activeActivityTab() === "explorer"}>
              <div class="p-2.5 border-b border-line flex items-center justify-between">
                <span class="font-bold uppercase tracking-wider text-[11px] text-ink-300">Explorer</span>
                <div class="flex items-center gap-1">
                  <button
                    onClick={refreshFileTree}
                    class="p-1 rounded hover:bg-ink-800 text-ink-400 hover:text-ink-100 transition-colors cursor-pointer"
                    title="Refresh Explorer"
                  >
                    <Icon name={Icons.refresh} size={13} />
                  </button>
                  <button
                    onClick={() => {
                      setNewFilePath("");
                      setShowNewFileModal(true);
                    }}
                    class="p-1 rounded hover:bg-ink-800 text-ink-400 hover:text-ink-100 transition-colors cursor-pointer"
                    title="New File"
                  >
                    <Icon name={Icons.plus} size={13} />
                  </button>
                </div>
              </div>

              {/* Explorer Tree */}
              <div class="flex-1 overflow-y-auto p-1.5 space-y-0.5 select-none font-mono text-[12px]">
                <Show
                  when={fileTree().length > 0}
                  fallback={
                    <div class="p-4 text-center text-ink-500 font-sans text-xs">
                      {fileTreeLoading() ? "Loading files..." : "No files loaded. Connect a host to browse."}
                    </div>
                  }
                >
                  <For each={fileTree()}>
                    {(node) => <FileTreeNode node={node} onToggle={toggleFolder} onOpenFile={openFileInEditor} />}
                  </For>
                </Show>
              </div>
            </Show>

            {/* Sidebar View: Agent Sessions */}
            <Show when={activeActivityTab() === "chat"}>
              <div class="p-2.5 border-b border-line flex items-center justify-between">
                <span class="font-bold uppercase tracking-wider text-[11px] text-ink-300">Sessions</span>
                <button
                  onClick={openNewSessionModal}
                  class="flex items-center gap-1 text-[11px] font-semibold text-brand-400 hover:text-brand-300 cursor-pointer"
                >
                  <Icon name={Icons.plus} size={12} />
                  <span>New</span>
                </button>
              </div>

              <div class="flex-1 overflow-y-auto p-2 space-y-1.5">
                <For each={sessions()}>
                  {(sess) => {
                    const isActive = () => sess.id === activeSessionId();
                    return (
                      <div
                        onClick={() => selectSession(sess.id)}
                        class={`group p-2.5 rounded-xl border transition-all cursor-pointer ${
                          isActive()
                            ? "border-brand-500/50 bg-brand-500/10 text-ink-100"
                            : "border-transparent hover:border-line hover:bg-ink-850 text-ink-300"
                        }`}
                      >
                        <div class="flex items-center justify-between mb-1">
                          <span class="font-semibold text-ink-100 truncate text-xs">{sess.title || "Untitled Session"}</span>
                          <Show when={sess.status === "running"}>
                            <span class="h-2 w-2 rounded-full bg-brand-500 animate-ping" />
                          </Show>
                        </div>
                        <div class="flex items-center gap-1 text-[11px] text-ink-500 font-mono truncate">
                          <Icon name={Icons.folder} size={11} />
                          <span class="truncate">{sess.cwd}</span>
                        </div>
                        <div class="flex items-center justify-between text-[10px] text-ink-500 mt-1.5 pt-1 border-t border-line/40">
                          <span>{fmtDate(sess.updatedAt)}</span>
                          <button
                            onClick={(e) => deleteSession(sess.id, e)}
                            class="opacity-0 group-hover:opacity-100 hover:text-rose-400 p-0.5 transition-opacity"
                            title="Delete session"
                          >
                            <Icon name={Icons.trash} size={12} />
                          </button>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>

            {/* Sidebar View: Source Control (Git) */}
            <Show when={activeActivityTab() === "git"}>
              <div class="p-2.5 border-b border-line flex items-center justify-between">
                <div class="flex items-center gap-1.5 text-xs font-semibold text-ink-200">
                  <Icon name={Icons.git} size={14} class="text-brand-400" />
                  <span>{gitBranch() || "Source Control"}</span>
                </div>
                <button
                  onClick={refreshGitStatus}
                  class="p-1 rounded hover:bg-ink-800 text-ink-400 hover:text-ink-100 transition-colors cursor-pointer"
                  title="Refresh Git Status"
                >
                  <Icon name={Icons.refresh} size={13} />
                </button>
              </div>

              <div class="p-3 space-y-3 flex-1 overflow-y-auto">
                {/* Commit Form */}
                <div class="space-y-2">
                  <textarea
                    value={commitMessage()}
                    onInput={(e) => setCommitMessage(e.currentTarget.value)}
                    placeholder="Message (Cmd+Enter to commit)"
                    rows={2}
                    class="w-full rounded-xl border border-line bg-ink-950 p-2 text-xs text-ink-100 placeholder-ink-500 outline-none focus:border-brand-500 resize-none leading-relaxed"
                  />
                  <div class="flex gap-1.5">
                    <button
                      onClick={commitGitChanges}
                      class="flex-1 py-1.5 rounded-lg bg-brand-500 hover:bg-brand-600 text-white font-semibold text-xs flex items-center justify-center gap-1 transition-colors cursor-pointer shadow-sm"
                    >
                      <Icon name={Icons.check} size={13} />
                      <span>Commit</span>
                    </button>
                    <button
                      onClick={() => executeTerminalCommand("git push")}
                      class="px-2.5 py-1.5 rounded-lg border border-line bg-ink-850 hover:bg-elev text-ink-200 font-medium text-xs transition-colors cursor-pointer"
                      title="Push Commits"
                    >
                      Push
                    </button>
                  </div>
                </div>

                {/* Changes list */}
                <div>
                  <div class="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-ink-400 mb-1">
                    <span>Changes ({gitFiles().length})</span>
                  </div>

                  <Show
                    when={gitFiles().length > 0}
                    fallback={
                      <div class="text-[11px] text-ink-500 py-3 text-center">
                        Working directory clean
                      </div>
                    }
                  >
                    <div class="space-y-1">
                      <For each={gitFiles()}>
                        {(file) => (
                          <div
                            onClick={() => {
                              const act = activeSession();
                              const fullPath = act ? `${act.cwd}/${file.path}` : file.path;
                              openFileInEditor(fullPath, file.path.split("/").pop() || file.path);
                            }}
                            class="flex items-center justify-between p-1.5 rounded-lg hover:bg-ink-850 text-[11px] font-mono cursor-pointer group"
                          >
                            <span class="truncate text-ink-200 group-hover:text-ink-100">{file.path}</span>
                            <span
                              class={`px-1.5 py-0.2 rounded font-bold text-[10px] ${
                                file.status === "M"
                                  ? "text-amber-400 bg-amber-400/10"
                                  : file.status === "A"
                                  ? "text-emerald-400 bg-emerald-400/10"
                                  : file.status === "D"
                                  ? "text-rose-400 bg-rose-400/10"
                                  : "text-blue-400 bg-blue-400/10"
                              }`}
                            >
                              {file.status}
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </div>
            </Show>

            {/* Sidebar View: Terminal Command Runner */}
            <Show when={activeActivityTab() === "terminal"}>
              <div class="p-2.5 border-b border-line flex items-center justify-between">
                <span class="font-bold uppercase tracking-wider text-[11px] text-ink-300">Quick Commands</span>
              </div>

              <div class="p-3 space-y-2 flex-1 overflow-y-auto">
                <p class="text-[11px] text-ink-400 leading-relaxed">
                  Run bash commands directly in the session root (<span class="font-mono text-ink-200">{activeSession()?.cwd || "~"}</span>):
                </p>

                <div class="space-y-1.5 pt-1">
                  {[
                    { label: "Git Status", cmd: "git status" },
                    { label: "Run Tests", cmd: "bun test || npm test" },
                    { label: "List Files (Long)", cmd: "ls -lah" },
                    { label: "Git Log (Graph)", cmd: "git log --oneline -n 5" },
                    { label: "Disk & Memory", cmd: "df -h . && free -m 2>/dev/null || true" },
                  ].map((item) => (
                    <button
                      onClick={() => executeTerminalCommand(item.cmd)}
                      class="w-full flex items-center justify-between p-2 rounded-xl border border-line bg-ink-850 hover:bg-elev hover:border-brand-500/40 text-left transition-colors cursor-pointer"
                    >
                      <span class="font-medium text-xs text-ink-200">{item.label}</span>
                      <span class="font-mono text-[10px] text-ink-500">{item.cmd}</span>
                    </button>
                  ))}
                </div>
              </div>
            </Show>

            {/* Sidebar View: Machines */}
            <Show when={activeActivityTab() === "machines"}>
              <div class="p-2.5 border-b border-line flex items-center justify-between">
                <span class="font-bold uppercase tracking-wider text-[11px] text-ink-300">Host Machines</span>
                <button
                  onClick={startPairing}
                  class="flex items-center gap-1 text-[11px] font-semibold text-brand-400 hover:text-brand-300 cursor-pointer"
                >
                  <Icon name={Icons.plus} size={12} />
                  <span>Connect</span>
                </button>
              </div>

              <div class="p-2 space-y-1.5 flex-1 overflow-y-auto">
                <For each={hosts()}>
                  {(h) => {
                    const isSelected = () => h.id === activeHostId();
                    return (
                      <div
                        onClick={() => selectHost(h.id)}
                        class={`p-2.5 rounded-xl border transition-all cursor-pointer ${
                          isSelected()
                            ? "border-brand-500/50 bg-brand-500/10 text-ink-100"
                            : "border-transparent hover:border-line hover:bg-ink-850 text-ink-300"
                        }`}
                      >
                        <div class="flex items-center justify-between">
                          <span class="font-semibold text-xs text-ink-100">{h.name}</span>
                          <span class={`h-2 w-2 rounded-full ${h.status === "online" ? "bg-emerald-500" : "bg-ink-600"}`} />
                        </div>
                        <div class="text-[11px] text-ink-500 font-mono mt-0.5">
                          {h.hostname} ({h.os}/{h.arch})
                        </div>
                        <div class="flex items-center justify-between mt-2 pt-1 border-t border-line/40 text-[10px] text-ink-500">
                          <span>{h.status === "online" ? "Online" : "Offline"}</span>
                          <button
                            onClick={(e) => deleteHost(h.id, e)}
                            class="hover:text-rose-400 p-0.5 transition-colors"
                            title="Remove machine"
                          >
                            <Icon name={Icons.trash} size={12} />
                          </button>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>

            {/* Sidebar View: Zot Settings Configuration */}
            <Show when={activeActivityTab() === "settings"}>
              <div class="p-2.5 border-b border-line flex items-center justify-between">
                <span class="font-bold uppercase tracking-wider text-[11px] text-ink-300">Zot Settings</span>
                <button
                  onClick={saveZotSettings}
                  class="flex items-center gap-1 text-[11px] font-semibold text-brand-400 hover:text-brand-300 cursor-pointer"
                >
                  <Icon name={Icons.save} size={12} />
                  <span>Save</span>
                </button>
              </div>

              <div class="p-3 space-y-3.5 flex-1 overflow-y-auto text-xs">
                {/* Reasoning Level */}
                <div>
                  <label class="block font-semibold text-ink-300 mb-1">Reasoning Level</label>
                  <select
                    value={zotSettings().reasoning || "medium"}
                    onChange={(e) =>
                      setZotSettings((prev) => ({ ...prev, reasoning: e.currentTarget.value }))
                    }
                    class="w-full rounded-lg border border-line bg-ink-950 px-2.5 py-1.5 text-ink-100 outline-none focus:border-brand-500 cursor-pointer"
                  >
                    <option value="off">Off</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </div>

                {/* Auto-compact threshold */}
                <div>
                  <label class="block font-semibold text-ink-300 mb-1">
                    Auto-Compact Threshold ({zotSettings().auto_compact_threshold || 85}%)
                  </label>
                  <select
                    value={String(zotSettings().auto_compact_threshold ?? 85)}
                    onChange={(e) =>
                      setZotSettings((prev) => ({
                        ...prev,
                        auto_compact_threshold: parseInt(e.currentTarget.value, 10),
                      }))
                    }
                    class="w-full rounded-lg border border-line bg-ink-950 px-2.5 py-1.5 text-ink-100 outline-none focus:border-brand-500 cursor-pointer"
                  >
                    <option value="0">Off</option>
                    <option value="70">70%</option>
                    <option value="80">80%</option>
                    <option value="85">85% (Default)</option>
                    <option value="90">90%</option>
                  </select>
                </div>

                {/* Jail By Default */}
                <div class="flex items-center justify-between">
                  <div>
                    <div class="font-semibold text-ink-200">Jail Tools to CWD</div>
                    <div class="text-[10px] text-ink-500">Confine file edits to session dir</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={zotSettings().jail_by_default || false}
                    onChange={(e) =>
                      setZotSettings((prev) => ({
                        ...prev,
                        jail_by_default: e.currentTarget.checked,
                      }))
                    }
                    class="h-4 w-4 rounded accent-brand-500 cursor-pointer"
                  />
                </div>

                {/* Tool Render */}
                <div>
                  <label class="block font-semibold text-ink-300 mb-1">Tool Rendering</label>
                  <select
                    value={zotSettings().tool_render || "box"}
                    onChange={(e) =>
                      setZotSettings((prev) => ({ ...prev, tool_render: e.currentTarget.value }))
                    }
                    class="w-full rounded-lg border border-line bg-ink-950 px-2.5 py-1.5 text-ink-100 outline-none focus:border-brand-500 cursor-pointer"
                  >
                    <option value="box">Boxed Panels</option>
                    <option value="flat">Flat Quiet Headers</option>
                  </select>
                </div>

                {/* Respect .gitignore */}
                <div class="flex items-center justify-between">
                  <div>
                    <div class="font-semibold text-ink-200">Respect .gitignore</div>
                    <div class="text-[10px] text-ink-500">Hide ignored files in glob/tools</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={zotSettings().respect_gitignore !== false}
                    onChange={(e) =>
                      setZotSettings((prev) => ({
                        ...prev,
                        respect_gitignore: e.currentTarget.checked,
                      }))
                    }
                    class="h-4 w-4 rounded accent-brand-500 cursor-pointer"
                  />
                </div>

                {/* Recursive File Suggest */}
                <div class="flex items-center justify-between">
                  <div>
                    <div class="font-semibold text-ink-200">Recursive File Suggest</div>
                    <div class="text-[10px] text-ink-500">Fuzzy search whole project tree</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={zotSettings().recursive_file_suggest || false}
                    onChange={(e) =>
                      setZotSettings((prev) => ({
                        ...prev,
                        recursive_file_suggest: e.currentTarget.checked,
                      }))
                    }
                    class="h-4 w-4 rounded accent-brand-500 cursor-pointer"
                  />
                </div>

                {/* Insecure TLS */}
                <div class="flex items-center justify-between">
                  <div>
                    <div class="font-semibold text-ink-200">Skip TLS Verification</div>
                    <div class="text-[10px] text-ink-500">Insecure inference endpoints</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={zotSettings().insecure || false}
                    onChange={(e) =>
                      setZotSettings((prev) => ({
                        ...prev,
                        insecure: e.currentTarget.checked,
                      }))
                    }
                    class="h-4 w-4 rounded accent-brand-500 cursor-pointer"
                  />
                </div>

                <Btn variant="primary" size="sm" class="w-full mt-2" onClick={saveZotSettings}>
                  <Icon name={Icons.check} size={14} />
                  <span>Sync Settings to Daemon</span>
                </Btn>
              </div>
            </Show>
          </aside>
        </Show>

        {/* ===== MAIN SPLIT CANVAS (Editor + Chat + Bottom Terminal) ===== */}
        <div class="flex-1 flex flex-col min-w-0 bg-ink-950">
          <div class="flex-1 flex min-h-0">
            {/* ----- LEFT: MULTI-FILE CODE EDITOR PANE ----- */}
            <Show when={layoutMode() !== "chat"}>
              <div
                class={`flex flex-col border-r border-line bg-ink-950 ${
                  layoutMode() === "editor" ? "w-full" : "w-1/2 md:w-3/5"
                }`}
              >
                {/* Editor Tab Bar */}
                <div class="h-9 border-b border-line bg-ink-900/90 flex items-center overflow-x-auto shrink-0 scrollbar-none px-1">
                  <Show
                    when={openTabs().length > 0}
                    fallback={
                      <span class="text-[11px] text-ink-500 px-3 select-none">No files open</span>
                    }
                  >
                    <For each={openTabs()}>
                      {(tab) => {
                        const isActive = () => tab.path === activeTabPath();
                        const { label, color } = getFileIcon(tab.name);
                        return (
                          <div
                            onClick={() => setActiveTabPath(tab.path)}
                            class={`group flex items-center gap-2 px-3 h-full border-r border-line/60 text-xs font-mono transition-colors cursor-pointer select-none ${
                              isActive()
                                ? "bg-ink-950 text-ink-100 border-t-2 border-t-brand-500 font-semibold"
                                : "text-ink-400 hover:bg-ink-850 hover:text-ink-200"
                            }`}
                          >
                            <span class={`text-[10px] ${color}`}>{label}</span>
                            <span class="truncate max-w-[140px]">{tab.name}</span>
                            <Show when={tab.isDirty}>
                              <span class="h-1.5 w-1.5 rounded-full bg-brand-400" title="Unsaved changes" />
                            </Show>
                            <button
                              onClick={(e) => closeTab(tab.path, e)}
                              class="opacity-0 group-hover:opacity-100 hover:text-rose-400 p-0.5 rounded transition-opacity"
                              title="Close tab"
                            >
                              <Icon name={Icons.x} size={11} />
                            </button>
                          </div>
                        );
                      }}
                    </For>
                  </Show>
                </div>

                {/* Editor Subheader Toolbar */}
                <Show when={activeTab()}>
                  {(tab) => (
                    <div class="h-7 border-b border-line/60 bg-ink-900/40 px-3 flex items-center justify-between text-[11px] text-ink-400">
                      <div class="font-mono truncate max-w-sm flex items-center gap-1.5">
                        <span class="text-ink-500">Path:</span>
                        <span class="text-ink-200 truncate">{tab().path}</span>
                      </div>

                      <div class="flex items-center gap-2">
                        <Show when={tab().name.endsWith(".md")}>
                          <div class="flex items-center rounded border border-line bg-ink-950 p-0.5">
                            <button
                              onClick={() => {
                                setOpenTabs((prev) =>
                                  prev.map((t) => (t.path === tab().path ? { ...t, viewMode: "code" } : t)),
                                );
                              }}
                              class={`px-1.5 py-0.5 rounded text-[10px] ${
                                tab().viewMode === "code" ? "bg-elev text-ink-100" : "text-ink-500 hover:text-ink-200"
                              }`}
                            >
                              Code
                            </button>
                            <button
                              onClick={() => {
                                setOpenTabs((prev) =>
                                  prev.map((t) => (t.path === tab().path ? { ...t, viewMode: "preview" } : t)),
                                );
                              }}
                              class={`px-1.5 py-0.5 rounded text-[10px] ${
                                tab().viewMode === "preview" ? "bg-elev text-ink-100" : "text-ink-500 hover:text-ink-200"
                              }`}
                            >
                              Preview
                            </button>
                          </div>
                        </Show>

                        <button
                          onClick={saveActiveFile}
                          disabled={!tab().isDirty}
                          class={`flex items-center gap-1 px-2 py-0.5 rounded font-medium transition-colors cursor-pointer ${
                            tab().isDirty
                              ? "bg-brand-500 text-white hover:bg-brand-600 shadow-sm"
                              : "text-ink-500 hover:text-ink-300 disabled:opacity-40"
                          }`}
                          title="Save file (Cmd+S / Ctrl+S)"
                        >
                          <Icon name={Icons.save} size={11} />
                          <span>Save</span>
                        </button>
                      </div>
                    </div>
                  )}
                </Show>

                {/* Editor Content Canvas */}
                <div class="flex-1 flex min-h-0 relative overflow-hidden bg-ink-950">
                  <Show
                    when={activeTab()}
                    fallback={
                      <div class="flex-1 flex flex-col items-center justify-center text-center p-6 text-ink-500 space-y-3">
                        <div class="w-12 h-12 rounded-2xl bg-ink-900 border border-line flex items-center justify-center text-ink-400">
                          <Icon name={Icons.folder} size={24} />
                        </div>
                        <div class="max-w-xs space-y-1">
                          <div class="font-semibold text-ink-200 text-xs">No File Opened</div>
                          <p class="text-[11px] text-ink-400">
                            Select a file from the explorer on the left, or tell the agent to create one.
                          </p>
                        </div>
                      </div>
                    }
                  >
                    {(tab) => (
                      <Show
                        when={tab().viewMode === "preview"}
                        fallback={
                          <div class="flex-1 flex min-h-0 font-mono text-xs">
                            {/* Line Numbers Gutter */}
                            <div class="w-10 bg-ink-900/60 border-r border-line/40 py-3 text-right pr-2 text-ink-600 select-none overflow-hidden shrink-0">
                              <For each={tab().content.split("\n")}>
                                {(_, i) => <div class="leading-relaxed h-[20px]">{i() + 1}</div>}
                              </For>
                            </div>

                            {/* Textarea Editor with auto tab indents */}
                            <textarea
                              ref={editorTextArea}
                              value={tab().content}
                              onInput={(e) => updateEditorContent(e.currentTarget.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Tab") {
                                  e.preventDefault();
                                  const start = e.currentTarget.selectionStart;
                                  const end = e.currentTarget.selectionEnd;
                                  const val = e.currentTarget.value;
                                  const newVal = val.substring(0, start) + "  " + val.substring(end);
                                  updateEditorContent(newVal);
                                  setTimeout(() => {
                                    if (editorTextArea) {
                                      editorTextArea.selectionStart = editorTextArea.selectionEnd = start + 2;
                                    }
                                  }, 0);
                                }
                              }}
                              spellcheck={false}
                              class="flex-1 p-3 bg-transparent text-ink-100 outline-none leading-relaxed resize-none font-mono whitespace-pre overflow-auto scrollbar-thin"
                            />
                          </div>
                        }
                      >
                        {/* Markdown Preview Canvas */}
                        <div
                          class="flex-1 p-6 overflow-y-auto prose prose-invert max-w-none text-xs leading-relaxed"
                          innerHTML={renderMarkdown(tab().content)}
                        />
                      </Show>
                    )}
                  </Show>
                </div>
              </div>
            </Show>

            {/* ----- RIGHT: AGENT CHAT ASSISTANT PANE ----- */}
            <Show when={layoutMode() !== "editor"}>
              <div
                class={`flex flex-col bg-ink-900/60 min-w-0 ${
                  layoutMode() === "chat" ? "w-full" : "w-1/2 md:w-2/5"
                }`}
              >
                {/* Chat Header */}
                <div class="h-9 border-b border-line bg-ink-900/90 px-3 flex items-center justify-between gap-2 shrink-0">
                  <div class="flex items-center gap-2 min-w-0">
                    <Icon name={Icons.sparkles} size={14} class="text-brand-400 shrink-0" />
                    <span class="font-bold text-ink-100 text-xs truncate">
                      {activeSession()?.title || "Agent Assistant"}
                    </span>
                    <Show when={sessionStatus() === "running"}>
                      <span class="px-1.5 py-0.5 rounded-full bg-brand-500/20 text-brand-400 font-semibold text-[10px] animate-pulse">
                        Working...
                      </span>
                    </Show>
                  </div>

                  <div class="flex items-center gap-2">
                    {/* Model Picker */}
                    <select
                      value={selectedModel()}
                      onChange={(e) => setSelectedModel(e.currentTarget.value)}
                      class="rounded-lg border border-line bg-ink-950 px-2 py-0.5 text-[11px] text-ink-200 outline-none focus:border-brand-500 cursor-pointer"
                    >
                      <For each={models()}>
                        {(m) => <option value={m.id}>{m.name}</option>}
                      </For>
                    </select>

                    {/* Slash action shortcuts */}
                    <button
                      onClick={() => {
                        setPromptInput("/compact");
                        sendPrompt();
                      }}
                      class="p-1 rounded text-ink-400 hover:text-ink-100 hover:bg-ink-800 transition-colors cursor-pointer"
                      title="Compact transcript to free context (/compact)"
                    >
                      <Icon name={Icons.layers} size={13} />
                    </button>

                    <button
                      onClick={() => {
                        setPromptInput("/clear");
                        sendPrompt();
                      }}
                      class="p-1 rounded text-ink-400 hover:text-ink-100 hover:bg-ink-800 transition-colors cursor-pointer"
                      title="Clear chat transcript (/clear)"
                    >
                      <Icon name={Icons.trash} size={13} />
                    </button>

                    {/* Stop Button */}
                    <Show when={sessionStatus() === "running"}>
                      <button
                        onClick={cancelTurn}
                        class="flex items-center gap-1 rounded bg-rose-500/20 text-rose-400 border border-rose-500/40 px-2 py-0.5 text-[11px] font-semibold hover:bg-rose-500/30 transition-colors cursor-pointer"
                      >
                        <Icon name={Icons.stop} size={11} />
                        <span>Stop</span>
                      </button>
                    </Show>
                  </div>
                </div>

                {/* Chat Timeline */}
                <div
                  ref={chatScrollContainer}
                  class="flex-1 overflow-y-auto p-4 space-y-4 font-sans"
                >
                  <Show
                    when={messages().length > 0}
                    fallback={
                      <div class="h-full flex flex-col items-center justify-center text-center p-6 space-y-3">
                        <div class="w-11 h-11 rounded-2xl bg-brand-500/10 text-brand-500 flex items-center justify-center">
                          <Icon name={Icons.sparkles} size={22} />
                        </div>
                        <div class="max-w-xs space-y-1">
                          <h3 class="text-xs font-bold text-ink-100">Ready to Assist</h3>
                          <p class="text-[11px] text-ink-400 leading-relaxed">
                            Ask me to write code, debug errors, or run commands in{" "}
                            <span class="font-mono text-ink-200">{activeSession()?.cwd || "~"}</span>.
                          </p>
                        </div>

                        <div class="flex flex-wrap justify-center gap-1.5 pt-2">
                          {[
                            "List project structure",
                            "Run tests and check status",
                            "Explain current architecture",
                          ].map((prompt) => (
                            <button
                              onClick={() => {
                                setPromptInput(prompt);
                                sendPrompt();
                              }}
                              class="rounded-xl border border-line bg-ink-900/80 px-2.5 py-1 text-[11px] text-ink-300 hover:text-ink-100 hover:border-brand-500/40 transition-colors cursor-pointer"
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
                          class={`flex gap-2.5 text-xs ${
                            msg.role === "user" ? "justify-end" : "justify-start"
                          }`}
                        >
                          <Show when={msg.role === "assistant"}>
                            <div class="w-6 h-6 rounded-lg bg-brand-500/20 text-brand-400 flex items-center justify-center shrink-0 mt-0.5">
                              <Icon name={Icons.sparkles} size={13} />
                            </div>
                          </Show>

                          <div
                            class={`max-w-[88%] rounded-2xl p-3.5 shadow-sm ${
                              msg.role === "user"
                                ? "bg-brand-500 text-white font-medium"
                                : "bg-ink-900 border border-line text-ink-200"
                            }`}
                          >
                            <For each={msg.blocks}>
                              {(block) => (
                                <>
                                  <Show when={block.type === "text" && block.text}>
                                    <div
                                      class="prose-xs leading-relaxed select-text"
                                      innerHTML={
                                        msg.role === "user"
                                          ? escapeHtml(block.text || "").replace(/\n/g, "<br/>")
                                          : renderMarkdown(block.text || "")
                                      }
                                    />
                                  </Show>

                                  <Show when={block.type === "reasoning" && block.reasoning}>
                                    <details class="my-2 rounded-xl border border-line/60 bg-ink-950/40 p-2 text-[11px]">
                                      <summary class="font-semibold text-ink-400 cursor-pointer hover:text-ink-200 select-none">
                                        Thinking process
                                      </summary>
                                      <div class="mt-2 text-ink-400 whitespace-pre-wrap font-mono text-[10px] leading-relaxed border-t border-line/40 pt-2">
                                        {block.reasoning}
                                      </div>
                                    </details>
                                  </Show>

                                  <Show when={block.type === "tool_call"}>
                                    <ToolExecutionCard block={block} />
                                  </Show>
                                </>
                              )}
                            </For>
                          </div>

                          <Show when={msg.role === "user"}>
                            <div class="w-6 h-6 rounded-lg bg-ink-800 text-ink-200 flex items-center justify-center shrink-0 mt-0.5 text-[11px] font-bold">
                              U
                            </div>
                          </Show>
                        </div>
                      )}
                    </For>
                  </Show>

                  {/* Interactive Tool Approval Banner */}
                  <Show when={pendingApproval()}>
                    {(appr) => (
                      <div class="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-3 space-y-2.5 shadow-md">
                        <div class="flex items-center gap-2 text-amber-400 font-semibold text-xs">
                          <Icon name={Icons.warning} size={15} />
                          <span>Tool Execution Approval Required</span>
                        </div>

                        <div class="rounded-xl bg-ink-950 p-2.5 font-mono text-[11px] text-ink-200 border border-line">
                          <div class="text-[10px] text-ink-500 font-bold uppercase mb-1 font-sans">
                            Tool: <span class="text-brand-400">{appr().tool}</span>
                          </div>
                          <pre class="overflow-x-auto whitespace-pre-wrap">{appr().args}</pre>
                        </div>

                        <div class="flex items-center justify-end gap-2">
                          <Btn variant="danger" size="sm" onClick={() => respondApproval(false)}>
                            <Icon name={Icons.x} size={13} />
                            <span>Reject</span>
                          </Btn>
                          <Btn variant="primary" size="sm" onClick={() => respondApproval(true)}>
                            <Icon name={Icons.check} size={13} />
                            <span>Approve &amp; Run</span>
                          </Btn>
                        </div>
                      </div>
                    )}
                  </Show>
                </div>

                {/* Prompt Composer */}
                <div class="p-3 border-t border-line bg-ink-950 relative">
                  {/* Slash Command Suggestions Popup */}
                  <Show when={showSlashPopup()}>
                    <div class="absolute bottom-full left-3 right-3 mb-2 rounded-2xl border border-line bg-ink-900 shadow-2xl p-1.5 space-y-1 z-30 max-h-56 overflow-y-auto">
                      <div class="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-ink-500">
                        Slash Commands
                      </div>
                      <For each={filteredSlashCommands()}>
                        {(cmd) => (
                          <div
                            onClick={() => {
                              setPromptInput(cmd.name + " ");
                              setShowSlashPopup(false);
                            }}
                            class="flex items-center justify-between p-1.5 rounded-xl hover:bg-ink-800 text-ink-200 hover:text-ink-100 cursor-pointer text-xs"
                          >
                            <div class="flex items-center gap-2">
                              <span>{cmd.icon}</span>
                              <span class="font-mono font-semibold text-brand-400">{cmd.name}</span>
                            </div>
                            <span class="text-[11px] text-ink-400">{cmd.desc}</span>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>

                  <div class="relative flex items-end gap-2 rounded-xl border border-line bg-ink-900 px-3 py-2 focus-within:border-brand-500">
                    <textarea
                      value={promptInput()}
                      onInput={handlePromptInput}
                      onKeyDown={handleComposerKeyDown}
                      placeholder={
                        activeSession()
                          ? `Message agent in ${activeSession()?.cwd}... (Type / for commands)`
                          : "Select or create a session..."
                      }
                      disabled={!activeSession() || activeHost()?.status !== "online"}
                      rows={2}
                      class="flex-1 max-h-36 min-h-[38px] resize-none bg-transparent text-xs text-ink-100 placeholder-ink-500 outline-none leading-relaxed disabled:opacity-50"
                    />

                    <Show
                      when={sessionStatus() === "running"}
                      fallback={
                        <button
                          onClick={sendPrompt}
                          disabled={!promptInput().trim() || !activeSession() || activeHost()?.status !== "online"}
                          class="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 text-white hover:bg-brand-600 disabled:opacity-30 transition-all cursor-pointer shrink-0"
                          aria-label="Send message"
                        >
                          <Icon name={Icons.send} size={14} />
                        </button>
                      }
                    >
                      <button
                        onClick={cancelTurn}
                        class="flex h-8 w-8 items-center justify-center rounded-lg bg-rose-500 text-white hover:bg-rose-600 transition-all cursor-pointer shrink-0"
                        aria-label="Stop generation"
                      >
                        <Icon name={Icons.stop} size={14} />
                      </button>
                    </Show>
                  </div>

                  <div class="flex items-center justify-between text-[10px] text-ink-500 px-1 mt-1.5">
                    <span>Enter sends • Shift+Enter newline • / for commands</span>
                    <span class="flex items-center gap-1">
                      <span class={`h-1.5 w-1.5 rounded-full ${wsConnected() ? "bg-emerald-500" : "bg-rose-500"}`} />
                      <span>{wsConnected() ? "Relay OK" : "Connecting..."}</span>
                    </span>
                  </div>
                </div>
              </div>
            </Show>
          </div>

          {/* ----- BOTTOM: INTEGRATED REMOTE BASH TERMINAL DRAWER ----- */}
          <Show when={terminalOpen()}>
            <div class="h-48 border-t border-line bg-ink-950 flex flex-col shrink-0 font-mono text-xs">
              {/* Terminal Header */}
              <div class="h-7 bg-ink-900 border-b border-line px-3 flex items-center justify-between text-[11px] text-ink-400 select-none">
                <div class="flex items-center gap-2">
                  <Icon name={Icons.terminal} size={12} class="text-brand-400" />
                  <span class="font-bold text-ink-200">Terminal (Bash)</span>
                  <span class="text-ink-600">•</span>
                  <span class="text-ink-400">{activeSession()?.cwd || "~"}</span>
                </div>

                <div class="flex items-center gap-2">
                  <button
                    onClick={() => setTerminalLogs([])}
                    class="hover:text-ink-100 text-ink-400 p-0.5 transition-colors cursor-pointer"
                    title="Clear Terminal Output"
                  >
                    Clear
                  </button>
                  <button
                    onClick={() => setTerminalOpen(false)}
                    class="hover:text-ink-100 text-ink-400 p-0.5 transition-colors cursor-pointer"
                    title="Close Terminal Drawer"
                  >
                    <Icon name={Icons.x} size={12} />
                  </button>
                </div>
              </div>

              {/* Terminal Output Log */}
              <div
                ref={terminalScrollContainer}
                class="flex-1 p-3 overflow-y-auto space-y-2 select-text leading-relaxed"
              >
                <Show
                  when={terminalLogs().length > 0}
                  fallback={
                    <div class="text-ink-600 text-[11px]">
                      Connected to remote shell on {activeHost()?.name || "host"}. Type a bash command below...
                    </div>
                  }
                >
                  <For each={terminalLogs()}>
                    {(log) => (
                      <div class="space-y-1">
                        <Show when={log.command}>
                          <div class="flex items-center gap-1.5 text-brand-400 font-bold">
                            <span>$</span>
                            <span>{log.command}</span>
                          </div>
                        </Show>
                        <Show when={log.stdout}>
                          <pre class="text-ink-200 whitespace-pre-wrap">{log.stdout}</pre>
                        </Show>
                        <Show when={log.stderr}>
                          <pre class="text-rose-400 whitespace-pre-wrap">{log.stderr}</pre>
                        </Show>
                        <Show when={log.exitCode !== undefined && log.exitCode !== 0}>
                          <div class="text-rose-500 text-[10px]">Exited with code {log.exitCode}</div>
                        </Show>
                      </div>
                    )}
                  </For>
                </Show>
              </div>

              {/* Terminal Interactive Input Prompt */}
              <div class="h-8 border-t border-line/60 bg-ink-900/40 px-3 flex items-center gap-2">
                <span class="text-brand-400 font-bold">$</span>
                <input
                  type="text"
                  value={terminalCmd()}
                  onInput={(e) => setTerminalCmd(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      executeTerminalCommand();
                    } else if (e.key === "ArrowUp") {
                      const hist = terminalHistory();
                      if (hist.length > 0) {
                        const nextIdx = Math.min(historyIndex() + 1, hist.length - 1);
                        setHistoryIndex(nextIdx);
                        setTerminalCmd(hist[nextIdx] || "");
                      }
                    } else if (e.key === "ArrowDown") {
                      const hist = terminalHistory();
                      const nextIdx = Math.max(historyIndex() - 1, -1);
                      setHistoryIndex(nextIdx);
                      setTerminalCmd(nextIdx >= 0 ? hist[nextIdx] || "" : "");
                    }
                  }}
                  placeholder="Enter remote command (e.g. ls -la, bun test, git status)..."
                  class="flex-1 bg-transparent text-ink-100 placeholder-ink-600 outline-none text-xs"
                />
              </div>
            </div>
          </Show>
        </div>
      </div>

      {/* ===== BOTTOM STATUS BAR (VS Code 24px style) ===== */}
      <footer class="h-6 bg-ink-900 border-t border-line px-3 flex items-center justify-between text-[11px] text-ink-400 shrink-0 select-none">
        <div class="flex items-center gap-3 min-w-0">
          {/* Host connection status */}
          <div class="flex items-center gap-1.5">
            <span class={`h-2 w-2 rounded-full ${activeHost()?.status === "online" ? "bg-emerald-500" : "bg-ink-600"}`} />
            <span class="font-medium text-ink-200 truncate">{activeHost()?.name || "Disconnected"}</span>
          </div>

          {/* Git branch */}
          <Show when={gitBranch()}>
            <div class="flex items-center gap-1 text-ink-300 font-mono">
              <Icon name={Icons.git} size={11} />
              <span>{gitBranch()}</span>
              <Show when={gitFiles().length > 0}>
                <span class="text-amber-400 font-bold">*({gitFiles().length})</span>
              </Show>
            </div>
          </Show>
        </div>

        <div class="flex items-center gap-4">
          {/* Active file details */}
          <Show when={activeTab()}>
            {(tab) => (
              <div class="hidden sm:flex items-center gap-2 font-mono text-ink-400">
                <span>{tab().content.split("\n").length} lines</span>
                <span class="text-ink-600">•</span>
                <span>UTF-8</span>
              </div>
            )}
          </Show>

          {/* Agent status */}
          <div class="flex items-center gap-1.5">
            <span
              class={`h-1.5 w-1.5 rounded-full ${
                sessionStatus() === "running" ? "bg-brand-500 animate-ping" : "bg-ink-500"
              }`}
            />
            <span class="text-ink-300">{sessionStatus() === "running" ? "Agent Working..." : "Ready"}</span>
          </div>
        </div>
      </footer>

      {/* ===== CONNECT MACHINE PAIRING MODAL ===== */}
      <Modal
        title="Connect Remote Host Machine"
        open={showPairModal()}
        onClose={() => setShowPairModal(false)}
      >
        <div class="space-y-4 text-xs">
          <p class="text-ink-400 leading-relaxed">
            Run the single compiled static daemon binary on your remote machine or laptop.
            All files, shells, and agent sessions run 100% locally on your machine.
          </p>

          <Show when={pairData()}>
            {(data) => {
              const cmd = `./llmgw-daemon --connect "${data().connectUrl}"`;
              return (
                <div class="space-y-3">
                  <div class="rounded-xl border border-line bg-ink-950 p-3 font-mono text-xs text-ink-100 flex items-center justify-between gap-2 overflow-hidden">
                    <span class="truncate">{cmd}</span>
                    <button
                      onClick={() => copyWithToast(cmd, "Command copied")}
                      class="text-brand-400 hover:text-brand-300 font-sans font-semibold shrink-0 cursor-pointer"
                    >
                      Copy
                    </button>
                  </div>

                  <div class="flex items-center gap-2 text-ink-400">
                    <span class="inline-flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                    <span>Awaiting daemon handshake...</span>
                  </div>

                  <div class="rounded-xl bg-ink-850 p-3 text-ink-400 space-y-1.5 border border-line/60">
                    <div class="font-semibold text-ink-200">Capabilities enabled:</div>
                    <ul class="list-disc pl-4 space-y-1 text-ink-300">
                      <li>File Explorer tree with real-time directory listing</li>
                      <li>Multi-tab file editing with save (`Cmd+S`) &amp; syntax highlighting</li>
                      <li>Interactive remote bash terminal runner</li>
                      <li>Full Zot agent with tools (read, write, edit, bash, glob)</li>
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
            placeholder="~/projects/my-project"
            hint="The daemon will execute tools and terminal commands relative to this path"
          />

          <Input
            label="Session Title (Optional)"
            value={newTitle()}
            onInput={setNewTitle}
            placeholder="e.g. Fullstack Redesign"
          />

          <div>
            <label class="block text-xs font-semibold text-ink-200 mb-1.5">Model</label>
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

      {/* ===== NEW FILE MODAL ===== */}
      <Modal
        title="Create New File"
        open={showNewFileModal()}
        onClose={() => setShowNewFileModal(false)}
      >
        <div class="space-y-4">
          <Input
            label="File Path (Relative to session CWD)"
            value={newFilePath()}
            onInput={setNewFilePath}
            placeholder="src/components/MyComponent.tsx"
            hint="Parent directories will be created automatically"
          />

          <div class="flex items-center justify-end gap-2 pt-3 border-t border-line">
            <Btn variant="secondary" onClick={() => setShowNewFileModal(false)}>
              Cancel
            </Btn>
            <Btn
              variant="primary"
              onClick={() => {
                const p = newFilePath().trim();
                if (!p) return;
                const act = activeSession();
                const fullPath = act ? `${act.cwd}/${p}` : p;
                openFileInEditor(fullPath, p.split("/").pop() || p);
                setShowNewFileModal(false);
              }}
            >
              Create &amp; Open
            </Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/**
 * Recursive File Explorer Tree Node Component
 */
function FileTreeNode(props: {
  node: FileEntry;
  onToggle: (n: FileEntry) => void;
  onOpenFile: (path: string, name: string) => void;
}) {
  const isDir = () => props.node.isDir;
  const { label, color } = getFileIcon(props.node.name);

  return (
    <div>
      <div
        onClick={() => {
          if (isDir()) {
            props.onToggle(props.node);
          } else {
            props.onOpenFile(props.node.path, props.node.name);
          }
        }}
        class="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-ink-850 hover:text-ink-100 text-ink-300 cursor-pointer transition-colors"
      >
        <Show
          when={isDir()}
          fallback={<span class={`w-4 text-center text-[10px] ${color}`}>{label}</span>}
        >
          <Icon
            name={Icons.chevronRight}
            size={11}
            class={`text-ink-500 transition-transform ${props.node.isOpen ? "rotate-90" : ""}`}
          />
          <Icon name={Icons.folder} size={13} class="text-brand-400" />
        </Show>

        <span class="truncate">{props.node.name}</span>
      </div>

      <Show when={isDir() && props.node.isOpen && props.node.children}>
        <div class="pl-3.5 border-l border-line/40 ml-2 space-y-0.5 my-0.5">
          <For each={props.node.children}>
            {(child) => (
              <FileTreeNode node={child} onToggle={props.onToggle} onOpenFile={props.onOpenFile} />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/**
 * Collapsible Tool Execution Card Component
 */
function ToolExecutionCard(props: { block: ContentBlock }) {
  const [expanded, setExpanded] = createSignal(true);
  const toolName = () => props.block.toolName || "tool";
  const hasResult = () => props.block.toolResult !== undefined;
  const isError = () => !!props.block.isError;

  return (
    <div class="my-2.5 overflow-hidden rounded-xl border border-line bg-ink-950 font-mono text-xs shadow-sm">
      <div
        onClick={() => setExpanded(!expanded())}
        class="flex items-center justify-between border-b border-line/60 bg-ink-900/80 px-3.5 py-2 cursor-pointer select-none hover:bg-ink-850 transition-colors"
      >
        <div class="flex items-center gap-2 min-w-0">
          <span class="rounded bg-brand-500/20 px-1.5 py-0.5 text-[10px] font-bold text-brand-400 uppercase tracking-wider">
            {toolName()}
          </span>
          <span class="text-ink-400 font-sans text-xs truncate max-w-xs">
            {props.block.toolArgs?.slice(0, 50)}
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

      <Show when={expanded()}>
        <div class="p-3 space-y-2.5 text-ink-200">
          <div>
            <div class="text-[10px] uppercase tracking-wider text-ink-500 font-bold mb-1 font-sans">
              Arguments
            </div>
            <pre class="overflow-x-auto rounded-lg bg-ink-900/60 p-2 text-[11px] leading-relaxed text-ink-300 max-h-40">
              {props.block.toolArgs}
            </pre>
          </div>

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
                class={`overflow-x-auto rounded-lg p-2.5 text-[11px] leading-relaxed max-h-52 ${
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
