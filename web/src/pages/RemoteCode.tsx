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
  Input,
  Modal,
  ThemeToggle,
  copyWithToast,
  fmtDate,
  toast,
} from "../ui";

// Configure marked with syntax highlighting
marked.setOptions({
  breaks: true,
  gfm: true,
});

import { Icon as Iconify } from "../components/icon";

/**
 * Interfaces
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

export interface AgentSettings {
  model: string;
  reasoning: string;
  temperature: number;
  autoCompactPercent: number;
  jailByDefault: boolean;
  autoSwarmEnabled: boolean;
  insecureTls: boolean;
  httpProxy: string;
  maxExecutionTimeSec: number;
}

export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  transport: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface SkillConfig {
  name: string;
  description: string;
  body: string;
  enabled: boolean;
}

/**
 * Slash command definitions for autocomplete palette
 */
const SLASH_COMMANDS = [
  {
    cmd: "/compact",
    desc: "Compact conversation transcript to free up context tokens",
    args: "",
  },
  {
    cmd: "/clear",
    desc: "Wipe all messages in current session",
    args: "",
  },
  {
    cmd: "/jail",
    desc: "Strictly confine agent filesystem tools to session directory",
    args: "",
  },
  {
    cmd: "/unjail",
    desc: "Allow agent to access files outside session working directory",
    args: "",
  },
  {
    cmd: "/model",
    desc: "Switch the active language model",
    args: "<model-name>",
  },
  {
    cmd: "/reasoning",
    desc: "Adjust reasoning effort (off, low, medium, high)",
    args: "<effort>",
  },
  {
    cmd: "/skills",
    desc: "List built-in tools and active custom skills",
    args: "",
  },
  {
    cmd: "/mcp",
    desc: "List active Model Context Protocol servers",
    args: "",
  },
  {
    cmd: "/help",
    desc: "Show complete command reference",
    args: "",
  },
];

export default function RemoteCodePage() {
  // Hosts & Pairing
  const [hosts, setHosts] = createSignal<RemoteHostDto[]>([]);
  const [activeHostId, setActiveHostId] = createSignal<string>("");
  const [showPairModal, setShowPairModal] = createSignal(false);
  const [pairingData, setPairingData] = createSignal<RemotePairDto | null>(null);
  const [pairingLoading, setPairingLoading] = createSignal(false);

  // Gateway Models (Fetched live from /api/me/models)
  const [gatewayModels, setGatewayModels] = createSignal<
    Array<{ id: string; name: string }>
  >([]);

  // Sessions
  const [sessions, setSessions] = createSignal<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = createSignal<string>("");
  const [sessionFilter, setSessionFilter] = createSignal<string>("");
  const [showNewSessionModal, setShowNewSessionModal] = createSignal(false);
  const [newSessionCwd, setNewSessionCwd] = createSignal("");
  const [newSessionTitle, setNewSessionTitle] = createSignal("");

  // Projects (Antigravity-style: pasta no host agrupa conversas)
  interface Project {
    id: string;
    hostId: string;
    name: string;
    path: string;
    createdAt: number;
  }
  const [projects, setProjects] = createSignal<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = createSignal<string>("");
  const [showNewProjectModal, setShowNewProjectModal] = createSignal(false);
  const [newProjectPath, setNewProjectPath] = createSignal("");

  function projectsKey(hostId: string) {
    return `llmgw-projects:${hostId}`;
  }
  function loadProjects(hostId: string) {
    if (!hostId) {
      setProjects([]);
      setActiveProjectId("");
      return;
    }
    try {
      const raw = localStorage.getItem(projectsKey(hostId));
      const list: Project[] = raw ? JSON.parse(raw) : [];
      const scoped = Array.isArray(list) ? list.filter((p) => p.hostId === hostId) : [];
      setProjects(scoped);
      if (scoped.length > 0 && !scoped.some((p) => p.id === activeProjectId())) {
        setActiveProjectId(scoped[0].id);
      }
      if (scoped.length === 0) setActiveProjectId("");
    } catch {
      setProjects([]);
      setActiveProjectId("");
    }
  }
  function persistProjects(list: Project[]) {
    try {
      const hid = activeHostId();
      if (hid) localStorage.setItem(projectsKey(hid), JSON.stringify(list));
    } catch {}
  }
  function basename(p: string) {
    const t = p.replace(/\/+$/, "").trim();
    if (!t) return p;
    const parts = t.split("/");
    return parts[parts.length - 1] || t;
  }

  // Chat Transcript & In-Flight State
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [inputPrompt, setInputPrompt] = createSignal("");
  const [activeModel, setActiveModel] = createSignal("gpt-4o");
  const [yoloMode, setYoloMode] = createSignal(false);
  const [sessionStatus, setSessionStatus] = createSignal<"idle" | "running">("idle");
  const [pendingApproval, setPendingApproval] = createSignal<PendingApproval | null>(null);

  // Agent Configuration & MCP Center
  const [showConfigModal, setShowConfigModal] = createSignal(false);
  const [configTab, setConfigTab] = createSignal<
    "settings" | "mcp" | "skills" | "slash"
  >("settings");
  const [daemonSettings, setDaemonSettings] = createSignal<AgentSettings>({
    model: "gpt-4o",
    reasoning: "off",
    temperature: 0.7,
    autoCompactPercent: 80,
    jailByDefault: false,
    autoSwarmEnabled: false,
    insecureTls: false,
    httpProxy: "",
    maxExecutionTimeSec: 600,
  });
  const [mcpServers, setMcpServers] = createSignal<Record<string, MCPServerConfig>>({});
  const [skills, setSkills] = createSignal<Record<string, SkillConfig>>({});

  // Autocomplete Palette
  const [slashIndex, setSlashIndex] = createSignal(0);

  // UI state
  const [sidebarOpen, setSidebarOpen] = createSignal(true);
  const [chatContainerRef, setChatContainerRef] = createSignal<HTMLDivElement | null>(null);

  let ws: WebSocket | null = null;
  let heartbeatTimer: any = null;

  const activeHost = createMemo(() => {
    const list = hosts();
    if (!Array.isArray(list) || list.length === 0) return null;
    return list.find((h) => h.id === activeHostId()) ?? list[0] ?? null;
  });

  const activeSession = createMemo(() => {
    return sessions().find((s) => s.id === activeSessionId()) ?? null;
  });

  const activeProject = createMemo(() => {
    const list = projects();
    if (list.length === 0) return null;
    return list.find((p) => p.id === activeProjectId()) ?? list[0] ?? null;
  });

  function sessionsOfProject(projectPath: string) {
    const norm = projectPath.replace(/\/+$/, "");
    return sessions().filter((s) => {
      const cwd = (s.cwd || "").replace(/\/+$/, "");
      return cwd === norm || cwd.startsWith(norm + "/");
    });
  }

  function timeAgo(ts: number) {
    const d = Date.now() - ts;
    const m = Math.floor(d / 60000);
    if (m < 1) return "now";
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const days = Math.floor(h / 24);
    return `${days}d`;
  }

  const filteredSessions = createMemo(() => {
    const q = sessionFilter().toLowerCase().trim();
    let base = sessions();
    const ap = activeProject();
    // Quando há projeto ativo, a lista filtra por ele (como no Antigravity).
    // Sem projeto, mostra tudo.
    if (ap) base = sessionsOfProject(ap.path);
    if (!q) return base;
    return base.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q) ||
        s.model.toLowerCase().includes(q),
    );
  });

  const slashMatches = createMemo(() => {
    const text = inputPrompt().trim();
    if (!text.startsWith("/")) return [];
    const prefix = text.toLowerCase();
    return SLASH_COMMANDS.filter((sc) => sc.cmd.startsWith(prefix));
  });

  // --- Fetch Gateway Models ---
  async function loadGatewayModels() {
    try {
      const res = await api<{ models: Array<{ id: string; name: string }> }>(
        "GET",
        "/api/me/models",
      );
      if (res && Array.isArray(res.models) && res.models.length > 0) {
        setGatewayModels(res.models);
        if (!res.models.some((m) => m.id === activeModel())) {
          setActiveModel(res.models[0].id);
        }
      } else {
        setGatewayModels([
          { id: "gpt-4o", name: "GPT-4o (OpenAI)" },
          { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet (Anthropic)" },
          { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro (Google)" },
        ]);
      }
    } catch {
      setGatewayModels([
        { id: "gpt-4o", name: "GPT-4o" },
        { id: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" },
      ]);
    }
  }

  // --- Fetch Hosts ---
  async function loadHosts() {
    try {
      const res = await api<{ success: boolean; hosts: RemoteHostDto[] }>(
        "GET",
        "/api/remote/hosts",
      );
      const list = Array.isArray(res?.hosts) ? res.hosts : [];
      setHosts(list);
      if (list.length > 0) {
        if (!activeHostId() || !list.some((h) => h.id === activeHostId())) {
          const online = list.find((h) => h.status === "online");
          setActiveHostId(online ? online.id : list[0].id);
        }
      } else {
        setActiveHostId("");
      }
    } catch (e: any) {
      console.warn("Failed to load remote hosts:", e);
      toast("Failed to load remote hosts: " + (e?.message || e), "err");
    }
  }

  // --- WebSocket Connection ---
  function connectWebSocket(hostId: string) {
    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }
    clearInterval(heartbeatTimer);

    const s = currentSession();
    if (!s || !hostId) return;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/api/remote/ws?token=${s.accessToken}&hostId=${hostId}`;

    ws = new WebSocket(url);

    ws.onopen = () => {
      sendWS({ type: "list_sessions", requestId: "init_" + Date.now() });
      sendWS({ type: "get_config", requestId: "cfg_" + Date.now() });

      heartbeatTimer = setInterval(() => {
        sendWS({ type: "ping", ts: Date.now() });
      }, 15000);
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        handleIncomingMessage(msg);
      } catch (err) {
        console.error("WS parse error:", err);
      }
    };

    ws.onclose = () => {
      clearInterval(heartbeatTimer);
    };

    ws.onerror = (e) => {
      console.warn("WebSocket error:", e);
    };
  }

  function sendWS(payload: any) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (!payload.hostId && activeHostId()) {
        payload.hostId = activeHostId();
      }
      ws.send(JSON.stringify(payload));
    }
  }

  // --- Message Handling ---
  function handleIncomingMessage(msg: any) {
    switch (msg.type) {
      case "relay_connected":
        break;
      case "host_status": {
        if (msg.hostId && msg.status) {
          setHosts((prev) =>
            prev.map((h) => (h.id === msg.hostId ? { ...h, status: msg.status } : h)),
          );
        }
        break;
      }
      case "sessions_list": {
        const rawList = msg.sessions || [];
        const mapped: SessionSummary[] = rawList.map((r: any) => ({
          id: r.id,
          cwd: r.cwd,
          title: r.title || r.cwd,
          model: r.model || "gpt-4o",
          status: r.status || "idle",
          createdAt: r.createdAt || Date.now(),
          updatedAt: r.updatedAt || Date.now(),
          messageCount: r.messages ? r.messages.length : 0,
        }));
        setSessions(mapped);
        if (!activeSessionId() && mapped.length > 0) {
          selectSession(mapped[0].id);
        }
        break;
      }

      case "session_created": {
        const r = msg.session;
        if (!r) break;
        const s: SessionSummary = {
          id: r.id,
          cwd: r.cwd,
          title: r.title || r.cwd,
          model: r.model || "gpt-4o",
          status: r.status || "idle",
          createdAt: r.createdAt || Date.now(),
          updatedAt: r.updatedAt || Date.now(),
          messageCount: 0,
        };
        setSessions((prev) => [s, ...prev.filter((x) => x.id !== s.id)]);
        selectSession(s.id);
        toast(`Session created in ${s.cwd}`, "ok");
        break;
      }

      case "session_deleted": {
        setSessions((prev) => prev.filter((s) => s.id !== msg.sessionId));
        if (activeSessionId() === msg.sessionId) {
          const rem = sessions().filter((s) => s.id !== msg.sessionId);
          if (rem.length > 0) selectSession(rem[0].id);
          else {
            setActiveSessionId("");
            setMessages([]);
          }
        }
        toast("Session removed", "ok");
        break;
      }

      case "session_content": {
        if (msg.sessionId !== activeSessionId()) break;
        const rawMsgs = msg.messages || [];
        const parsed: ChatMessage[] = rawMsgs.map((m: any, idx: number) => {
          const blocks: ContentBlock[] = [];
          if (Array.isArray(m.content)) {
            for (const c of m.content) {
              if (c.type === "text" || typeof c.text === "string") {
                blocks.push({ type: "text", text: c.text });
              } else if (c.type === "tool_use" || c.name) {
                blocks.push({
                  type: "tool_call",
                  toolId: c.id,
                  toolName: c.name,
                  toolArgs:
                    typeof c.input === "string"
                      ? c.input
                      : JSON.stringify(c.input ?? c.arguments, null, 2),
                });
              } else if (c.type === "tool_result") {
                blocks.push({
                  type: "tool_result",
                  toolId: c.tool_use_id || c.id,
                  toolResult:
                    typeof c.content === "string"
                      ? c.content
                      : JSON.stringify(c.content, null, 2),
                  isError: !!c.is_error,
                });
              }
            }
          } else if (typeof m.content === "string") {
            blocks.push({ type: "text", text: m.content });
          }
          return {
            id: `msg_${idx}`,
            role: m.role || "user",
            blocks,
            time: Date.now(),
          };
        });
        setMessages(parsed);
        scrollToBottom();
        break;
      }

      case "session_status": {
        if (msg.sessionId === activeSessionId()) {
          setSessionStatus(msg.status);
        }
        setSessions((prev) =>
          prev.map((s) =>
            s.id === msg.sessionId ? { ...s, status: msg.status } : s,
          ),
        );
        break;
      }

      case "session_cleared": {
        if (msg.sessionId === activeSessionId()) {
          setMessages([]);
          toast("Transcript cleared", "ok");
        }
        break;
      }

      case "session_compacted": {
        if (msg.sessionId === activeSessionId()) {
          handleIncomingMessage({
            type: "session_content",
            sessionId: msg.sessionId,
            messages: msg.messages,
          });
          toast("Transcript compacted successfully", "ok");
        }
        break;
      }

      case "config_data":
      case "config_updated": {
        if (msg.settings) {
          setDaemonSettings(msg.settings);
          if (msg.settings.model) setActiveModel(msg.settings.model);
        }
        if (msg.mcpServers) setMcpServers(msg.mcpServers);
        if (msg.skills) setSkills(msg.skills);
        if (msg.type === "config_updated") {
          toast("Daemon configuration saved", "ok");
        }
        break;
      }

      case "tool_approval_request": {
        if (msg.sessionId === activeSessionId()) {
          setPendingApproval({
            callId: msg.callId,
            tool: msg.tool,
            args:
              typeof msg.args === "string"
                ? msg.args
                : JSON.stringify(msg.args, null, 2),
          });
        }
        break;
      }

      case "agent_event": {
        if (msg.sessionId !== activeSessionId()) break;
        const ev = msg.event;
        if (!ev) break;

        if (ev.type === "turn_start") {
          setSessionStatus("running");
        } else if (ev.type === "text_delta") {
          appendStreamingDelta(ev.delta);
        } else if (ev.type === "tool_call") {
          appendToolCall(ev.id, ev.name, ev.args);
        } else if (ev.type === "tool_result") {
          setPendingApproval(null);
          appendToolResult(ev.id, ev.result, ev.isError);
        } else if (ev.type === "turn_end") {
          setSessionStatus("idle");
          setPendingApproval(null);
        }
        scrollToBottom();
        break;
      }

      case "error": {
        toast(msg.message || "Daemon returned an error", "err");
        setSessionStatus("idle");
        setPendingApproval(null);
        break;
      }
    }
  }

  function appendStreamingDelta(delta: string) {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant") {
        const blocks = [...last.blocks];
        const lastBlock = blocks[blocks.length - 1];
        if (lastBlock && lastBlock.type === "text") {
          blocks[blocks.length - 1] = {
            ...lastBlock,
            text: (lastBlock.text || "") + delta,
          };
        } else {
          blocks.push({ type: "text", text: delta });
        }
        return [...prev.slice(0, -1), { ...last, blocks }];
      } else {
        return [
          ...prev,
          {
            id: `asst_${Date.now()}`,
            role: "assistant",
            blocks: [{ type: "text", text: delta }],
            time: Date.now(),
          },
        ];
      }
    });
  }

  function appendToolCall(callId: string, name: string, args: string) {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      const toolBlock: ContentBlock = {
        type: "tool_call",
        toolId: callId,
        toolName: name,
        toolArgs: args,
      };

      if (last && last.role === "assistant") {
        return [
          ...prev.slice(0, -1),
          { ...last, blocks: [...last.blocks, toolBlock] },
        ];
      } else {
        return [
          ...prev,
          {
            id: `asst_${Date.now()}`,
            role: "assistant",
            blocks: [toolBlock],
            time: Date.now(),
          },
        ];
      }
    });
  }

  function appendToolResult(callId: string, result: string, isError?: boolean) {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      const resBlock: ContentBlock = {
        type: "tool_result",
        toolId: callId,
        toolResult: result,
        isError: !!isError,
      };

      if (last && last.role === "assistant") {
        return [
          ...prev.slice(0, -1),
          { ...last, blocks: [...last.blocks, resBlock] },
        ];
      } else {
        return [
          ...prev,
          {
            id: `asst_${Date.now()}`,
            role: "assistant",
            blocks: [resBlock],
            time: Date.now(),
          },
        ];
      }
    });
  }

  function scrollToBottom() {
    setTimeout(() => {
      const el = chatContainerRef();
      if (el) el.scrollTop = el.scrollHeight;
    }, 40);
  }

  function selectSession(id: string) {
    setActiveSessionId(id);
    setPendingApproval(null);
    const s = sessions().find((x) => x.id === id);
    if (s) {
      setSessionStatus(s.status);
      if (s.model) setActiveModel(s.model);
    }
    sendWS({ type: "get_session", sessionId: id });
  }

  function openNewSessionModal() {
    const ap = activeProject();
    // Pré-preenche com a pasta do projeto ativo (padrão Antigravity).
    setNewSessionCwd(ap?.path || activeSession()?.cwd || "");
    setNewSessionTitle("");
    setShowNewSessionModal(true);
  }

  function createProject() {
    const rawPath = newProjectPath().trim();
    if (!rawPath) {
      toast("Project folder cannot be empty", "err");
      return;
    }
    const hid = activeHostId();
    if (!hid) {
      toast("Connect a host first", "err");
      return;
    }
    const p: Project = {
      id: `proj_${Date.now().toString(36)}`,
      hostId: hid,
      name: basename(rawPath),
      path: rawPath,
      createdAt: Date.now(),
    };
    const next = [p, ...projects()];
    setProjects(next);
    persistProjects(next);
    setActiveProjectId(p.id);
    setNewProjectPath("");
    setShowNewProjectModal(false);
    toast(`Project '${p.name}' added`, "ok");
    // Já abre a criação de conversa dentro do projeto.
    openNewSessionModal();
  }

  function deleteProject(id: string, e: MouseEvent) {
    e.stopPropagation();
    if (!confirm("Remove this project from the list? Sessions on the host are kept.")) return;
    const next = projects().filter((p) => p.id !== id);
    setProjects(next);
    persistProjects(next);
    if (activeProjectId() === id) setActiveProjectId(next[0]?.id || "");
  }

  function createNewSession() {
    const cwd = newSessionCwd().trim();
    if (!cwd) {
      toast("Working directory cannot be empty", "err");
      return;
    }
    if (!ws || (ws as WebSocket).readyState !== WebSocket.OPEN) {
      toast("Not connected to host yet — wait for online status", "err");
      return;
    }
    sendWS({
      type: "create_session",
      requestId: "new_" + Date.now(),
      cwd,
      title: newSessionTitle().trim() || basename(cwd),
      model: activeModel(),
    });
    setShowNewSessionModal(false);
    setNewSessionCwd("");
    setNewSessionTitle("");
  }

  function deleteSession(id: string, e: MouseEvent) {
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this session?")) return;
    sendWS({ type: "delete_session", sessionId: id });
  }

  function sendPrompt() {
    const text = inputPrompt().trim();
    if (!text || !activeSessionId()) return;

    const userMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      role: "user",
      blocks: [{ type: "text", text }],
      time: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInputPrompt("");
    setSessionStatus("running");
    scrollToBottom();

    sendWS({
      type: "prompt",
      sessionId: activeSessionId(),
      text,
      model: activeModel(),
      yolo: yoloMode(),
    });
  }

  function cancelCurrentTurn() {
    if (!activeSessionId()) return;
    sendWS({ type: "cancel", sessionId: activeSessionId() });
    setSessionStatus("idle");
    setPendingApproval(null);
    toast("Generation stopped", "info");
  }

  function respondApproval(approved: boolean) {
    const p = pendingApproval();
    if (!p || !activeSessionId()) return;
    sendWS({
      type: "tool_approval_response",
      sessionId: activeSessionId(),
      callId: p.callId,
      approved,
    });
    setPendingApproval(null);
  }

  function executeSlashCommand(cmd: string) {
    setInputPrompt("");
    if (!activeSessionId()) return;
    sendWS({
      type: "prompt",
      sessionId: activeSessionId(),
      text: cmd,
      model: activeModel(),
      yolo: yoloMode(),
    });
  }

  // --- Pairing Flow ---
  async function generatePairingToken() {
    setPairingLoading(true);
    try {
      const res = await api<RemotePairDto>("POST", "/api/remote/pair");
      setPairingData(res);
      setShowPairModal(true);
    } catch (err: any) {
      toast("Pairing request failed: " + (err?.message || err), "err");
    } finally {
      setPairingLoading(false);
    }
  }

  // Save Settings to Daemon
  function saveDaemonConfig() {
    sendWS({
      type: "update_config",
      requestId: "upd_" + Date.now(),
      settings: daemonSettings(),
      mcpServers: mcpServers(),
      skills: skills(),
    });
  }

  // Add MCP Server
  const [newMcpName, setNewMcpName] = createSignal("");
  const [newMcpCmd, setNewMcpCmd] = createSignal("");
  const [newMcpArgs, setNewMcpArgs] = createSignal("");
  const [newMcpTransport, setNewMcpTransport] = createSignal("stdio");
  const [newMcpUrl, setNewMcpUrl] = createSignal("");

  function handleAddMcpServer() {
    const name = newMcpName().trim();
    const cmd = newMcpCmd().trim();
    if (!name || (!cmd && newMcpTransport() === "stdio")) {
      toast("Name and command are required", "err");
      return;
    }
    const current = { ...mcpServers() };
    current[name] = {
      command: cmd,
      args: newMcpArgs().trim() ? newMcpArgs().trim().split(/\s+/) : [],
      transport: newMcpTransport(),
      url: newMcpUrl().trim(),
    };
    setMcpServers(current);
    saveDaemonConfig();
    setNewMcpName("");
    setNewMcpCmd("");
    setNewMcpArgs("");
    setNewMcpUrl("");
    toast(`MCP Server '${name}' added`, "ok");
  }

  function handleDeleteMcpServer(name: string) {
    const current = { ...mcpServers() };
    delete current[name];
    setMcpServers(current);
    saveDaemonConfig();
    toast(`MCP Server '${name}' removed`, "ok");
  }

  // Add Skill
  const [newSkillName, setNewSkillName] = createSignal("");
  const [newSkillDesc, setNewSkillDesc] = createSignal("");
  const [newSkillBody, setNewSkillBody] = createSignal("");

  function handleAddSkill() {
    const name = newSkillName().trim();
    if (!name || !newSkillBody().trim()) {
      toast("Skill name and instruction prompt body are required", "err");
      return;
    }
    const current = { ...skills() };
    current[name] = {
      name,
      description: newSkillDesc().trim(),
      body: newSkillBody().trim(),
      enabled: true,
    };
    setSkills(current);
    saveDaemonConfig();
    setNewSkillName("");
    setNewSkillDesc("");
    setNewSkillBody("");
    toast(`Skill '${name}' created`, "ok");
  }

  function toggleSkill(name: string) {
    const current = { ...skills() };
    if (current[name]) {
      current[name] = { ...current[name], enabled: !current[name].enabled };
      setSkills(current);
      saveDaemonConfig();
    }
  }

  function handleDeleteSkill(name: string) {
    const current = { ...skills() };
    delete current[name];
    setSkills(current);
    saveDaemonConfig();
    toast(`Skill '${name}' removed`, "ok");
  }

  // Mount logic
  onMount(async () => {
    await loadGatewayModels();
    await loadHosts();
    if (activeHostId()) loadProjects(activeHostId());
    if (hosts().length === 0) {
      generatePairingToken();
    }
  });

  createEffect(() => {
    const hid = activeHostId();
    if (hid) {
      loadProjects(hid);
      connectWebSocket(hid);
    }
  });

  // Auto-poll hosts while waiting for initial daemon pairing
  createEffect(() => {
    if (hosts().length === 0) {
      const interval = setInterval(() => {
        loadHosts();
      }, 3000);
      onCleanup(() => clearInterval(interval));
    }
  });

  onCleanup(() => {
    if (ws) {
      try {
        ws.close();
      } catch {}
    }
    clearInterval(heartbeatTimer);
  });

  // Render markdown with syntax highlighted code
  function renderMarkdown(txt: string) {
    try {
      const rawHtml = marked.parse(txt) as string;
      return rawHtml;
    } catch {
      return txt;
    }
  }

  return (
    <div class="fixed inset-0 w-screen h-screen flex flex-col bg-ink-950 text-ink-100 overflow-hidden font-sans select-none z-50">
      {/* ========================================================================= */}
      {/* Top Application Navigation Bar                                             */}
      {/* ========================================================================= */}
      <header class="h-12 border-b border-line/70 bg-ink-950/95 backdrop-blur flex items-center justify-between px-3 shrink-0 z-30">
        {/* Left: Exit to Gateway & App Identifier */}
        <div class="flex items-center gap-2 min-w-0">
          <a
            href="#/"
            class="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-ink-400 hover:text-ink-100 hover:bg-ink-900 transition-colors text-xs font-medium"
            title="Return to LLM Gateway Dashboard"
          >
            <Iconify icon="lucide:arrow-left" size={14} />
            <span class="hidden sm:inline">LLM Gateway</span>
          </a>

          <div class="h-4 w-px bg-line/70" />

          <div class="flex items-center gap-2 min-w-0">
            <div class="w-6 h-6 rounded-md bg-ink-800 text-ink-200 flex items-center justify-center">
              <Iconify icon="lucide:terminal" size={14} />
            </div>
            {/* Breadcrumb estilo Antigravity: projeto / conversa */}
            <div class="flex items-center gap-1.5 text-[13px] min-w-0">
              <span class="text-ink-400 truncate max-w-[140px]" title={activeProject()?.path || "No project"}>
                {activeProject()?.name || "No project"}
              </span>
              <Show when={activeSession()}>
                <span class="text-ink-600">/</span>
                <span class="text-ink-200 truncate max-w-[220px] font-medium" title={activeSession()?.title}>
                  {activeSession()?.title}
                </span>
              </Show>
            </div>
          </div>
        </div>

        {/* Center: Connected Daemon Host Switcher */}
        <div class="flex items-center gap-2">
          <Show
            when={hosts().length > 0}
            fallback={
              <button
                onClick={generatePairingToken}
                class="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-ink-100 text-ink-950 font-medium hover:bg-white transition-colors cursor-pointer"
              >
                <Iconify icon="lucide:plus" size={14} />
                <span>Connect Host</span>
              </button>
            }
          >
            <div class="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-ink-900/70 border border-line/70 text-xs">
              <span
                class={`w-1.5 h-1.5 rounded-full ${
                  activeHost()?.status === "online"
                    ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.7)] animate-pulse"
                    : "bg-amber-500"
                }`}
              />
              <select
                class="bg-transparent text-ink-300 font-medium focus:outline-none cursor-pointer max-w-[160px]"
                value={activeHostId()}
                onChange={(e) => setActiveHostId(e.currentTarget.value)}
              >
                <For each={hosts()}>
                  {(h) => (
                    <option value={h.id} class="bg-ink-900 text-ink-100">
                      {h.name || h.hostname || h.id} ({h.status || "offline"})
                    </option>
                  )}
                </For>
              </select>
              <button
                onClick={generatePairingToken}
                class="text-ink-500 hover:text-ink-200 p-0.5 cursor-pointer"
                title="Connect another host"
              >
                <Iconify icon="lucide:plus" size={13} />
              </button>
            </div>
          </Show>
        </div>

        {/* Right: Model, Mode, Settings */}
        <div class="flex items-center gap-1.5">
          {/* Model Selector Dropdown (Live Gateway Models) */}
          <div class="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-ink-900 text-xs text-ink-300">
            <Iconify icon="lucide:sparkles" size={13} class="text-ink-500" />
            <select
              class="bg-transparent font-medium focus:outline-none cursor-pointer max-w-[150px] truncate"
              value={activeModel()}
              onChange={(e) => {
                const m = e.currentTarget.value;
                setActiveModel(m);
                if (activeSessionId()) {
                  sendWS({
                    type: "prompt",
                    sessionId: activeSessionId(),
                    text: `/model ${m}`,
                  });
                }
              }}
            >
              <For each={gatewayModels()}>
                {(m) => (
                  <option value={m.id} class="bg-ink-900 text-ink-100">
                    {m.name || m.id}
                  </option>
                )}
              </For>
            </select>
          </div>

          {/* Safe/YOLO Toggle */}
          <button
            onClick={() => {
              const next = !yoloMode();
              setYoloMode(next);
              toast(
                next
                  ? "YOLO Mode: tools run autonomously"
                  : "Safe Mode: approval required",
                next ? "warn" : "info",
              );
            }}
            class={`hidden sm:flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs transition-colors ${
              yoloMode()
                ? "text-amber-300 hover:bg-amber-500/10"
                : "text-ink-400 hover:bg-ink-900 hover:text-ink-200"
            }`}
            title="YOLO skips confirmation for file writes and shell"
          >
            <Iconify
              icon={yoloMode() ? "lucide:zap" : "lucide:shield"}
              size={13}
            />
          </button>

          {/* Settings */}
          <button
            onClick={() => setShowConfigModal(true)}
            class="p-1.5 rounded-lg text-ink-400 hover:text-ink-100 hover:bg-ink-900 transition-colors cursor-pointer"
            title="Agent Configuration, MCP Servers & Skills"
          >
            <Iconify icon="lucide:settings-2" size={15} />
          </button>

          <ThemeToggle />
        </div>
      </header>

      {/* ========================================================================= */}
      {/* Main Workspace Layout or Connect Host Onboarding                           */}
      {/* ========================================================================= */}
      <Show
        when={hosts().length > 0}
        fallback={
          <div class="flex-1 flex flex-col items-center justify-center p-6 bg-ink-950 text-center overflow-y-auto">
            <div class="max-w-xl w-full mx-auto space-y-6 my-auto py-8">
              {/* Hero Icon */}
              <div class="w-16 h-16 rounded-2xl bg-brand-500/10 border border-brand-500/20 text-brand-400 flex items-center justify-center mx-auto shadow-lg shadow-brand-500/10">
                <Iconify icon="lucide:terminal" size={32} />
              </div>

              {/* Title & Subtitle */}
              <div>
                <div class="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-medium mb-3">
                  <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  <span>No Remote Daemon Connected</span>
                </div>
                <h1 class="text-2xl sm:text-3xl font-bold tracking-tight text-ink-100">
                  Connect Code Remote
                </h1>
                <p class="text-sm text-ink-400 mt-2 max-w-md mx-auto leading-relaxed">
                  Run autonomous coding agents directly on your machine. Sessions, files, and commands remain 100% local on your device while you control them from this interface.
                </p>
              </div>

              {/* Action: Connect / Pair */}
              <Show
                when={pairingData()}
                fallback={
                  <div class="pt-2">
                    <button
                      onClick={generatePairingToken}
                      disabled={pairingLoading()}
                      class="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-brand-500 hover:bg-brand-600 text-white font-semibold text-sm transition-all shadow-lg shadow-brand-500/20 hover:shadow-brand-500/30 cursor-pointer disabled:opacity-50"
                    >
                      <Show
                        when={!pairingLoading()}
                        fallback={<Iconify icon="lucide:refresh-cw" size={18} class="animate-spin" />}
                      >
                        <Iconify icon="lucide:plus" size={18} />
                      </Show>
                      <span>Connect Remote Machine</span>
                    </button>
                  </div>
                }
              >
                {/* Pairing Card */}
                <div class="p-6 rounded-2xl bg-ink-900 border border-line text-left space-y-5 shadow-2xl">
                  <div class="flex items-center justify-between pb-3 border-b border-line">
                    <div class="flex items-center gap-2">
                      <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                      <span class="text-xs font-semibold uppercase tracking-wider text-ink-200">
                        Pairing Credentials Ready
                      </span>
                    </div>
                    <span class="text-[11px] font-mono text-ink-400">
                      Valid for ~15m
                    </span>
                  </div>

                  {/* Step 1: Run Command */}
                  <div class="space-y-2">
                    <div class="flex items-center justify-between text-xs font-medium text-ink-200">
                      <span>1. Run the daemon on your machine:</span>
                      <button
                        onClick={() =>
                          copyWithToast(
                            `./code-daemon -connect "${pairingData()?.connectUrl}"`,
                          )
                        }
                        class="text-brand-400 hover:text-brand-300 flex items-center gap-1 text-[11px] cursor-pointer"
                      >
                        <Iconify icon="lucide:copy" size={12} />
                        <span>Copy Command</span>
                      </button>
                    </div>
                    <div class="p-3 rounded-xl bg-ink-950 border border-line font-mono text-xs text-brand-300 break-all select-all">
                      ./code-daemon -connect "{pairingData()?.connectUrl}"
                    </div>
                  </div>

                  {/* Step 2: Connection URL */}
                  <div class="space-y-2">
                    <div class="flex items-center justify-between text-xs font-medium text-ink-200">
                      <span>Or paste this Connection URL into the daemon:</span>
                      <button
                        onClick={() =>
                          copyWithToast(pairingData()?.connectUrl || "")
                        }
                        class="text-brand-400 hover:text-brand-300 flex items-center gap-1 text-[11px] cursor-pointer"
                      >
                        <Iconify icon="lucide:copy" size={12} />
                        <span>Copy URL</span>
                      </button>
                    </div>
                    <div class="p-2.5 rounded-xl bg-ink-950 border border-line font-mono text-[11px] text-ink-300 break-all select-all">
                      {pairingData()?.connectUrl}
                    </div>
                  </div>

                  {/* Live Status */}
                  <div class="p-4 rounded-xl bg-brand-500/5 border border-brand-500/20 flex items-center gap-3">
                    <div class="w-8 h-8 rounded-lg bg-brand-500/10 flex items-center justify-center text-brand-400 shrink-0">
                      <Iconify icon="lucide:refresh-cw" size={16} class="animate-spin" />
                    </div>
                    <div class="text-xs">
                      <p class="font-medium text-ink-200">Waiting for daemon connection...</p>
                      <p class="text-ink-400 text-[11px] mt-0.5">
                        Run the command above in your terminal. This screen will connect automatically.
                      </p>
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div class="flex items-center justify-end gap-2.5 pt-2 text-xs">
                    <button
                      onClick={loadHosts}
                      class="px-3.5 py-1.5 rounded-lg border border-line text-ink-300 hover:text-ink-100 hover:bg-ink-800 transition-colors cursor-pointer"
                    >
                      Check Connection
                    </button>
                    <button
                      onClick={generatePairingToken}
                      class="px-3.5 py-1.5 rounded-lg bg-ink-800 hover:bg-ink-700 text-ink-200 transition-colors cursor-pointer"
                    >
                      Regenerate Token
                    </button>
                  </div>
                </div>
              </Show>
            </div>
          </div>
        }
      >
        <div class="flex-1 flex min-h-0 overflow-hidden relative">
        {/* --- Left Sidebar: Projects + Conversations (Antigravity) --- */}
        <aside
          class={`border-r border-line/70 bg-ink-950 flex flex-col shrink-0 transition-all duration-200 ${
            sidebarOpen() ? "w-64" : "w-0 overflow-hidden"
          }`}
        >
          {/* New Conversation */}
          <div class="p-2">
            <button
              onClick={() => {
                if (projects().length === 0) setShowNewProjectModal(true);
                else openNewSessionModal();
              }}
              class="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-ink-900 hover:bg-ink-800 border border-line/60 text-[13px] font-medium text-ink-200 transition-colors cursor-pointer"
            >
              <Iconify icon="lucide:plus" size={14} />
              <span>New Conversation</span>
            </button>
            <button
              onClick={() => (document.querySelector<HTMLInputElement>("#rc-filter")?.focus())}
              class="w-full flex items-center gap-2 px-3 py-1.5 mt-1 rounded-lg text-xs text-ink-500 hover:text-ink-300 hover:bg-ink-900/60 transition-colors cursor-pointer"
            >
              <Iconify icon="lucide:history" size={13} />
              <span>Conversation History</span>
            </button>
          </div>

          {/* Filter */}
          <div class="px-2 pb-2">
            <input
              id="rc-filter"
              type="text"
              placeholder="Filter..."
              class="w-full text-xs bg-transparent border border-line/60 rounded-lg px-2.5 py-1.5 text-ink-200 placeholder:text-ink-600 focus:outline-none focus:border-ink-500"
              value={sessionFilter()}
              onInput={(e) => setSessionFilter(e.currentTarget.value)}
            />
          </div>

          {/* Projects */}
          <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-4">
            <div>
              <div class="flex items-center justify-between px-1.5 pb-1">
                <span class="text-[11px] font-medium text-ink-500">Projects</span>
                <button
                  onClick={() => setShowNewProjectModal(true)}
                  class="p-1 rounded text-ink-500 hover:text-ink-200 hover:bg-ink-900 cursor-pointer"
                  title="Add project folder from host"
                >
                  <Iconify icon="lucide:folder-plus" size={13} />
                </button>
              </div>
              <Show
                when={projects().length > 0}
                fallback={
                  <button
                    onClick={() => setShowNewProjectModal(true)}
                    class="w-full text-left px-2.5 py-2 rounded-lg border border-dashed border-line text-xs text-ink-500 hover:text-ink-300 hover:border-ink-500 transition-colors cursor-pointer"
                  >
                    + Select a project folder on the host
                  </button>
                }
              >
                <div class="space-y-0.5">
                  <For each={projects()}>
                    {(p) => {
                      const isActive = () => p.id === (activeProject()?.id || "");
                      const count = () => sessionsOfProject(p.path).length;
                      return (
                        <div
                          onClick={() => setActiveProjectId(p.id)}
                          class={`group flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer text-[13px] transition-colors ${
                            isActive() ? "bg-ink-900 text-ink-100" : "text-ink-400 hover:bg-ink-900/60 hover:text-ink-200"
                          }`}
                          title={p.path}
                        >
                          <Iconify icon="lucide:folder" size={14} class="shrink-0 text-ink-500" />
                          <span class="truncate flex-1 font-medium">{p.name}</span>
                          <span class="text-[10px] text-ink-600">{count() > 0 ? count() : ""}</span>
                          <button
                            onClick={(e) => deleteProject(p.id, e)}
                            class="opacity-0 group-hover:opacity-100 p-0.5 text-ink-600 hover:text-rose-400 cursor-pointer"
                            title="Remove project"
                          >
                            <Iconify icon="lucide:x" size={12} />
                          </button>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </div>

            {/* Conversations do projeto ativo */}
            <div>
              <div class="px-1.5 pb-1 text-[11px] font-medium text-ink-500 truncate">
                {activeProject() ? activeProject()?.name : "Conversations"}
              </div>
              <div class="space-y-0.5">
                <For
                  each={filteredSessions().slice().sort((a, b) => b.updatedAt - a.updatedAt)}
                  fallback={
                    <div class="px-2.5 py-3 text-xs text-ink-600 leading-relaxed">
                      {projects().length === 0
                        ? "Create a project first, then start a conversation inside it."
                        : "No conversations yet. Start one above."}
                    </div>
                  }
                >
                  {(s) => {
                    const isActive = () => s.id === activeSessionId();
                    return (
                      <div
                        onClick={() => selectSession(s.id)}
                        class={`group flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer text-[13px] transition-colors ${
                          isActive() ? "bg-ink-800 text-ink-50" : "text-ink-400 hover:bg-ink-900/60 hover:text-ink-200"
                        }`}
                        title={`${s.title}\n${s.cwd}`}
                      >
                        <span class="truncate flex-1">{s.title}</span>
                        <span class="text-[10px] text-ink-600 shrink-0">{timeAgo(s.updatedAt)}</span>
                        <Show when={s.status === "running"}>
                          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                        </Show>
                        <div class="hidden group-hover:flex items-center shrink-0">
                          <button
                            onClick={(e) => deleteSession(s.id, e)}
                            class="p-0.5 text-ink-600 hover:text-rose-400 cursor-pointer"
                            title="Delete"
                          >
                            <Iconify icon="lucide:trash-2" size={11} />
                          </button>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>
          </div>

          {/* Sidebar Footer: host estilo Antigravity */}
          <div class="p-2 border-t border-line/70 flex items-center gap-2">
            <span class={`w-1.5 h-1.5 rounded-full shrink-0 ${activeHost()?.status === "online" ? "bg-emerald-500" : "bg-amber-500"}`} />
            <span class="text-xs text-ink-300 truncate flex-1 font-medium">{activeHost()?.name || activeHost()?.hostname || "No host"}</span>
            <button
              onClick={loadHosts}
              class="p-1 rounded text-ink-500 hover:text-ink-200 hover:bg-ink-900 cursor-pointer"
              title="Refresh hosts"
            >
              <Iconify icon="lucide:refresh-cw" size={12} />
            </button>
          </div>
        </aside>

        {/* --- Main Chat Stream Container --- */}
        <main class="flex-1 flex flex-col min-w-0 bg-ink-950 relative">
          {/* Offline Banner when selected host is offline */}
          <Show when={activeHost() && activeHost()?.status !== "online"}>
            <div class="bg-amber-500/10 border-b border-amber-500/25 px-4 py-2.5 flex items-center justify-between text-xs text-amber-300 z-10">
              <div class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                <span>
                  Host <strong>{activeHost()?.name || activeHost()?.hostname || activeHost()?.id}</strong> is offline. Start the daemon on your machine: <code class="bg-amber-500/20 px-1 py-0.5 rounded font-mono">./code-daemon</code>
                </span>
              </div>
              <div class="flex items-center gap-2">
                <button
                  onClick={loadHosts}
                  class="text-[11px] underline hover:text-amber-100 cursor-pointer"
                >
                  Refresh
                </button>
                <button
                  onClick={generatePairingToken}
                  class="text-[11px] px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 text-amber-200 cursor-pointer"
                >
                  Connect Another Host
                </button>
              </div>
            </div>
          </Show>

          {/* Collapsible Sidebar Toggle Ribbon */}
          <div class="absolute top-2 left-2 z-20">
            <button
              onClick={() => setSidebarOpen(!sidebarOpen())}
              class="p-1.5 rounded-md bg-ink-900/80 hover:bg-ink-800 border border-line text-ink-400 hover:text-ink-200 transition-colors shadow-sm cursor-pointer"
              title={sidebarOpen() ? "Collapse sidebar" : "Expand sidebar"}
            >
              <Iconify
                icon={
                  sidebarOpen()
                    ? "lucide:chevron-right"
                    : "lucide:chevron-down"
                }
                size={14}
              />
            </button>
          </div>

          {/* Chat Stream Viewport */}
          <div
            ref={setChatContainerRef}
            class="flex-1 overflow-y-auto px-4 md:px-8 py-6 space-y-6 select-text"
          >
            {/* Empty state estilo Antigravity: só projeto + hint */}
            <Show when={messages().length === 0 && !activeSessionId()}>
              <div class="max-w-xl mx-auto my-16 text-center">
                <Show
                  when={activeProject()}
                  fallback={
                    <div class="space-y-3">
                      <div class="text-sm text-ink-300 font-medium">No project selected</div>
                      <p class="text-xs text-ink-500 max-w-sm mx-auto leading-relaxed">
                        Projects are just folders on the host. Select one to group its conversations — like Antigravity.
                      </p>
                      <button
                        onClick={() => setShowNewProjectModal(true)}
                        class="mt-2 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-ink-100 text-ink-950 text-[13px] font-medium hover:bg-white cursor-pointer"
                      >
                        <Iconify icon="lucide:folder-plus" size={14} />
                        <span>Select project folder</span>
                      </button>
                    </div>
                  }
                >
                  <div class="space-y-3">
                    <button
                      onClick={() => setShowNewProjectModal(true)}
                      class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-ink-900 border border-line/70 text-xs text-ink-300 hover:text-ink-100 cursor-pointer"
                      title={activeProject()?.path}
                    >
                      <Iconify icon="lucide:folder" size={13} />
                      <span>{activeProject()?.name}</span>
                      <Iconify icon="lucide:chevron-down" size={12} />
                    </button>
                    <p class="text-xs text-ink-500">
                      Start a conversation in <span class="text-ink-300 font-mono">{activeProject()?.path}</span> below.
                    </p>
                  </div>
                </Show>
              </div>
            </Show>

            {/* Conversation Messages */}
            <For each={messages()}>
              {(msg) => (
                <div
                  class={`flex flex-col max-w-4xl mx-auto ${
                    msg.role === "user" ? "items-end" : "items-start"
                  }`}
                >
                  {/* Message Bubble Container */}
                  <div
                    class={`w-full rounded-2xl p-4 transition-all ${
                      msg.role === "user"
                        ? "bg-ink-900/90 border border-line max-w-2xl text-ink-100"
                        : "bg-transparent text-ink-200"
                    }`}
                  >
                    {/* Header with avatar & role badge */}
                    <div class="flex items-center gap-2 mb-2">
                      <span
                        class={`w-6 h-6 rounded-md flex items-center justify-center text-xs font-semibold ${
                          msg.role === "user"
                            ? "bg-brand-500 text-white"
                            : "bg-ink-800 text-brand-400 border border-brand-500/20"
                        }`}
                      >
                        <Iconify
                          icon={
                            msg.role === "user"
                              ? "lucide:terminal"
                              : "lucide:bot"
                          }
                          size={13}
                        />
                      </span>
                      <span class="text-xs font-medium text-ink-300">
                        {msg.role === "user" ? "You" : "Agent"}
                      </span>
                    </div>

                    {/* Content Blocks (Text, Reasoning, Tool Calls, Tool Results) */}
                    <div class="space-y-3">
                      <For each={msg.blocks}>
                        {(block) => {
                          if (block.type === "text" && block.text) {
                            return (
                              <div
                                class="prose prose-invert max-w-none text-sm leading-relaxed overflow-x-auto"
                                innerHTML={renderMarkdown(block.text)}
                              />
                            );
                          }

                          if (block.type === "reasoning" && block.reasoning) {
                            return (
                              <details class="rounded-xl border border-line/80 bg-ink-900/40 p-3 text-xs text-ink-400">
                                <summary class="cursor-pointer font-medium text-ink-300 flex items-center gap-2 select-none">
                                  <Iconify icon="lucide:cpu" size={13} class="text-brand-400" />
                                  <span>Thought Process</span>
                                </summary>
                                <div class="mt-2 pl-4 border-l-2 border-line text-ink-400 whitespace-pre-wrap font-mono text-[11px]">
                                  {block.reasoning}
                                </div>
                              </details>
                            );
                          }

                          if (block.type === "tool_call") {
                            return (
                              <div class="rounded-xl border border-line bg-ink-900/90 overflow-hidden font-mono text-xs my-2 shadow-sm">
                                <div class="bg-ink-800/80 px-3 py-1.5 border-b border-line flex items-center justify-between">
                                  <div class="flex items-center gap-2 text-brand-400 font-semibold">
                                    <Iconify
                                      icon={
                                        block.toolName === "bash"
                                          ? "lucide:terminal"
                                          : block.toolName === "read"
                                            ? "lucide:file-text"
                                            : block.toolName === "write" ||
                                                block.toolName === "edit"
                                              ? "lucide:code"
                                              : "lucide:wrench"
                                      }
                                      size={13}
                                    />
                                    <span>tool: {block.toolName}</span>
                                  </div>
                                  <span class="text-[10px] text-ink-500">
                                    id: {block.toolId}
                                  </span>
                                </div>
                                <div class="p-3 bg-ink-950/60 overflow-x-auto text-[11px] text-ink-300 whitespace-pre-wrap">
                                  {block.toolArgs}
                                </div>
                              </div>
                            );
                          }

                          if (block.type === "tool_result") {
                            return (
                              <div class="rounded-xl border border-line/70 bg-ink-950 overflow-hidden font-mono text-xs my-2">
                                <div class="bg-ink-900 px-3 py-1 border-b border-line/60 flex items-center justify-between text-[11px] text-ink-400">
                                  <div class="flex items-center gap-1.5">
                                    <Iconify
                                      icon={
                                        block.isError
                                          ? "lucide:x"
                                          : "lucide:check"
                                      }
                                      size={12}
                                      class={
                                        block.isError
                                          ? "text-rose-400"
                                          : "text-emerald-400"
                                      }
                                    />
                                    <span>
                                      Output (
                                      {block.isError ? "Error" : "Success"})
                                    </span>
                                  </div>
                                  <button
                                    onClick={() =>
                                      copyWithToast(block.toolResult || "")
                                    }
                                    class="text-ink-500 hover:text-ink-300 p-0.5"
                                    title="Copy output"
                                  >
                                    <Iconify icon="lucide:copy" size={11} />
                                  </button>
                                </div>
                                <pre class="p-3 text-[11px] text-ink-300 overflow-x-auto max-h-64 whitespace-pre-wrap">
                                  {block.toolResult}
                                </pre>
                              </div>
                            );
                          }

                          return null;
                        }}
                      </For>
                    </div>
                  </div>
                </div>
              )}
            </For>

            {/* Pending Tool Approval Banner (Safe Mode) */}
            <Show when={pendingApproval()}>
              <div class="max-w-3xl mx-auto rounded-2xl border-2 border-amber-500/60 bg-amber-500/10 p-4 shadow-xl backdrop-blur">
                <div class="flex items-center gap-2.5 text-amber-400 font-semibold text-sm">
                  <Iconify icon="lucide:shield" size={18} />
                  <span>Action Approval Required</span>
                  <span class="text-xs font-normal text-amber-300/80">
                    (Safe mode active)
                  </span>
                </div>

                <div class="mt-2 bg-ink-950/80 rounded-xl p-3 border border-amber-500/30 font-mono text-xs text-ink-200">
                  <div class="text-amber-400 font-bold mb-1">
                    Tool: {pendingApproval()?.tool}
                  </div>
                  <pre class="text-[11px] text-ink-300 overflow-x-auto whitespace-pre-wrap max-h-48">
                    {pendingApproval()?.args}
                  </pre>
                </div>

                <div class="mt-3 flex items-center justify-between">
                  <span class="text-xs text-ink-400">
                    Approve execution on host machine?
                  </span>
                  <div class="flex items-center gap-2">
                    <button
                      onClick={() => respondApproval(false)}
                      class="px-3 py-1.5 rounded-lg bg-rose-500/20 text-rose-300 hover:bg-rose-500/30 border border-rose-500/40 text-xs font-medium transition-colors"
                    >
                      Reject
                    </button>
                    <button
                      onClick={() => respondApproval(true)}
                      class="px-4 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 text-xs font-semibold shadow-sm transition-colors"
                    >
                      Approve & Execute
                    </button>
                    <button
                      onClick={() => {
                        setYoloMode(true);
                        respondApproval(true);
                      }}
                      class="px-3 py-1.5 rounded-lg bg-amber-500 text-ink-950 hover:bg-amber-400 text-xs font-bold transition-colors"
                    >
                      Always Approve (YOLO)
                    </button>
                  </div>
                </div>
              </div>
            </Show>
          </div>

          {/* Composer estilo Antigravity */}
          <div class="px-4 pb-4 pt-2 bg-ink-950 relative z-20">
            {/* Slash Command Autocomplete Menu */}
            <Show when={slashMatches().length > 0}>
              <div class="absolute bottom-full left-4 right-4 md:left-8 md:right-8 mb-2 rounded-xl border border-line bg-ink-900/95 shadow-2xl p-1.5 max-h-60 overflow-y-auto z-40 backdrop-blur">
                <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-500 tracking-wider">
                  Slash Commands
                </div>
                <For each={slashMatches()}>
                  {(sc, idx) => (
                    <button
                      onClick={() => {
                        setInputPrompt(sc.cmd + " ");
                      }}
                      class={`w-full text-left px-3 py-2 rounded-lg text-xs flex items-center justify-between transition-colors ${
                        idx() === slashIndex()
                          ? "bg-ink-100 text-ink-950"
                          : "text-ink-200 hover:bg-ink-800"
                      }`}
                    >
                      <div class="flex items-center gap-2 font-mono font-semibold">
                        <span>{sc.cmd}</span>
                        <span class="text-[11px] opacity-70">{sc.args}</span>
                      </div>
                      <span class="text-[11px] opacity-80">{sc.desc}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <div class="max-w-2xl mx-auto">
              <Show when={activeProject()}>
                <div class="flex justify-center pb-2">
                  <span class="inline-flex items-center gap-1.5 text-xs text-ink-400">
                    <Iconify icon="lucide:folder" size={12} />
                    <span>{activeProject()?.name}</span>
                    <Iconify icon="lucide:chevron-down" size={11} />
                  </span>
                </div>
              </Show>
              <div class="rounded-2xl border border-line/70 bg-ink-900/80 shadow-xl focus-within:border-ink-500 transition-colors overflow-hidden">
                <textarea
                  class="w-full bg-transparent text-[13px] text-ink-100 placeholder:text-ink-500 focus:outline-none resize-none px-4 pt-3 max-h-48 min-h-[48px]"
                  placeholder={
                    activeSession()
                      ? `Ask anything, @ to mention, / for actions`
                      : projects().length === 0
                        ? "Select a project folder first..."
                        : "Start a New Conversation to begin..."
                  }
                  value={inputPrompt()}
                  onInput={(e) => setInputPrompt(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (slashMatches().length > 0) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setSlashIndex((prev) =>
                        Math.min(prev + 1, slashMatches().length - 1),
                      );
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setSlashIndex((prev) => Math.max(prev - 1, 0));
                      return;
                    }
                    if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                      e.preventDefault();
                      const pick = slashMatches()[slashIndex()];
                      if (pick) {
                        setInputPrompt(pick.cmd + " ");
                      }
                      return;
                    }
                  }

                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendPrompt();
                  }
                }}
              />

              <div class="flex items-center justify-between px-3 pb-2.5 pt-1">
                <div class="flex items-center gap-1 text-xs text-ink-400">
                  <button
                    onClick={() => toast("Attachments em breve", "info")}
                    class="w-6 h-6 rounded-full hover:bg-ink-800 flex items-center justify-center cursor-pointer"
                    title="Add"
                  >
                    <Iconify icon="lucide:plus" size={14} />
                  </button>
                  <span class="font-medium">{activeModel().split("/").pop()}</span>
                  <Iconify icon="lucide:chevron-down" size={11} />
                </div>

                <div class="flex items-center gap-2">
                  <Show when={sessionStatus() === "running"}>
                    <button
                      onClick={cancelCurrentTurn}
                      class="w-7 h-7 rounded-full bg-ink-700 text-ink-100 hover:bg-ink-600 flex items-center justify-center transition-colors cursor-pointer"
                      title="Stop"
                    >
                      <Iconify icon="lucide:square" size={13} />
                    </button>
                  </Show>

                  <button
                    onClick={() => {
                      if (!activeSessionId() && activeProject()) openNewSessionModal();
                      else sendPrompt();
                    }}
                    disabled={
                      (!inputPrompt().trim() && !!activeSessionId()) ||
                      sessionStatus() === "running"
                    }
                    class="w-7 h-7 rounded-full bg-ink-100 text-ink-950 hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition-all cursor-pointer"
                    title={!activeSessionId() ? "New conversation" : "Send"}
                  >
                    <Iconify icon="lucide:arrow-right" size={14} />
                  </button>
                </div>
              </div>
              <div class="flex items-center justify-between px-4 pb-2 text-[11px] text-ink-600">
                <span class="flex items-center gap-1">
                  <Iconify icon="lucide:hard-drive" size={11} />
                  <span>{yoloMode() ? "YOLO" : "Local"}</span>
                </span>
                <button
                  onClick={() => setYoloMode(!yoloMode())}
                  class="hover:text-ink-300 cursor-pointer"
                  title="Toggle Safe/YOLO"
                >
                  {yoloMode() ? "YOLO Agent" : "Main Agent"} ▾
                </button>
              </div>
            </div>
            </div>
          </div>
        </main>
      </div>
      </Show>

      {/* Modal: New Project (pasta no host) */}
      <Modal
        open={showNewProjectModal()}
        onClose={() => setShowNewProjectModal(false)}
        title="Select project folder"
      >
        <div class="space-y-4">
          <p class="text-xs text-ink-400 leading-relaxed">
            A project is just a folder on the host <span class="font-mono text-ink-200">{activeHost()?.name || ""}</span>. Conversations created inside it share that root.
          </p>
          <div>
            <label class="block text-xs font-medium text-ink-300 mb-1">
              Folder path on host
            </label>
            <input
              type="text"
              class="w-full bg-ink-900 border border-line rounded-xl px-3 py-2 text-sm text-ink-100 focus:outline-none focus:border-ink-400 font-mono"
              placeholder="/home/user/workspace/my-project"
              value={newProjectPath()}
              onInput={(e) => setNewProjectPath(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createProject();
              }}
            />
          </div>
          <div class="flex justify-end gap-2 pt-1">
            <button
              onClick={() => setShowNewProjectModal(false)}
              class="px-4 py-2 rounded-xl text-xs text-ink-400 hover:text-ink-100 hover:bg-ink-800 cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={createProject}
              class="px-5 py-2 rounded-xl bg-ink-100 text-ink-950 text-xs font-semibold hover:bg-white cursor-pointer"
            >
              Add project
            </button>
          </div>
        </div>
      </Modal>

      {/* Modal: New Conversation */}
      <Modal
        open={showNewSessionModal()}
        onClose={() => setShowNewSessionModal(false)}
        title={`New conversation${activeProject() ? ` in ${activeProject()?.name}` : ""}`}
      >
          <div class="space-y-4">
            <div>
              <label class="block text-xs font-semibold text-ink-300 mb-1">
                Working Directory (Path on Host)
              </label>
              <input
                type="text"
                class="w-full bg-ink-900 border border-line rounded-xl px-3 py-2 text-sm text-ink-100 focus:outline-none focus:border-brand-500"
                placeholder="/home/user/my-project or ~/workspace"
                value={newSessionCwd()}
                onInput={(e) => setNewSessionCwd(e.currentTarget.value)}
              />
              <p class="text-[11px] text-ink-500 mt-1">
                Agent tools (read, write, bash) execute inside this folder.
              </p>
            </div>

            <div>
              <label class="block text-xs font-semibold text-ink-300 mb-1">
                Session Title (Optional)
              </label>
              <input
                type="text"
                class="w-full bg-ink-900 border border-line rounded-xl px-3 py-2 text-sm text-ink-100 focus:outline-none focus:border-brand-500"
                placeholder="e.g. Refactor Auth Flow"
                value={newSessionTitle()}
                onInput={(e) => setNewSessionTitle(e.currentTarget.value)}
              />
            </div>

            <div class="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setShowNewSessionModal(false)}
                class="px-4 py-2 rounded-xl text-xs text-ink-400 hover:text-ink-100 hover:bg-ink-800 cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={createNewSession}
                class="px-5 py-2 rounded-xl bg-ink-100 text-ink-950 text-xs font-semibold hover:bg-white cursor-pointer"
              >
                Start conversation
              </button>
            </div>
          </div>
        </Modal>

      {/* Modal: Pair Daemon Host */}
      <Modal
        open={showPairModal()}
        title="Pair Remote Daemon Host"
        onClose={() => setShowPairModal(false)}
      >
          <div class="space-y-4 text-xs">
            <p class="text-ink-400">
              Run the following command on your target machine to pair it with your
              LLM Gateway account:
            </p>

            <Show when={pairingData()}>
              {(p) => {
                const cmd = `./llmgw-daemon -connect "${p().connectUrl}"`;
                return (
                  <div class="space-y-3">
                    <div class="space-y-1">
                      <div class="text-[11px] text-ink-300 font-medium">1. Run daemon with connection flag:</div>
                      <div class="p-3 bg-ink-950 rounded-xl border border-line font-mono text-[11px] text-ink-200 flex items-center justify-between gap-2">
                        <span class="truncate">{cmd}</span>
                        <button
                          onClick={() => copyWithToast(cmd)}
                          class="p-1.5 rounded-lg bg-ink-800 hover:bg-ink-700 text-ink-200 shrink-0 cursor-pointer"
                          title="Copy command"
                        >
                          <Iconify icon="lucide:copy" size={14} />
                        </button>
                      </div>
                    </div>

                    <div class="space-y-1">
                      <div class="text-[11px] text-ink-300 font-medium">Or paste Connection URL when prompted:</div>
                      <div class="p-2.5 bg-ink-950 rounded-xl border border-line font-mono text-[11px] text-ink-200 flex items-center justify-between gap-2">
                        <span class="truncate">{p().connectUrl}</span>
                        <button
                          onClick={() => copyWithToast(p().connectUrl)}
                          class="p-1.5 rounded-lg bg-ink-800 hover:bg-ink-700 text-ink-200 shrink-0 cursor-pointer"
                          title="Copy URL"
                        >
                          <Iconify icon="lucide:copy" size={14} />
                        </button>
                      </div>
                    </div>

                    <div class="p-3 rounded-xl bg-ink-900 border border-line/60 text-ink-400 space-y-1 text-[11px]">
                      <div class="font-semibold text-ink-200">Quick steps:</div>
                      <div>1. Run the command or paste the URL into your daemon.</div>
                      <div>2. The daemon pairs with your account and obtains host credentials.</div>
                      <div>3. The host connects via WebSocket and appears online immediately.</div>
                    </div>
                  </div>
                );
              }}
            </Show>

            <div class="flex justify-end pt-2">
              <button
                onClick={() => setShowPairModal(false)}
                class="px-4 py-2 rounded-xl bg-ink-100 text-ink-950 text-xs font-semibold hover:bg-white cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </Modal>

      {/* Modal: Code Remote Configuration, MCP & Skills Center */}
      <Modal
        open={showConfigModal()}
        title="Code Remote Configuration Center"
        onClose={() => setShowConfigModal(false)}
      >
          <div class="w-full max-w-2xl space-y-4">
            {/* Tabs Header */}
            <div class="flex border-b border-line gap-1">
              <button
                onClick={() => setConfigTab("settings")}
                class={`px-3 py-2 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
                  configTab() === "settings"
                    ? "border-brand-500 text-brand-400"
                    : "border-transparent text-ink-400 hover:text-ink-200"
                }`}
              >
                Agent Settings
              </button>
              <button
                onClick={() => setConfigTab("mcp")}
                class={`px-3 py-2 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 cursor-pointer ${
                  configTab() === "mcp"
                    ? "border-brand-500 text-brand-400"
                    : "border-transparent text-ink-400 hover:text-ink-200"
                }`}
              >
                <span>MCP Servers</span>
                <span class="px-1.5 py-0.2 rounded-full bg-ink-800 text-[10px]">
                  {Object.keys(mcpServers()).length}
                </span>
              </button>
              <button
                onClick={() => setConfigTab("skills")}
                class={`px-3 py-2 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 cursor-pointer ${
                  configTab() === "skills"
                    ? "border-brand-500 text-brand-400"
                    : "border-transparent text-ink-400 hover:text-ink-200"
                }`}
              >
                <span>Skills</span>
                <span class="px-1.5 py-0.2 rounded-full bg-ink-800 text-[10px]">
                  {Object.keys(skills()).length}
                </span>
              </button>
              <button
                onClick={() => setConfigTab("slash")}
                class={`px-3 py-2 text-xs font-semibold border-b-2 transition-colors cursor-pointer ${
                  configTab() === "slash"
                    ? "border-brand-500 text-brand-400"
                    : "border-transparent text-ink-400 hover:text-ink-200"
                }`}
              >
                Slash Commands
              </button>
            </div>

            {/* TAB 1: AGENT SETTINGS */}
            <Show when={configTab() === "settings"}>
              <div class="space-y-4 text-xs">
                <div>
                  <label class="block font-semibold text-ink-200 mb-1">
                    Default Model
                  </label>
                  <select
                    class="w-full bg-ink-900 border border-line rounded-xl px-3 py-2 text-ink-100 focus:outline-none"
                    value={daemonSettings().model}
                    onChange={(e) =>
                      setDaemonSettings({
                        ...daemonSettings(),
                        model: e.currentTarget.value,
                      })
                    }
                  >
                    <For each={gatewayModels()}>
                      {(m) => <option value={m.id}>{m.name || m.id}</option>}
                    </For>
                  </select>
                </div>

                <div class="grid grid-cols-2 gap-4">
                  <div>
                    <label class="block font-semibold text-ink-200 mb-1">
                      Reasoning Effort
                    </label>
                    <div class="grid grid-cols-4 gap-1 bg-ink-900 p-1 rounded-xl border border-line">
                      <For each={["off", "low", "medium", "high"]}>
                        {(lvl) => (
                          <button
                            onClick={() =>
                              setDaemonSettings({
                                ...daemonSettings(),
                                reasoning: lvl,
                              })
                            }
                            class={`py-1 rounded-lg text-center font-medium capitalize transition-colors ${
                              daemonSettings().reasoning === lvl
                                ? "bg-brand-500 text-white"
                                : "text-ink-400 hover:text-ink-200"
                            }`}
                          >
                            {lvl}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>

                  <div>
                    <label class="block font-semibold text-ink-200 mb-1">
                      Temperature ({daemonSettings().temperature.toFixed(2)})
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      class="w-full cursor-pointer accent-brand-500"
                      value={daemonSettings().temperature}
                      onInput={(e) =>
                        setDaemonSettings({
                          ...daemonSettings(),
                          temperature: parseFloat(e.currentTarget.value),
                        })
                      }
                    />
                  </div>
                </div>

                <div class="space-y-2 pt-2 border-t border-line/60">
                  <label class="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={daemonSettings().jailByDefault}
                      onChange={(e) =>
                        setDaemonSettings({
                          ...daemonSettings(),
                          jailByDefault: e.currentTarget.checked,
                        })
                      }
                      class="rounded accent-brand-500"
                    />
                    <span class="text-ink-200 font-medium">
                      Strict Sandbox Jail (Confine tools strictly to session CWD)
                    </span>
                  </label>

                  <label class="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={daemonSettings().autoSwarmEnabled}
                      onChange={(e) =>
                        setDaemonSettings({
                          ...daemonSettings(),
                          autoSwarmEnabled: e.currentTarget.checked,
                        })
                      }
                      class="rounded accent-brand-500"
                    />
                    <span class="text-ink-200 font-medium">
                      Auto-Swarm (Allow agent to spawn parallel sub-agents)
                    </span>
                  </label>
                </div>

                <div class="flex justify-end pt-3">
                  <button
                    onClick={saveDaemonConfig}
                    class="px-5 py-2 rounded-xl bg-brand-500 text-white font-semibold hover:bg-brand-600"
                  >
                    Save Settings
                  </button>
                </div>
              </div>
            </Show>

            {/* TAB 2: MCP SERVERS */}
            <Show when={configTab() === "mcp"}>
              <div class="space-y-4 text-xs">
                <div class="border border-line rounded-xl p-3 bg-ink-900/50 space-y-2">
                  <div class="font-semibold text-ink-200 text-xs">
                    Add Model Context Protocol (MCP) Server
                  </div>
                  <div class="grid grid-cols-3 gap-2">
                    <input
                      type="text"
                      placeholder="Server name (e.g. github)"
                      class="bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100"
                      value={newMcpName()}
                      onInput={(e) => setNewMcpName(e.currentTarget.value)}
                    />
                    <select
                      class="bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100"
                      value={newMcpTransport()}
                      onChange={(e) => setNewMcpTransport(e.currentTarget.value)}
                    >
                      <option value="stdio">stdio (Local binary)</option>
                      <option value="sse">SSE (Server-Sent Events)</option>
                      <option value="http">HTTP</option>
                    </select>
                    <input
                      type="text"
                      placeholder="Command (e.g. npx, uvx)"
                      class="bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100"
                      value={newMcpCmd()}
                      onInput={(e) => setNewMcpCmd(e.currentTarget.value)}
                    />
                  </div>
                  <input
                    type="text"
                    placeholder="Arguments (e.g. -y @modelcontextprotocol/server-filesystem /path)"
                    class="w-full bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100"
                    value={newMcpArgs()}
                    onInput={(e) => setNewMcpArgs(e.currentTarget.value)}
                  />
                  <div class="flex justify-end">
                    <button
                      onClick={handleAddMcpServer}
                      class="px-4 py-1.5 rounded-lg bg-brand-500 text-white font-medium hover:bg-brand-600"
                    >
                      Add MCP Server
                    </button>
                  </div>
                </div>

                {/* Configured MCP Servers List */}
                <div class="space-y-2">
                  <div class="font-semibold text-ink-300">
                    Active MCP Servers ({Object.keys(mcpServers()).length})
                  </div>
                  <For
                    each={Object.entries(mcpServers())}
                    fallback={
                      <div class="text-ink-600 py-4 text-center">
                        No MCP servers configured yet.
                      </div>
                    }
                  >
                    {([name, srv]) => (
                      <div class="p-3 rounded-xl border border-line bg-ink-900 flex items-center justify-between">
                        <div>
                          <div class="font-semibold text-ink-100 flex items-center gap-2">
                            <span>{name}</span>
                            <span class="px-1.5 py-0.2 rounded bg-ink-800 text-[10px] text-ink-400">
                              {srv.transport}
                            </span>
                          </div>
                          <div class="text-[11px] font-mono text-ink-400 mt-0.5">
                            {srv.command} {srv.args?.join(" ")}
                          </div>
                        </div>
                        <button
                          onClick={() => handleDeleteMcpServer(name)}
                          class="p-1.5 text-rose-400 hover:bg-rose-500/10 rounded-lg"
                        >
                          <Iconify icon="lucide:trash-2" size={14} />
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* TAB 3: SKILLS */}
            <Show when={configTab() === "skills"}>
              <div class="space-y-4 text-xs">
                {/* Built-in Tools Summary */}
                <div class="p-3 rounded-xl bg-ink-900/60 border border-line/60">
                  <div class="font-semibold text-ink-300 mb-1">
                    Built-in Local Tools
                  </div>
                  <div class="grid grid-cols-3 gap-2 text-[11px] text-ink-400 font-mono">
                    <div>• read (view files)</div>
                    <div>• write (create files)</div>
                    <div>• edit (modify files)</div>
                    <div>• bash (shell runner)</div>
                    <div>• glob (file search)</div>
                  </div>
                </div>

                {/* Add Custom Skill */}
                <div class="border border-line rounded-xl p-3 bg-ink-900/50 space-y-2">
                  <div class="font-semibold text-ink-200">
                    Create Custom Skill / Prompt Instruction
                  </div>
                  <div class="grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      placeholder="Skill name (e.g. pr-reviewer)"
                      class="bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100"
                      value={newSkillName()}
                      onInput={(e) => setNewSkillName(e.currentTarget.value)}
                    />
                    <input
                      type="text"
                      placeholder="Description"
                      class="bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100"
                      value={newSkillDesc()}
                      onInput={(e) => setNewSkillDesc(e.currentTarget.value)}
                    />
                  </div>
                  <textarea
                    placeholder="Instructions body for the agent..."
                    class="w-full bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100 h-20 resize-none"
                    value={newSkillBody()}
                    onInput={(e) => setNewSkillBody(e.currentTarget.value)}
                  />
                  <div class="flex justify-end">
                    <button
                      onClick={handleAddSkill}
                      class="px-4 py-1.5 rounded-lg bg-brand-500 text-white font-medium hover:bg-brand-600"
                    >
                      Save Skill
                    </button>
                  </div>
                </div>

                {/* Custom Skills List */}
                <div class="space-y-2">
                  <div class="font-semibold text-ink-300">
                    Custom Skills ({Object.keys(skills()).length})
                  </div>
                  <For
                    each={Object.entries(skills())}
                    fallback={
                      <div class="text-ink-600 py-4 text-center">
                        No custom skills configured yet.
                      </div>
                    }
                  >
                    {([name, sk]) => (
                      <div class="p-3 rounded-xl border border-line bg-ink-900 flex items-center justify-between">
                        <div>
                          <div class="font-semibold text-ink-100 flex items-center gap-2">
                            <span>{name}</span>
                            <span
                              class={`px-1.5 py-0.2 rounded text-[10px] ${
                                sk.enabled
                                  ? "bg-emerald-500/20 text-emerald-400"
                                  : "bg-ink-800 text-ink-500"
                              }`}
                            >
                              {sk.enabled ? "Active" : "Disabled"}
                            </span>
                          </div>
                          <div class="text-[11px] text-ink-400 mt-0.5">
                            {sk.description}
                          </div>
                        </div>
                        <div class="flex items-center gap-2">
                          <button
                            onClick={() => toggleSkill(name)}
                            class="px-2.5 py-1 rounded-md bg-ink-800 hover:bg-ink-700 text-ink-300 text-[11px]"
                          >
                            {sk.enabled ? "Disable" : "Enable"}
                          </button>
                          <button
                            onClick={() => handleDeleteSkill(name)}
                            class="p-1.5 text-rose-400 hover:bg-rose-500/10 rounded-lg"
                          >
                            <Iconify icon="lucide:trash-2" size={14} />
                          </button>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* TAB 4: SLASH COMMANDS REFERENCE */}
            <Show when={configTab() === "slash"}>
              <div class="space-y-2 text-xs max-h-80 overflow-y-auto">
                <For each={SLASH_COMMANDS}>
                  {(sc) => (
                    <div class="p-2.5 rounded-xl border border-line bg-ink-900/60 flex items-center justify-between">
                      <div>
                        <div class="font-mono font-bold text-brand-400 flex items-center gap-2">
                          <span>{sc.cmd}</span>
                          <span class="text-ink-500 font-normal">{sc.args}</span>
                        </div>
                        <div class="text-[11px] text-ink-400 mt-0.5">
                          {sc.desc}
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          setShowConfigModal(false);
                          executeSlashCommand(sc.cmd);
                        }}
                        class="px-2.5 py-1 rounded-lg bg-ink-800 hover:bg-brand-500 hover:text-white text-ink-300 font-medium transition-colors"
                      >
                        Run
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Modal>
    </div>
  );
}
