import {
  createSignal,
  createEffect,
  createMemo,
  onMount,
  onCleanup,
  For,
  Show,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import { Streamdown } from "streamdown-solid";
import type { Placement } from "@floating-ui/dom";
import {
  api,
  currentSession,
  type RemoteHostDto,
  type RemotePairDto,
} from "../api";
import {
  createDataLayer,
  type RcProject,
  type RcSession,
} from "../rcStore";
import {
  Modal,
  Select,
  ThemeToggle,
  copyWithToast,
  toast,
} from "../ui";

import { Icon as Iconify } from "../components/icon";
import { anchorFloat } from "../floating";

/** Local popover menu on the shared floating-ui layer (Portal + flip/shift). */
function FloatMenu(props: {
  anchor: () => HTMLElement | null | undefined;
  open: boolean;
  placement?: Placement;
  width?: string;
  children: JSX.Element;
}) {
  return (
    <Show when={props.open}>
      <Portal>
        <div
          ref={(el) => {
            const a = props.anchor();
            if (!a) return;
            onCleanup(anchorFloat(a, el, { placement: props.placement ?? "bottom-start" }));
          }}
          data-floatmenu
          class="anim-float-in rounded-xl border border-line bg-ink-900 shadow-2xl p-1.5 text-xs"
          style={props.width ? { width: props.width } : undefined}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {props.children}
        </div>
      </Portal>
    </Show>
  );
}

/**
 * Interfaces
 */

/** Mirrored daemon data comes from the SignalDB layer (RcSession/RcProject). */
export type SessionSummary = RcSession;
type Project = RcProject;

export interface ContentBlock {
  type: "text" | "tool_call" | "tool_result" | "reasoning" | "image";
  text?: string;
  toolId?: string;
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
  toolProgress?: string;
  isError?: boolean;
  reasoning?: string;
  imageMime?: string;
  imageData?: string;
}

export interface SessionUsage {
  inTok: number;
  outTok: number;
  cacheTok: number;
  reasoningTok: number;
  costUsd: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  blocks: ContentBlock[];
  time?: number;
  attachments?: string[];
  thinkingDuration?: number;
  /** Synthetic transcript notices (e.g. auto-compaction summaries). */
  system?: boolean;
  /**
   * Index of the source message in the daemon's raw transcript. Display
   * normalization merges/drops raw messages (tool results are hoisted onto
   * their assistant carrier), so per-message ops (edit/delete/regenerate)
   * must send this index, never the rendered position.
   */
  srcIdx?: number;
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
  noAutoTitle: boolean;
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
// Only commands NOT already configurable somewhere in the UI are listed:
// model + reasoning effort live in the composer picker / Settings modal.
const SLASH_COMMANDS = [
  {
    cmd: "/compact",
    desc: "Compact conversation transcript to free up context tokens",
    args: "",
  },
  {
    cmd: "/clear",
    desc: "Start a fresh blank session (history is kept)",
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

/**
 * Tool presentation helpers (Antigravity-style one-line rows).
 * The daemon persists raw call args + results; everything human-readable
 * below is derived locally so transcripts stay exact.
 */

export function tryParseArgs(a?: string): any {
  if (!a) return {};
  try {
    return JSON.parse(a);
  } catch {
    return { _raw: a };
  }
}

export function baseNameOf(p?: string): string {
  if (!p) return "";
  const t = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i >= 0 ? t.slice(i + 1) : t;
}

export function diffStat(text: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const ln of (text || "").split("\n")) {
    if (ln.startsWith("+") && !ln.startsWith("+++")) add++;
    else if (ln.startsWith("-") && !ln.startsWith("---")) del++;
  }
  return { add, del };
}

export interface ToolUnit {
  call?: ContentBlock;
  result?: ContentBlock;
}

/** Pairs each tool_call with its tool_result by call id. */
export function pairToolUnits(blocks: ContentBlock[]): ToolUnit[] {
  const units: ToolUnit[] = [];
  const byId = new Map<string, ToolUnit>();
  for (const b of blocks) {
    if (b.type === "tool_call") {
      const u: ToolUnit = { call: b };
      units.push(u);
      if (b.toolId) byId.set(b.toolId, u);
    } else if (b.type === "tool_result") {
      const u = (b.toolId && byId.get(b.toolId)) || null;
      if (u && !u.result) u.result = b;
      else units.push({ result: b });
    }
  }
  return units;
}

export type ToolCat = "explore" | "command" | "edit" | "other";

export function toolCatOf(name?: string): ToolCat {
  if (name === "read" || name === "glob") return "explore";
  if (name === "bash") return "command";
  if (name === "edit" || name === "write") return "edit";
  return "other";
}

export type MsgPart =
  | { kind: "blocks"; blocks: ContentBlock[] }
  | { kind: "tools"; units: ToolUnit[] };

/** Splits a message into text runs and consecutive tool runs (order kept). */
export function splitToolRuns(blocks: ContentBlock[]): MsgPart[] {
  const parts: MsgPart[] = [];
  let buf: ContentBlock[] = [];
  let run: ToolUnit[] = [];
  const byId = new Map<string, ToolUnit>();
  const flushBuf = () => {
    if (buf.length) {
      parts.push({ kind: "blocks", blocks: buf });
      buf = [];
    }
  };
  const flushRun = () => {
    if (run.length) {
      parts.push({ kind: "tools", units: run });
      run = [];
    }
  };
  for (const b of blocks) {
    if (b.type === "tool_call") {
      flushBuf();
      const u: ToolUnit = { call: b };
      run.push(u);
      if (b.toolId) byId.set(b.toolId, u);
    } else if (b.type === "tool_result") {
      flushBuf();
      const u = (b.toolId && byId.get(b.toolId)) || null;
      if (u && !u.result) u.result = b;
      else run.push({ result: b });
    } else {
      flushRun();
      buf.push(b);
    }
  }
  flushRun();
  flushBuf();
  return parts;
}

export interface ToolSummary {
  icon: string;
  verb: string;
  target: string;
  stat?: string;
  statAdd?: number;
  statDel?: number;
}

/** One-line Antigravity-style summary for a tool unit. */
export function toolSummary(u: ToolUnit): ToolSummary {
  const name = u.call?.toolName || "tool";
  const args = tryParseArgs(u.call?.toolArgs);
  const res = u.result?.toolResult || "";
  switch (name) {
    case "read": {
      const off = Number(args.offset || 0);
      const lines = res ? res.split("\n").length : 0;
      const lim = Number(args.limit || 0);
      const end = lim > 0 ? off + lim : off + lines;
      return {
        icon: "lucide:file-text",
        verb: "Analyzed",
        target: `${baseNameOf(args.path) || args.path || "file"}#L${off + 1}-${Math.max(end, off + 1)}`,
      };
    }
    case "glob": {
      const n = res ? res.split("\n").filter((l) => l.trim()).length : 0;
      return {
        icon: "lucide:search",
        verb: "Searched",
        target: String(args.pattern || ""),
        stat: n > 0 ? `${n} match${n === 1 ? "" : "es"}` : undefined,
      };
    }
    case "bash": {
      const cmd = String(args.command || "").replace(/\s+/g, " ").trim();
      return {
        icon: "lucide:terminal",
        verb: "Ran",
        target: cmd.length > 90 ? cmd.slice(0, 90) + "…" : cmd,
      };
    }
    case "write": {
      const content = String(args.content || "");
      const n = content ? content.split("\n").length : 0;
      return {
        icon: "lucide:file-text",
        verb: "Created",
        target: baseNameOf(args.path) || args.path || "file",
        stat: n > 0 ? `${n} lines` : undefined,
      };
    }
    case "edit": {
      const st = diffStat(res);
      return {
        icon: "lucide:pencil",
        verb: "Edited",
        target: baseNameOf(args.path) || args.path || "file",
        statAdd: st.add,
        statDel: st.del,
      };
    }
    default:
      return { icon: "lucide:wrench", verb: name, target: "" };
  }
}

/** Renders a unified context diff (daemon edit results) red/green. */
export function DiffView(props: { text: string; max?: number }) {
  const [expanded, setExpanded] = createSignal(false);
  const lines = () => (props.text || "").split("\n");
  const shown = () => {
    const all = lines();
    const max = props.max ?? 80;
    return expanded() ? all : all.slice(0, max);
  };
  const hidden = () => Math.max(0, lines().length - shown().length);
  return (
    <div class="font-mono text-[11px] leading-relaxed overflow-x-auto">
      <For each={shown()}>
        {(ln) => {
          const cls =
            ln.startsWith("+") && !ln.startsWith("+++")
              ? "bg-emerald-500/10 text-emerald-300"
              : ln.startsWith("-") && !ln.startsWith("---")
                ? "bg-rose-500/10 text-rose-300"
                : ln === "..."
                  ? "text-ink-600"
                  : "text-ink-400";
          return <div class={`px-3 whitespace-pre ${cls}`}>{ln || " "}</div>;
        }}
      </For>
      <Show when={hidden() > 0}>
        <button
          onClick={() => setExpanded(true)}
          class="px-3 py-1 text-[11px] text-ink-500 hover:text-ink-200 cursor-pointer"
        >
          +{hidden()} more lines
        </button>
      </Show>
    </div>
  );
}

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

  // UI-only state. Projects / sessions / config are NOT signals here: they
  // are SignalDB collections mirroring the daemon (IndexedDB per host), so
  // they paint instantly from cache and self-correct on every change ping.
  // The page never owns this data — reconnecting from any device/domain
  // shows the very same truth.
  const [activeSessionId, setActiveSessionId] = createSignal<string>("");
  const [sessionFilter, setSessionFilter] = createSignal<string>("");
  // (No "new conversation" modal — sessions are created directly in the
  // active project so the composer at the bottom is the only input.)

  // Projects (Antigravity-style: pasta no host agrupa conversas)
  const [activeProjectId, setActiveProjectId] = createSignal<string>("");
  const [showNewProjectModal, setShowNewProjectModal] = createSignal(false);
  const [newProjectPath, setNewProjectPath] = createSignal("");
  const [projectMenuOpen, setProjectMenuOpen] = createSignal(false);
  // First message queued while the auto-created session is being registered.
  const [pendingFirstText, setPendingFirstText] = createSignal<string | null>(null);

  function pickProject(id: string) {
    setActiveProjectId(id);
  }
  function openNewProjectModal() {
    // With zero projects the home folder is the sane default ("usa o ~").
    setNewProjectPath(projects().length === 0 ? "~" : "");
    setShowNewProjectModal(true);
  }
  function wsOpen() {
    try {
      return !!ws && (ws as WebSocket).readyState === WebSocket.OPEN;
    } catch {
      return false;
    }
  }
  // SignalDB data layer (see rcStore.ts). One store per host, persisted.
  const dataLayer = createDataLayer({
    send: (payload) => sendWS(payload),
    isOpen: wsOpen,
  });
  const store = createMemo(() => {
    const hid = activeHostId();
    return hid ? dataLayer.storeFor(hid) : null;
  });
  const projects = createMemo<Project[]>(() => {
    const st = store();
    if (!st) return [];
    const hid = activeHostId();
    return st.projects
      .find({ hostId: hid })
      .fetch()
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt);
  });
  const sessions = createMemo<SessionSummary[]>(() => {
    const st = store();
    if (!st) return [];
    const hid = activeHostId();
    return st.sessions
      .find({ hostId: hid })
      .fetch()
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });
  const configDoc = createMemo(() => {
    const st = store();
    if (!st) return null;
    return st.config.find({ hostId: activeHostId() }).fetch()[0] ?? null;
  });

  // Chat Transcript & In-Flight State
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [inputPrompt, setInputPrompt] = createSignal("");
  const [activeModel, setActiveModel] = createSignal("gpt-4o");
  const [yoloMode, setYoloMode] = createSignal(true);
  const [sessionStatus, setSessionStatus] = createSignal<"idle" | "running">("idle");
  const [pendingApproval, setPendingApproval] = createSignal<PendingApproval | null>(null);
  // Live usage per session (from daemon usage/turn_end events).
  const [sessionUsage, setSessionUsage] = createSignal<Record<string, SessionUsage>>({});
  /** Usage of the active session, or null — keeps "" session ids out of the union. */
  const activeUsage = createMemo<SessionUsage | null>(() => {
    const id = activeSessionId();
    return id ? (sessionUsage()[id] ?? null) : null;
  });
  // Live tool progress text per tool call id (cleared on result/turn_end).
  const [toolProgress, setToolProgress] = createSignal<Record<string, string>>({});
  // Expanded tool rows / groups (Antigravity chevrons).
  const [toolOpen, setToolOpen] = createSignal<Record<string, boolean>>({});
  const [toolGroupOpen, setToolGroupOpen] = createSignal<Record<string, boolean>>({});
  function toggleToolOpen(key: string) {
    setToolOpen((prev) => ({ ...prev, [key]: !(prev[key] ?? false) }));
  }
  function toggleToolGroup(key: string) {
    setToolGroupOpen((prev) => ({ ...prev, [key]: !(prev[key] ?? true) }));
  }
  // Expanded thinking blocks (message id set).
  const [expandedThinking, setExpandedThinking] = createSignal<Record<string, boolean>>({});
  // Copied-message feedback.
  const [copiedMsgId, setCopiedMsgId] = createSignal<string | null>(null);

  // Appearance (Antigravity-style, persisted per browser).
  const [verboseChat, setVerboseChat] = createSignal(
    (() => {
      try {
        return localStorage.getItem("llmgw-rc-verbose") !== "0";
      } catch {
        return true;
      }
    })(),
  );
  const [convWidth, setConvWidth] = createSignal<"narrow" | "default" | "wide">(
    (() => {
      try {
        return (localStorage.getItem("llmgw-rc-width") as any) || "default";
      } catch {
        return "default";
      }
    })(),
  );
  const convWidthClass = createMemo(() => {
    const w = convWidth();
    if (w === "narrow") return "max-w-xl";
    if (w === "wide") return "max-w-5xl";
    return "max-w-3xl";
  });

  // Sidebar display options (Antigravity Display Options menu).
  const [groupBy, setGroupBy] = createSignal<"project" | "none">(
    (() => {
      try {
        return (localStorage.getItem("llmgw-rc-groupby") as any) || "project";
      } catch {
        return "project";
      }
    })(),
  );
  const [sortBy, setSortBy] = createSignal<"updated" | "added" | "alpha">(
    (() => {
      try {
        return (localStorage.getItem("llmgw-rc-sort") as any) || "updated";
      } catch {
        return "updated";
      }
    })(),
  );
  const [historyView, setHistoryView] = createSignal(false);
  const [displayMenuOpen, setDisplayMenuOpen] = createSignal(false);
  const [newProjectMenuOpen, setNewProjectMenuOpen] = createSignal(false);
  const [addContextOpen, setAddContextOpen] = createSignal(false);
  const [filesMenuOpen, setFilesMenuOpen] = createSignal(false);

  // Custom dropdowns use the shared ui.tsx <Select> (floating-ui Portal).
  // Local popovers below use the module-level <FloatMenu> (same layer).
  const [modelMenuOpen, setModelMenuOpen] = createSignal(false);
  const [usageOpen, setUsageOpen] = createSignal(false);
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [renameText, setRenameText] = createSignal("");
  const [isAtBottom, setIsAtBottom] = createSignal(true);

  // Attachments (chatbot-style): picked in the browser, stored on the daemon.
  interface PendingAttachment {
    key: string;
    name: string;
    mime: string;
    size: number;
    dataB64: string;
    objectUrl?: string;
    /** Browser-extracted markdown/text for pdf/office/plain files. */
    text?: string;
    loading?: boolean;
    loadError?: string;
    serverId?: string;
    uploading?: boolean;
    uploadKey?: string;
  }
  const [pendingAttachments, setPendingAttachments] = createSignal<PendingAttachment[]>([]);
  const uploadWaiters = new Map<string, { ok: (id: string) => void; fail: (msg: string) => void }>();

  // Advanced search (daemon full-text over local transcripts).
  interface SearchHit {
    sessionId: string;
    title: string;
    cwd: string;
    updatedAt: number;
    snippet: string;
    matchCount: number;
  }
  const [searchResults, setSearchResults] = createSignal<SearchHit[]>([]);
  let searchTimer: any = null;

  // Large editor modal (chatbot LargeEditor).
  const [largeEditorOpen, setLargeEditorOpen] = createSignal(false);
  const [largeEditorText, setLargeEditorText] = createSignal("");
  const [, setLargeEditorSend] = createSignal(false);
  // When a project is created, open the conversation modal on ack.
  const [sessionAfterProject, setSessionAfterProject] = createSignal(false);

  // Promise-based confirm modal (chatbot showConfirm, no native confirm()).
  interface ConfirmState {
    title: string;
    message: string;
    confirmText: string;
    cancelText: string;
    danger: boolean;
    resolve: (v: boolean) => void;
  }
  const [confirmState, setConfirmState] = createSignal<ConfirmState | null>(null);
  function showConfirm(opts: {
    title?: string;
    message?: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
  }): Promise<boolean> {
    return new Promise((resolve) => {
      setConfirmState({
        title: opts.title || "Confirm",
        message: opts.message || "",
        confirmText: opts.confirmText || "Confirm",
        cancelText: opts.cancelText || "Cancel",
        danger: !!opts.danger,
        resolve,
      });
    });
  }

  // Mobile: drawer below 768px regardless of touch (small desktop windows too).
  const [isMobile, setIsMobile] = createSignal(
    typeof window !== "undefined" ? window.innerWidth <= 768 : false,
  );

  // Live thinking timer (chatbot thinkingElapsed).
  const [thinkingStart, setThinkingStart] = createSignal<number | null>(null);
  const [thinkingElapsed, setThinkingElapsed] = createSignal(0);
  let thinkingTimer: any = null;
  function startThinkingTimer() {
    stopThinkingTimer();
    setThinkingStart(Date.now());
    setThinkingElapsed(0);
    thinkingTimer = setInterval(() => {
      const s = thinkingStart();
      if (s) setThinkingElapsed(Math.floor((Date.now() - s) / 1000));
    }, 1000);
  }
  function stopThinkingTimer(): number {
    if (thinkingTimer) {
      clearInterval(thinkingTimer);
      thinkingTimer = null;
    }
    const s = thinkingStart();
    const d = s ? Math.floor((Date.now() - s) / 1000) : 0;
    setThinkingStart(null);
    setThinkingElapsed(0);
    return d;
  }

  // Inline message editing (chatbot editingMessageIndex).
  const [editingMsgIdx, setEditingMsgIdx] = createSignal<number | null>(null);
  const [editingMsgText, setEditingMsgText] = createSignal("");

  // Selection mode for bulk ops (chatbot thread selection).
  const [selectionMode, setSelectionMode] = createSignal(false);
  const [selectedSessions, setSelectedSessions] = createSignal<Set<string>>(new Set());

  // Stored attachments per session (from session_data + uploads).
  interface StoredAttachment {
    id: string;
    name: string;
    mime: string;
    size: number;
  }
  const [sessionFiles, setSessionFiles] = createSignal<Record<string, StoredAttachment[]>>({});
  // Fetched bytes cache for preview (attachmentId -> data).
  const [previewCache, setPreviewCache] = createSignal<
    Record<string, { name: string; mime: string; dataB64: string; text?: string }>
  >({});
  // File preview modal target.
  const [previewFile, setPreviewFile] = createSignal<{
    name: string;
    mime: string;
    text?: string;
    dataUrl?: string;
    dataB64?: string;
    size?: number;
    truncated?: boolean;
    fullText?: string;
  } | null>(null);
  const [previewCopied, setPreviewCopied] = createSignal(false);
  const [truncateTokens, setTruncateTokens] = createSignal(16000);
  const [showTruncateInput, setShowTruncateInput] = createSignal(false);

  // Agent Configuration & MCP Center
  const [showConfigModal, setShowConfigModal] = createSignal(false);
  const [daemonSettings, setDaemonSettings] = createSignal<AgentSettings>({
    model: "gpt-4o",
    reasoning: "off",
    temperature: 0.7,
    autoCompactPercent: 95,
    noAutoTitle: false,
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
  // Anchor refs for floating menus (floating-ui positions them in a Portal).
  let displayBtn: HTMLButtonElement | undefined;
  let newProjBtn: HTMLButtonElement | undefined;
  let modelBtn: HTMLButtonElement | undefined;
  let projBtn: HTMLButtonElement | undefined;
  let addBtn: HTMLButtonElement | undefined;
  let filesBtn: HTMLButtonElement | undefined;
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

  function sessionInPath(s: SessionSummary, path: string) {
    const norm = path.replace(/\/+$/, "");
    const cwd = (s.cwd || "").replace(/\/+$/, "");
    return cwd === norm || cwd.startsWith(norm + "/");
  }

  function sessionsOfProject(projectPath: string) {
    return sessions().filter((s) => sessionInPath(s, projectPath));
  }

  /** Removes local leftovers of a session that vanished from the mirror. */
  function purgeSessionTrace(id: string) {
    setSessionUsage((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSessionFiles((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      localStorage.removeItem(`llmgw-draft:${id}`);
    } catch {}
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

  // Palette visibility rules: open only while the head token is a partial
  // prefix of some command. An exact match hides it (Enter will run the
  // command); typing args (space) or a non-matching token hides it too.
  const slashMatches = createMemo(() => {
    const raw = inputPrompt().trim().toLowerCase();
    if (!raw.startsWith("/") || raw.includes(" ")) return [];
    if (SLASH_COMMANDS.some((sc) => sc.cmd === raw)) return [];
    return SLASH_COMMANDS.filter((sc) => sc.cmd.startsWith(raw));
  });
  // Selection resets on every keystroke so the focused row never goes stale.
  createEffect(() => {
    inputPrompt();
    setSlashIndex(0);
  });

  // Accepts a palette pick: fills the composer with the full command and
  // hides the palette (an exact command is no longer a "match"). Focus
  // stays in the textarea so typing/Enter continues naturally.
  function pickSlash(cmd: string) {
    setInputPrompt(cmd + " ");
    try {
      const el = document.querySelector<HTMLTextAreaElement>("#rc-composer");
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    } catch {}
  }

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
      // SignalDB sync paints IndexedDB state instantly; this reconciles it
      // with the daemon truth (and picks up anything missed while offline).
      dataLayer.storeFor(hostId).syncAll();

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
  // The daemon speaks two dialects on the wire: Anthropic-style blocks
  // ({type:"text"|"tool_use"|"tool_result"}) and raw Go structs
  // ({text}, {id,name,arguments}, {call_id,content,is_error},
  // {reasoning_id,summary}, {mime_type,data}). Parse both.
  function prettyArgs(v: any): string {
    if (v == null) return "";
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  }
  function toolResultText(c: any): string {
    const content = c.content ?? c.result;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((p: any) =>
          typeof p === "string" ? p : typeof p?.text === "string" ? p.text : prettyArgs(p),
        )
        .join("\n");
    }
    return prettyArgs(content);
  }
  function parseContentBlocks(m: any): ContentBlock[] {
    const blocks: ContentBlock[] = [];
    const pushBlock = (c: any) => {
      if (c == null) return;
      if (typeof c === "string") {
        blocks.push({ type: "text", text: c });
        return;
      }
      // Reasoning / thinking (Go ReasoningBlock has no `type`).
      if (
        c.type === "reasoning" ||
        c.type === "thinking" ||
        typeof c.summary === "string" ||
        typeof c.reasoning_id === "string" ||
        typeof c.encrypted_content === "string"
      ) {
        const txt = c.summary || c.text || "";
        if (txt) blocks.push({ type: "reasoning", reasoning: txt });
        return;
      }
      // Tool call: Anthropic {type:"tool_use",id,name,input} or Go {id,name,arguments}.
      if (c.type === "tool_use" || (typeof c.name === "string" && typeof c.id === "string")) {
        blocks.push({
          type: "tool_call",
          toolId: c.id,
          toolName: c.name,
          toolArgs: prettyArgs(c.input ?? c.arguments ?? c.args),
        });
        return;
      }
      // Tool result: Anthropic {type:"tool_result",tool_use_id/content/is_error}
      // or Go {call_id, content:[{text}], is_error} or flat {id,result,isError}.
      if (
        c.type === "tool_result" ||
        typeof c.call_id === "string" ||
        (typeof c.tool_use_id === "string" && c.content !== undefined)
      ) {
        blocks.push({
          type: "tool_result",
          toolId: c.tool_use_id || c.call_id || c.id,
          toolResult: toolResultText(c),
          isError: !!(c.is_error ?? c.isError ?? c.is_error === true),
        });
        return;
      }
      // Image (Go ImageBlock {mime_type, data}) — render the real bytes.
      if (typeof c.mime_type === "string" || c.type === "image") {
        blocks.push({
          type: "image",
          text: c.mime_type || "image",
          imageMime: c.mime_type,
          imageData: typeof c.data === "string" ? c.data : undefined,
        });
        return;
      }
      // Plain text (both dialects).
      if (c.type === "text" || typeof c.text === "string") {
        blocks.push({ type: "text", text: c.text });
        return;
      }
    };
    if (Array.isArray(m.content)) {
      for (const c of m.content) pushBlock(c);
    } else if (typeof m.content === "string") {
      blocks.push({ type: "text", text: m.content });
    }
    return blocks;
  }
  function mapSummary(r: any): SessionSummary {
    return {
      id: r.id,
      hostId: activeHostId(),
      cwd: r.cwd,
      title: r.title || r.cwd,
      model: r.model || "gpt-4o",
      status: r.status || "idle",
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
  // Normalizes the raw daemon transcript for display. The daemon persists
  // tool results as separate "tool" (or Anthropic-style "user") messages;
  // rendered as-is they show up as disconnected rows or stray user bubbles.
  //
  // Display-only — the persisted provider payloads are never reordered:
  // - Thinking position: assembleMsg persists ReasoningBlock LAST although
  //   it streamed FIRST, so after every refresh the thinking would drop
  //   below the balloon — reasoning is moved to the top of its message.
  // - mirrorToolImagesAsUser (openai routing): a synthetic role:user message
  //   carrying tool-run images plus the marker
  //   "Tool output included the following image content:" — it would render
  //   as the user's own balloon, so it is folded into the assistant carrier
  //   as caption + image blocks instead.
  function applySessionContent(sessionId: string, rawMsgs: any[]) {
    const out: ChatMessage[] = [];
    let carrier: ChatMessage | null = null;
    const TOOLS_IMAGE_MARKER = "Tool output included the following image content:";
    const ensureCarrier = (srcIdx: number): ChatMessage => {
      if (!carrier || carrier.role !== "assistant") {
        carrier = {
          id: `tools_${srcIdx}`,
          role: "assistant",
          blocks: [],
          time: Date.now(),
          srcIdx,
        };
        out.push(carrier);
      }
      return carrier;
    };
    (rawMsgs || []).forEach((m: any, idx: number) => {
      const blocks = parseContentBlocks(m);
      const firstText = blocks.find((b) => b.type === "text")?.text || "";
      const system =
        m?.meta?.compaction === "true" ||
        firstText.startsWith("## Context Summary (compacted)");
      const role = m.role === "assistant" ? "assistant" : m.role === "tool" ? "tool" : "user";
      if (role === "assistant") {
        const reason: ContentBlock[] = [];
        const rest: ContentBlock[] = [];
        for (const b of blocks) (b.type === "reasoning" ? reason : rest).push(b);
        const msg: ChatMessage = {
          id: `msg_${idx}`,
          role,
          blocks: [...reason, ...rest],
          time: Date.now(),
          system,
          srcIdx: idx,
        };
        out.push(msg);
        carrier = msg;
        return;
      }
      // user / tool envelope: split tool results away from real content.
      const rest: ContentBlock[] = [];
      for (const b of blocks) {
        if (b.type === "tool_result") ensureCarrier(idx).blocks.push(b);
        else rest.push(b);
      }
      // Daemon's image mirror: caption + tool-run images, never a user bubble.
      if (
        rest.length > 0 &&
        rest[0].type === "text" &&
        (rest[0].text || "").trim().startsWith(TOOLS_IMAGE_MARKER)
      ) {
        const c = ensureCarrier(idx);
        c.blocks.push({ type: "text", text: `_${TOOLS_IMAGE_MARKER}_` });
        c.blocks.push(...rest.slice(1));
        return;
      }
      if (role === "tool" || rest.length === 0) {
        // "tool" envelopes never become bubbles; a user envelope holding
        // only tool results must not render as an empty user bubble.
        if (rest.length > 0) ensureCarrier(idx).blocks.push(...rest);
        return;
      }
      const msg: ChatMessage = {
        id: `msg_${idx}`,
        role: "user",
        blocks: rest,
        time: Date.now(),
        system,
        srcIdx: idx,
      };
      out.push(msg);
      carrier = msg;
    });
    setMessages(out);
    setIsAtBottom(true);
    scrollToBottom(true);
  }
  function applyUsage(sessionId: string, u: any, cum: any) {
    if (!sessionId) return;
    const src = cum || u || {};
    setSessionUsage((prev) => ({
      ...prev,
      [sessionId]: {
        inTok: src.input_tokens ?? src.inTok ?? prev[sessionId]?.inTok ?? 0,
        outTok: src.output_tokens ?? src.outTok ?? prev[sessionId]?.outTok ?? 0,
        cacheTok:
          (src.cache_read_tokens ?? 0) + (src.cache_write_tokens ?? src.cache_creation_tokens ?? 0) ||
          prev[sessionId]?.cacheTok ||
          0,
        reasoningTok: src.reasoning_tokens ?? prev[sessionId]?.reasoningTok ?? 0,
        costUsd: src.cost_usd ?? prev[sessionId]?.costUsd ?? 0,
      },
    }));
  }
  function handleIncomingMessage(msg: any) {
    // SignalDB sync protocol messages (pull responses / change pings) are
    // owned by the data layer; everything else is event-driven below.
    if (dataLayer.handleMessage(msg)) return;
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

      // NOTE: sessions/projects/config lists never arrive as events — the
      // SignalDB sync owns them (daemon change ping → pull → collection).
      // The events below are action acks that drive local continuation.

      case "session_created": {
        const r = msg.session;
        if (!r) break;
        const s = mapSummary(r);
        selectSession(s.id);
        // A composer send with no active session auto-creates one and the
        // typed text was held back — deliver it now.
        const pending = pendingFirstText();
        if (pending) {
          setPendingFirstText(null);
          sendTextToSession(s.id, pending);
        }
        break;
      }

      case "project_created": {
        const p = msg.project;
        if (!p?.id) break;
        setActiveProjectId(p.id);
        toast(`Project '${p.name || "Project"}' added`, "ok");
        // Project wizards lead straight into a conversation — the input
        // stays at the bottom, nothing pops up in the middle.
        if (sessionAfterProject()) {
          setSessionAfterProject(false);
          if (wsOpen()) {
            sendWS({ type: "create_session", cwd: p.path, title: "", model: activeModel() });
          }
        }
        break;
      }

      case "attachment_uploaded": {
        const a = msg.attachment;
        if (!a?.id) break;
        if (msg.sessionId) {
          setSessionFiles((prev) => {
            const list = prev[msg.sessionId] || [];
            if (list.some((x) => x.id === a.id)) return prev;
            return {
              ...prev,
              [msg.sessionId]: [...list, { id: a.id, name: a.name, mime: a.mime, size: a.size || 0 }],
            };
          });
        }
        setPendingAttachments((prev) =>
          prev.map((p) =>
            p.uploadKey === msg.requestId || (!p.serverId && p.name === a.name)
              ? { ...p, serverId: a.id, uploading: false }
              : p,
          ),
        );
        const w = msg.requestId ? uploadWaiters.get(msg.requestId) : undefined;
        if (w) {
          uploadWaiters.delete(msg.requestId);
          w.ok(a.id);
        }
        break;
      }

      case "search_results": {
        if (typeof msg.query === "string" && msg.query.trim() !== sessionFilter().trim()) break;
        const raw = Array.isArray(msg.results) ? msg.results : [];
        setSearchResults(
          raw.map((r: any) => ({
            sessionId: r.sessionId || r.session_id,
            title: r.title || "",
            cwd: r.cwd || "",
            updatedAt: r.updatedAt ?? r.updated_at ?? 0,
            snippet: r.snippet || "",
            matchCount: r.matchCount ?? r.match_count ?? 0,
          })),
        );
        break;
      }

      case "notice": {
        if (msg.message) toast(msg.message, "ok");
        break;
      }

      case "attachment_data": {
        const a = msg.attachment;
        if (!a?.id || (!a.data && !a.text)) break;
        setPreviewCache((prev) => ({
          ...prev,
          [a.id]: { name: a.name, mime: a.mime, dataB64: a.data || "", text: a.text },
        }));
        openStoredPreview(msg.sessionId, a.id);
        break;
      }

      case "session_data": {
        // Historic full-record shape; render it like session_content.
        const r = msg.session;
        if (!r) break;
        const sid = r.id || msg.sessionId;
        if (sid) {
          const atts = r.attachments || r.Attachments || [];
          if (Array.isArray(atts)) {
            setSessionFiles((prev) => ({
              ...prev,
              [sid]: atts.map((a: any) => ({
                id: a.id,
                name: a.name,
                mime: a.mime,
                size: a.size || 0,
              })),
            }));
          }
        }
        if (sid && sid === activeSessionId()) {
          applySessionContent(sid, r.messages || r.Messages || []);
        }
        break;
      }

      case "session_content": {
        if (msg.sessionId !== activeSessionId()) break;
        applySessionContent(msg.sessionId, msg.messages || []);
        break;
      }

      case "session_status": {
        // Composer responsiveness only (stop button state) — the collections
        // get the same truth via the sessions change ping.
        if (msg.sessionId === activeSessionId()) {
          setSessionStatus(msg.status);
        }
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
          applySessionContent(msg.sessionId, msg.messages || []);
          toast(
            msg.auto
              ? "Context auto-compacted — oldest 30% summarized, recent 70% kept"
              : "Transcript compacted successfully",
            "ok",
          );
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
          // First content chunk freezes the thinking clock (chatbot-style).
          if (thinkingStart() !== null) {
            const dur = stopThinkingTimer();
            stampThinkingDuration(dur);
          }
          appendStreamingDelta(ev.delta);
        } else if (ev.type === "reasoning_delta") {
          appendReasoningDelta(ev.delta || "");
        } else if (ev.type === "tool_use_start") {
          // Pre-render a live "composing call" card while args stream in.
          appendToolCall(ev.id, ev.name, "");
        } else if (ev.type === "tool_use_args") {
          appendToolArgsDelta(ev.id, ev.delta);
        } else if (ev.type === "tool_use_end") {
          // No-op: the final tool_call event carries the full block.
        } else if (ev.type === "tool_progress") {
          setToolProgress((prev) => ({ ...prev, [ev.id]: ev.text }));
        } else if (ev.type === "tool_call") {
          appendToolCall(ev.id, ev.name, ev.args);
        } else if (ev.type === "tool_result") {
          setPendingApproval(null);
          setToolProgress((prev) => {
            const next = { ...prev };
            delete next[ev.id];
            return next;
          });
          appendToolResult(ev.id, ev.result ?? ev.content, ev.isError);
        } else if (ev.type === "usage") {
          applyUsage(msg.sessionId, ev.usage, ev.cumulative);
        } else if (ev.type === "compact_progress") {
          if (ev.text === "Compacting older context…") toast(ev.text, "ok");
        } else if (ev.type === "turn_end") {
          setSessionStatus("idle");
          setPendingApproval(null);
          setToolProgress({});
          if (thinkingStart() !== null) {
            const dur = stopThinkingTimer();
            stampThinkingDuration(dur);
          }
          if (ev.usage || ev.cumulative) applyUsage(msg.sessionId, ev.usage, ev.cumulative);
          if (ev.error) toast(ev.error, "err");
          // Refresh the transcript so tool blocks persisted by the daemon
          // (with full args/results) replace the streamed approximations.
          sendWS({ type: "get_session", sessionId: msg.sessionId });
        } else if (ev.type === "error") {
          toast(ev.message || "Agent error", "err");
          setSessionStatus("idle");
        }
        scrollToBottom();
        break;
      }

      case "error": {
        if (msg.requestId && uploadWaiters.has(msg.requestId)) {
          const w = uploadWaiters.get(msg.requestId)!;
          uploadWaiters.delete(msg.requestId);
          w.fail(msg.message || "Upload failed");
          break;
        }
        // Sync pulls on an offline host are expected background noise.
        if (msg.replyTo === "pull") break;
        if (typeof msg.message === "string" && msg.message.toLowerCase().includes("project")) {
          setSessionAfterProject(false);
        }
        toast(msg.message || "Daemon returned an error", "err");
        setSessionStatus("idle");
        setPendingApproval(null);
        break;
      }
    }
  }

  function appendReasoningDelta(delta: string) {
    if (!delta) return;
    if (thinkingStart() === null) startThinkingTimer();
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant") {
        const blocks = [...last.blocks];
        // Merge into the existing thinking panel; a fresh one goes in front
        // so the live view already matches the normalized refresh (top).
        const ri = blocks.findIndex((b) => b.type === "reasoning");
        if (ri >= 0) {
          blocks[ri] = {
            ...blocks[ri],
            reasoning: (blocks[ri].reasoning || "") + delta,
          };
          return [...prev.slice(0, -1), { ...last, blocks }];
        }
        return [
          ...prev.slice(0, -1),
          { ...last, blocks: [{ type: "reasoning", reasoning: delta }, ...blocks] },
        ];
      }
      return [
        ...prev,
        {
          id: `asst_${Date.now()}`,
          role: "assistant",
          blocks: [{ type: "reasoning", reasoning: delta }],
          time: Date.now(),
        },
      ];
    });
  }

  function stampThinkingDuration(dur: number) {
    setMessages((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === "assistant") {
          const m = { ...prev[i], thinkingDuration: dur };
          return [...prev.slice(0, i), m, ...prev.slice(i + 1)];
        }
      }
      return prev;
    });
  }

  function downloadPreviewFile() {
    const f = previewFile();
    if (!f?.dataB64) {
      toast("Original bytes unavailable for download", "err");
      return;
    }
    try {
      const bin = atob(f.dataB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes as any], { type: f.mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch {
      toast("Download failed", "err");
    }
  }

  function truncatePreviewFile() {
    const f = previewFile();
    const maxChars = (truncateTokens() || 16000) * 4;
    if (!f?.text || f.text.length <= maxChars) {
      toast("File is already within the token limit", "err");
      return;
    }
    setPreviewFile({
      ...f,
      fullText: f.fullText || f.text,
      text: f.text.substring(0, maxChars),
      truncated: true,
    });
    toast(`Truncated to ~${truncateTokens().toLocaleString()} tokens`, "ok");
  }

  function restorePreviewFile() {
    const f = previewFile();
    if (f?.fullText) {
      setPreviewFile({ ...f, text: f.fullText, fullText: undefined, truncated: false });
      toast("Original content restored", "ok");
    }
  }

  function previewPending(a: { name: string; mime: string; text?: string; objectUrl?: string; dataB64?: string; size?: number }) {    if (a.objectUrl) {
      setPreviewFile({ name: a.name, mime: a.mime, dataUrl: a.objectUrl, size: a.size });
    } else {
      setPreviewFile({ name: a.name, mime: a.mime, text: a.text || "(still extracting...)", size: a.size });
    }
    setPreviewCopied(false);
  }

  function b64ToDataUrl(mime: string, b64: string) {
    return `data:${mime || "application/octet-stream"};base64,${b64}`;
  }

  function openStoredPreview(sessionId: string, attachmentId: string) {
    const cached = previewCache()[attachmentId];
    const meta = (sessionFiles()[sessionId] || []).find((a) => a.id === attachmentId);
    const name = cached?.name || meta?.name || "attachment";
    const mime = cached?.mime || meta?.mime || "";
    if (!cached) {
      if (wsOpen()) {
        sendWS({ type: "get_attachment", sessionId, attachmentId });
        toast("Loading attachment...", "ok");
      } else {
        toast("Not connected to host", "err");
      }
      return;
    }
    if (mime.startsWith("image/")) {
      setPreviewFile({
        name,
        mime,
        dataUrl: b64ToDataUrl(mime, cached.dataB64),
        dataB64: cached.dataB64,
        size: meta?.size,
      });
      setPreviewCopied(false);
      return;
    }
    let text = cached.text || "";
    if (!text) {
      try {
        const bin = atob(cached.dataB64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      } catch {
        text = "(could not decode file)";
      }
    }
    setPreviewFile({ name, mime, text, dataB64: cached.dataB64, size: meta?.size });
    setPreviewCopied(false);
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

  function appendToolCall(callId: string, name: string, args: any) {
    const argsStr = prettyArgs(args);
    setMessages((prev) => {
      // Upsert: tool_use_start pre-creates the card, tool_call finalizes it.
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m.role !== "assistant") continue;
        const bi = m.blocks.findIndex(
          (b) => b.type === "tool_call" && b.toolId === callId,
        );
        if (bi >= 0) {
          const blocks = [...m.blocks];
          blocks[bi] = { ...blocks[bi], toolName: name || blocks[bi].toolName, toolArgs: argsStr || blocks[bi].toolArgs };
          return [...prev.slice(0, i), { ...m, blocks }, ...prev.slice(i + 1)];
        }
        break;
      }
      const toolBlock: ContentBlock = {
        type: "tool_call",
        toolId: callId,
        toolName: name,
        toolArgs: argsStr,
      };

      const last = prev[prev.length - 1];
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

  function appendToolArgsDelta(callId: string, delta: string) {
    if (!delta) return;
    setMessages((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        const m = prev[i];
        if (m.role !== "assistant") continue;
        const bi = m.blocks.findIndex(
          (b) => b.type === "tool_call" && b.toolId === callId,
        );
        if (bi >= 0) {
          const blocks = [...m.blocks];
          blocks[bi] = { ...blocks[bi], toolArgs: (blocks[bi].toolArgs || "") + delta };
          return [...prev.slice(0, i), { ...m, blocks }, ...prev.slice(i + 1)];
        }
        break;
      }
      return prev;
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

  function scrollToBottom(force = false) {
    if (!force && !isAtBottom()) return;
    setTimeout(() => {
      const el = chatContainerRef();
      if (el) el.scrollTop = el.scrollHeight;
    }, 40);
  }

  function onChatScroll() {
    const el = chatContainerRef();
    if (!el) return;
    setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 100);
  }

  function selectSession(id: string) {
    setActiveSessionId(id);
    setPendingApproval(null);
    setSearchResults([]);
    cancelEditMsg();
    stopThinkingTimer();
    for (const p of pendingAttachments()) {
      if (p.objectUrl) {
        try {
          URL.revokeObjectURL(p.objectUrl);
        } catch {}
      }
    }
    setPendingAttachments([]);
    const s = sessions().find((x) => x.id === id);
    if (s) {
      setSessionStatus(s.status);
      if (s.model) setActiveModel(s.model);
    }
    sendWS({ type: "get_session", sessionId: id });
  }

  // "New Conversation" never pops a centered dialog: the daemon registers a
  // blank session in the active project and the composer at the bottom is
  // where typing happens. Without any project, ask for the folder instead.
  function startNewConversation() {
    const proj = activeProject();
    if (!proj) {
      openNewProjectModal();
      return;
    }
    if (!wsOpen()) {
      toast("Not connected to host yet — wait for online status", "err");
      return;
    }
    sendWS({ type: "create_session", cwd: proj.path, title: "", model: activeModel() });
  }

  function createProject() {
    const rawPath = newProjectPath().trim();
    if (!rawPath) {
      toast("Project folder cannot be empty", "err");
      return;
    }
    if (!activeHostId()) {
      toast("Connect a host first", "err");
      return;
    }
    if (!wsOpen()) {
      // Frontend holds no state of its own — no offline project shadow copies.
      toast("Not connected to host yet — wait for online status", "err");
      return;
    }
    setSessionAfterProject(true);
    // Daemon is the source of truth; ack arrives as project_created.
    sendWS({ type: "create_project", path: rawPath, requestId: "cp_" + Date.now() });
    setNewProjectPath("");
    setShowNewProjectModal(false);
  }

  async function deleteProject(id: string, e: MouseEvent) {
    e.stopPropagation();
    const ok = await showConfirm({
      title: "Delete project?",
      message: "The project AND all of its conversations (transcripts and attached files) are permanently deleted from the host.\n\nThis action cannot be undone.",
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    // The daemon cascades (wipes every conversation inside, then pings) —
    // the collections converge on their own; nothing local to purge by hand.
    if (wsOpen()) sendWS({ type: "delete_project", projectId: id });
  }

  function quickStartProject() {
    // Quick Start: project rooted at the host home dir + immediate conversation.
    if (!activeHostId()) {
      toast("Connect a host first", "err");
      return;
    }
    if (!wsOpen()) {
      toast("Not connected to host yet — wait for online status", "err");
      return;
    }
    setSessionAfterProject(true);
    sendWS({ type: "create_project", path: "~", requestId: "cp_" + Date.now() });
  }

  async function deleteSession(id: string, e?: MouseEvent) {
    e?.stopPropagation();
    const ok = await showConfirm({
      title: "Delete conversation?",
      message: "This conversation will be permanently deleted from the host.\n\nThis action cannot be undone.",
      confirmText: "Delete",
      danger: true,
    });
    if (ok) sendWS({ type: "delete_session", sessionId: id });
  }

  function messageText(m: ChatMessage): string {
    return m.blocks
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text as string)
      .join("\n");
  }

  // --- Attachments (chatbot-style; bytes live on the daemon) ---
  const MAX_ATTACHMENTS = 5;
  const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;

  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files || []);
    if (list.length === 0) return;
    if (!activeSessionId()) {
      toast("Start a conversation before attaching files", "err");
      return;
    }
    const room = MAX_ATTACHMENTS - pendingAttachments().length;
    if (room <= 0) {
      toast(`Max ${MAX_ATTACHMENTS} attachments per message`, "err");
      return;
    }
    const { sniffFile, extractText, uint8ToB64 } = await import("../office");
    for (const file of list.slice(0, room)) {
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await file.arrayBuffer());
      } catch {
        toast(`Could not read '${file.name}'`, "err");
        continue;
      }
      const sniff = sniffFile(file, bytes);
      if (sniff.blocked) {
        toast(sniff.blocked, "err");
        continue;
      }
      const kind = sniff.kind || "text";
      const isImage = kind === "image";
      const cap = isImage ? MAX_IMAGE_BYTES : 12 * 1024 * 1024;
      if (bytes.length > cap) {
        toast(`'${file.name}' too large (max ${isImage ? "2.5MB" : "12MB"})`, "err");
        continue;
      }
      const key = `pa_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
      const base = {
        key,
        name: file.name,
        mime: file.type || "application/octet-stream",
        size: file.size,
        dataB64: uint8ToB64(bytes),
      };
      if (isImage) {
        setPendingAttachments((prev) => [
          ...prev,
          { ...base, objectUrl: URL.createObjectURL(file) },
        ]);
        continue;
      }
      // Text-likes convert in the background (pdf/office may take seconds).
      const needsConvert = kind === "office" || !!sniff.officeFormat;
      setPendingAttachments((prev) => [
        ...prev,
        { ...base, loading: needsConvert, text: needsConvert ? (sniff.officeFormat === "pdf" ? "Extracting PDF..." : "Converting document...") : undefined },
      ]);
      if (needsConvert || sniff.officeFormat === "pdf" || kind === "text") {
        try {
          let text: string;
          if (kind === "text" && !sniff.officeFormat) {
            text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
          } else {
            text = await extractText(bytes, file.name, sniff.officeFormat);
          }
          setPendingAttachments((prev) =>
            prev.map((p) => (p.key === key ? { ...p, loading: false, text } : p)),
          );
        } catch (e: any) {
          setPendingAttachments((prev) => prev.filter((p) => p.key !== key));
          toast(`Could not extract '${file.name}': ${e?.message || e}`, "err");
        }
      }
    }
  }

  function removePendingAttachment(key: string) {
    setPendingAttachments((prev) => {
      const hit = prev.find((p) => p.key === key);
      if (hit?.objectUrl) {
        try {
          URL.revokeObjectURL(hit.objectUrl);
        } catch {}
      }
      return prev.filter((p) => p.key !== key);
    });
  }

  function uploadOneAttachment(sid: string, a: PendingAttachment): Promise<string> {
    if (a.serverId) return Promise.resolve(a.serverId);
    const requestId = `ua_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`;
    setPendingAttachments((prev) =>
      prev.map((p) => (p.key === a.key ? { ...p, uploading: true, uploadKey: requestId } : p)),
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        uploadWaiters.delete(requestId);
        setPendingAttachments((prev) =>
          prev.map((p) => (p.key === a.key ? { ...p, uploading: false } : p)),
        );
        reject(new Error(`Upload timed out for '${a.name}'`));
      }, 20000);
      uploadWaiters.set(requestId, {
        ok: (id: string) => {
          clearTimeout(timer);
          resolve(id);
        },
        fail: (m: string) => {
          clearTimeout(timer);
          setPendingAttachments((prev) =>
            prev.map((p) => (p.key === a.key ? { ...p, uploading: false } : p)),
          );
          reject(new Error(m));
        },
      });
      sendWS({
        type: "upload_attachment",
        requestId,
        sessionId: sid,
        name: a.name,
        mime: a.mime,
        data: a.dataB64,
        text: a.text || undefined,
      });
    });
  }

  function copyMsg(id: string, text: string) {
    copyWithToast(text || "");
    setCopiedMsgId(id);
    setTimeout(() => setCopiedMsgId((cur) => (cur === id ? null : cur)), 1500);
  }

  // Rendered position → raw daemon transcript index (normalization merges
  // tool envelopes, so naive For indices mismatch the raw array).
  function rawIdx(idx: number): number {
    return messages()[idx]?.srcIdx ?? idx;
  }

  // Regenerate from message idx: the daemon drops that message and everything
  // after it, then re-runs the turn (chatbot regenerateMessage semantics).
  function regenerateMsg(idx: number) {
    const sid = activeSessionId();
    if (!sid || !wsOpen()) return;
    if (sessionStatus() === "running") {
      toast("Stop the current turn first", "err");
      return;
    }
    sendWS({ type: "regenerate", sessionId: sid, index: rawIdx(idx), model: activeModel(), yolo: yoloMode() });
  }

  // Inline edit (chatbot startEditMessage): user edits resubmit, assistant
  // edits just save.
  function startEditMsg(idx: number, m: ChatMessage) {
    setEditingMsgIdx(idx);
    setEditingMsgText(messageText(m));
  }
  function cancelEditMsg() {
    setEditingMsgIdx(null);
    setEditingMsgText("");
  }
  function saveEditMsg(idx: number, m: ChatMessage) {
    const sid = activeSessionId();
    const text = editingMsgText().trim();
    if (!sid || !wsOpen()) {
      cancelEditMsg();
      return;
    }
    if (!text) {
      toast("Message cannot be empty", "err");
      return;
    }
    const regen = m.role === "user";
    if (regen && sessionStatus() === "running") {
      toast("Stop the current turn first", "err");
      return;
    }
    sendWS({
      type: "edit_message",
      sessionId: sid,
      index: rawIdx(idx),
      text,
      model: activeModel(),
      yolo: yoloMode(),
      regenerate: regen,
    });
    cancelEditMsg();
    if (regen) setSessionStatus("running");
  }

  async function deleteMsg(idx: number) {
    const sid = activeSessionId();
    if (!sid || !wsOpen()) return;
    const ok = await showConfirm({
      title: "Delete message?",
      message: "This message will be permanently deleted from the transcript.\n\nThis action cannot be undone.",
      confirmText: "Delete",
      danger: true,
    });
    if (ok) sendWS({ type: "delete_message", sessionId: sid, index: rawIdx(idx) });
  }

  function editUserMsg(m: ChatMessage) {
    // Open the large editor (chatbot-style) instead of editing inline.
    setLargeEditorText(messageText(m));
    setLargeEditorSend(false);
    setLargeEditorOpen(true);
  }

  function togglePin(id: string, e: MouseEvent) {
    e.stopPropagation();
    // Command only — the daemon's change ping brings the new pin state.
    if (wsOpen()) sendWS({ type: "toggle_pin", sessionId: id });
  }

  function toggleSessionSelect(id: string) {
    setSelectedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Nested sidebar state: expanded projects (default all expanded).
  const [expandedProjects, setExpandedProjects] = createSignal<Record<string, boolean>>({});
  function isProjectExpanded(p: { id: string }) {
    return expandedProjects()[p.id] !== false;
  }
  function toggleProjectExpanded(id: string) {
    setExpandedProjects((prev) => ({ ...prev, [id]: !(prev[id] !== false) }));
  }

  function matchQuery(s: SessionSummary) {
    const q = sessionFilter().toLowerCase().trim();
    if (!q) return true;
    return (
      s.title.toLowerCase().includes(q) ||
      s.cwd.toLowerCase().includes(q) ||
      s.model.toLowerCase().includes(q)
    );
  }
  function projectSessions(path: string) {
    return sortedSessions(sessionsOfProject(path).filter(matchQuery));
  }
  function looseSessions() {
    const norm = (p: string) => p.replace(/\/+$/, "");
    return sortedSessions(
      sessions().filter((s) => {
        if (!matchQuery(s)) return false;
        const cwd = norm(s.cwd || "");
        return !projects().some((p) => {
          const pp = norm(p.path);
          return cwd === pp || cwd.startsWith(pp + "/");
        });
      }),
    );
  }

  function closeSidebarOnMobile() {
    if (isMobile()) setSidebarOpen(false);
  }

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedSessions(new Set<string>());
  }

  async function pinSelected() {
    const ids = [...selectedSessions()];
    if (ids.length === 0) return;
    const allPinned = ids.every((id) => sessions().find((s) => s.id === id)?.pinned);
    const target = !allPinned;
    for (const id of ids) {
      const cur = sessions().find((s) => s.id === id);
      if (!cur || !!cur.pinned === target) continue;
      if (wsOpen()) sendWS({ type: "toggle_pin", sessionId: id });
    }
    toast(`${ids.length} conversation${ids.length === 1 ? "" : "s"} ${target ? "pinned" : "unpinned"}`, "ok");
    exitSelectionMode();
  }

  async function deleteSelected() {
    const ids = [...selectedSessions()];
    if (ids.length === 0) return;
    const ok = await showConfirm({
      title: `Delete ${ids.length} conversation${ids.length === 1 ? "" : "s"}?`,
      message: `This will permanently delete ${ids.length} conversation${ids.length === 1 ? "" : "s"} from the host.\n\nThis action cannot be undone.`,
      confirmText: "Delete",
      danger: true,
    });
    if (!ok) return;
    for (const id of ids) sendWS({ type: "delete_session", sessionId: id });
    toast(`${ids.length} conversation${ids.length === 1 ? "" : "s"} deleted`, "ok");
    exitSelectionMode();
  }

  function submitRename(id: string) {
    const t = renameText().trim();
    if (!t) {
      setRenamingId(null);
      return;
    }
    sendWS({ type: "rename_session", sessionId: id, title: t });
    setRenamingId(null);
  }

  function sortedSessions(list: SessionSummary[]) {
    const arr = [...list];
    // Pinned first (chatbot sortedThreads), then the chosen order.
    arr.sort((a, b) => {
      if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
      if (sortBy() === "alpha") return a.title.localeCompare(b.title);
      if (sortBy() === "added") return a.createdAt - b.createdAt;
      return b.updatedAt - a.updatedAt;
    });
    return arr;
  }

  // Debounced daemon full-text search (transcripts live on the host).
  function queueDaemonSearch(q: string) {
    clearTimeout(searchTimer);
    const query = q.trim();
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }
    searchTimer = setTimeout(() => {
      if (wsOpen()) sendWS({ type: "search", query, limit: 30 });
    }, 300);
  }

  // No session is ever a dead end: typing + Enter auto-starts a
  // conversation inside the active project, then the text is delivered.
  function beginConversationWith(firstText: string) {
    const proj = activeProject();
    if (!proj) {
      toast("Create a project first", "err");
      return;
    }
    if (!wsOpen()) {
      toast("Not connected to host yet — wait for online status", "err");
      return;
    }
    setPendingFirstText(firstText);
    setInputPrompt("");
    sendWS({ type: "create_session", cwd: proj.path, title: "", model: activeModel() });
  }

  function sendTextToSession(sid: string, text: string) {
    const userMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      role: "user",
      blocks: [{ type: "text", text }],
      time: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setSessionStatus("running");
    setIsAtBottom(true);
    scrollToBottom(true);
    sendWS({
      type: "prompt",
      sessionId: sid,
      text,
      model: activeModel(),
      yolo: yoloMode(),
      attachmentIds: [],
    });
  }

  async function sendPrompt() {
    const text = inputPrompt().trim();
    const sid = activeSessionId();
    // Slash fast-path: UI commands resolve locally, transcript ops go down.
    if (text.startsWith("/")) {
      setInputPrompt("");
      try {
        if (sid) localStorage.removeItem(`llmgw-draft:${sid}`);
      } catch {}
      if (routeSlash(text)) return;
      if (!sid) {
        beginConversationWith(text);
        return;
      }
    }
    if (!text && pendingAttachments().length === 0) return;
    if (!sid) {
      beginConversationWith(text);
      return;
    }
    if (sessionStatus() === "running") return;

    // Upload pending attachments first so the daemon owns the bytes.
    let attachmentIds: string[] = [];
    const pending = pendingAttachments();
    if (pending.some((a) => a.loading)) {
      toast("Wait for files to finish extracting", "err");
      return;
    }
    if (pending.length > 0) {
      setSessionStatus("running");
      try {
        attachmentIds = await Promise.all(pending.map((a) => uploadOneAttachment(sid, a)));
      } catch (e: any) {
        setSessionStatus("idle");
        toast(e?.message || "Attachment upload failed", "err");
        return;
      }
    }
    const attachmentNames = pending.map((a) => a.name);

    const displayText = text || attachmentNames.map((n) => `[Attached ${n}]`).join("\n");
    const userMsg: ChatMessage = {
      id: `user_${Date.now()}`,
      role: "user",
      blocks: [{ type: "text", text: displayText }],
      time: Date.now(),
      attachments: attachmentNames.length > 0 ? attachmentNames : undefined,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInputPrompt("");
    for (const p of pending) {
      if (p.objectUrl) {
        try {
          URL.revokeObjectURL(p.objectUrl);
        } catch {}
      }
    }
    setPendingAttachments([]);
    try {
      localStorage.removeItem(`llmgw-draft:${sid}`);
    } catch {}
    setSessionStatus("running");
    setIsAtBottom(true);
    scrollToBottom(true);

    sendWS({
      type: "prompt",
      sessionId: sid,
      text: text || "(see attachments)",
      model: activeModel(),
      yolo: yoloMode(),
      attachmentIds,
    });
  }

  function cancelCurrentTurn() {
    if (!activeSessionId()) return;
    sendWS({ type: "cancel", sessionId: activeSessionId() });
    setSessionStatus("idle");
    setPendingApproval(null);
    toast("Generation stopped", "ok");
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
    // Local-first routing: UI commands never pollute the transcript.
    if (routeSlash(cmd)) return;
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

  // Routes /commands: UI-backed ones are handled locally (modals, silent
  // setters); transcript ops (/compact, /clear, /jail, /unjail) and unknown
  // commands go to the daemon. Returns true when fully handled.
  function routeSlash(text: string): boolean {
    const clean = text.trim();
    if (!clean.startsWith("/")) return false;
    const sp = clean.indexOf(" ");
    const head = (sp < 0 ? clean : clean.slice(0, sp)).toLowerCase();
    const arg = (sp < 0 ? "" : clean.slice(sp + 1)).trim();
    const sid = activeSessionId();
    switch (head) {
      case "/skills":
        openSettings("sec-skills");
        return true;
      case "/mcp":
        openSettings("sec-mcp");
        return true;
      case "/help":
        setHelpOpen(true);
        return true;
      case "/model":
        if (!arg) {
          toast(`Current model: ${activeModel()}`, "ok");
          return true;
        }
        setActiveModel(arg);
        if (sid && wsOpen()) sendWS({ type: "set_model", sessionId: sid, model: arg });
        toast(`Model set to ${arg}`, "ok");
        return true;
      case "/reasoning": {
        const lvl = arg.toLowerCase();
        if (!["off", "low", "medium", "high"].includes(lvl)) {
          toast(`Reasoning: ${daemonSettings().reasoning}`, "ok");
          return true;
        }
        setDaemonSettings({ ...daemonSettings(), reasoning: lvl });
        if (wsOpen()) sendWS({ type: "set_reasoning", effort: lvl });
        toast(`Reasoning effort set to ${lvl}`, "ok");
        return true;
      }
      default:
        return false;
    }
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

  // Settings revert snapshot (chatbot backupForRevert): Cancel restores.
  const [settingsSnapshot, setSettingsSnapshot] = createSignal<string | null>(null);
  const [helpOpen, setHelpOpen] = createSignal(false);
  function openSettings(sectionId?: string) {
    try {
      setSettingsSnapshot(
        JSON.stringify({
          settings: daemonSettings(),
          mcp: mcpServers(),
          skills: skills(),
          yolo: yoloMode(),
        }),
      );
    } catch {}
    setShowConfigModal(true);
    if (sectionId) {
      setTimeout(() => {
        try {
          document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch {}
      }, 80);
    }
  }
  function cancelSettings() {
    try {
      const raw = settingsSnapshot();
      if (raw) {
        const s = JSON.parse(raw);
        if (s.settings) setDaemonSettings(s.settings);
        if (s.mcp) setMcpServers(s.mcp);
        if (s.skills) setSkills(s.skills);
        if (typeof s.yolo === "boolean") setYoloMode(s.yolo);
        // Push the reverted state back so per-action saves don't linger.
        setTimeout(() => saveDaemonConfig(), 30);
      }
    } catch {}
    setShowConfigModal(false);
  }

  // Save Settings to Daemon (translate UI keys to the daemon's Go keys).
  function saveDaemonConfig() {
    const s = daemonSettings();
    sendWS({
      type: "update_config",
      requestId: "upd_" + Date.now(),
      settings: {
        model: s.model,
        reasoning: s.reasoning,
        temperature: s.temperature,
        auto_compact_threshold: s.autoCompactPercent,
        no_auto_title: s.noAutoTitle,
        jail_by_default: s.jailByDefault,
        auto_swarm_enabled: s.autoSwarmEnabled,
        insecure: s.insecureTls,
        http_proxy: s.httpProxy,
      },
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
    }
  }

  function handleDeleteSkill(name: string) {
    const current = { ...skills() };
    delete current[name];
    setSkills(current);
    toast(`Skill '${name}' removed`, "ok");
  }

  // Mount logic
  onMount(async () => {
    await loadGatewayModels();
    await loadHosts();
    if (hosts().length === 0) {
      generatePairingToken();
    }
    // Sidebar starts closed on mobile (chatbot useMobile).
    if (isMobile()) setSidebarOpen(false);
    const onResize = () => {
      try {
        setIsMobile(window.innerWidth <= 768);
      } catch {}
    };
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
    // Shortcuts: Ctrl/Cmd+K search, Ctrl/Cmd+N new conversation (chatbot).
    // Esc cascades: menus -> history -> editor -> preview -> confirm.
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setHistoryView(true);
        return;
      }
      if (mod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        startNewConversation();
        return;
      }
      if (e.key === "Escape") {
        if (confirmState()) {
          confirmState()?.resolve(false);
          setConfirmState(null);
          return;
        }
        if (largeEditorOpen()) {
          setLargeEditorOpen(false);
          return;
        }
        if (previewFile()) {
          setPreviewFile(null);
          return;
        }
        if (historyView()) {
          setHistoryView(false);
          return;
        }
        closeMenus();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
    // Floating menus live in a Portal (outside the root div), so outside
    // clicks never reach the root closer — handle them at document level.
    const onDocDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("[data-floatmenu]") || t.closest("[data-menubtn]"))) return;
      closeMenus();
    };
    document.addEventListener("pointerdown", onDocDown);
    onCleanup(() => document.removeEventListener("pointerdown", onDocDown));
  });

  createEffect(() => {
    const hid = activeHostId();
    if (hid) {
      // Switching hosts swaps the whole world: nothing from the previous
      // daemon may bleed through (frontend = dumb monitor).
      setActiveSessionId("");
      setMessages([]);
      setPendingFirstText(null);
      connectWebSocket(hid);
    }
  });

  // Default project: the one holding the newest conversation (computed from
  // the mirrored data — same answer on every device), else the first one.
  const newestSessionProjectId = createMemo(() => {
    let best: SessionSummary | null = null;
    for (const s of sessions()) {
      if (!best || s.createdAt > best.createdAt) best = s;
    }
    if (!best) return "";
    let bestId = "";
    let bestLen = -1;
    for (const p of projects()) {
      const pp = p.path.replace(/\/+$/, "");
      if (pp.length < 2) continue;
      if (sessionInPath(best, p.path) && pp.length > bestLen) {
        bestLen = pp.length;
        bestId = p.id;
      }
    }
    return bestId;
  });
  createEffect(() => {
    const list = projects();
    if (list.length === 0) {
      if (activeProjectId()) setActiveProjectId("");
      return;
    }
    if (!list.some((p) => p.id === activeProjectId())) {
      const fallback = newestSessionProjectId();
      setActiveProjectId(list.some((p) => p.id === fallback) ? fallback : list[0].id);
    }
  });

  // A conversation that vanished from the mirror (deleted here or on
  // another device) must leave no trace: close the transcript, purge its
  // usage/files/draft leftovers and drop it from bulk selection.
  let knownSessionIds = new Set<string>();
  createEffect(() => {
    const cur = new Set(sessions().map((s) => s.id));
    for (const id of knownSessionIds) {
      if (cur.has(id)) continue;
      purgeSessionTrace(id);
      if (activeSessionId() === id) {
        setActiveSessionId("");
        setMessages([]);
        setSessionStatus("idle");
      }
      if (selectedSessions().has(id)) {
        setSelectedSessions((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }
    knownSessionIds = cur;
  });

  // Default open conversation: the newest one inside the active project.
  // If the project has none, stay blank — typing in the composer starts one.
  createEffect(() => {
    if (activeSessionId()) return;
    if (!activeProjectId()) return;
    const ap = activeProject();
    if (!ap) return;
    const fresh = sessionsOfProject(ap.path)[0];
    if (fresh) selectSession(fresh.id);
  });

  // Daemon config mirror → local settings signals. Never clobbers an open
  // Settings modal (that would fight the user's in-flight edits).
  createEffect(() => {
    const doc = configDoc();
    if (!doc || showConfigModal()) return;
    const s: any = doc.settings || {};
    setDaemonSettings({
      model: s.model || "gpt-4o",
      reasoning: s.reasoning || "off",
      temperature: typeof s.temperature === "number" ? s.temperature : 0.7,
      autoCompactPercent:
        s.autoCompactPercent ??
        s.autoCompactThreshold ??
        s.auto_compact_threshold ??
        80,
      noAutoTitle: s.noAutoTitle ?? s.no_auto_title ?? false,
      jailByDefault: s.jailByDefault ?? s.jail_by_default ?? false,
      autoSwarmEnabled: s.autoSwarmEnabled ?? s.auto_swarm_enabled ?? false,
      insecureTls: s.insecureTls ?? s.insecure ?? false,
      httpProxy: s.httpProxy ?? s.http_proxy ?? "",
      maxExecutionTimeSec: s.maxExecutionTimeSec ?? 600,
    });
    if (s.model) setActiveModel(s.model);
    if (doc.mcpServers && typeof doc.mcpServers === "object") setMcpServers(doc.mcpServers);
    if (doc.skills && typeof doc.skills === "object") setSkills(doc.skills);
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

  // Per-session composer drafts (survive session switches, like the Vue app).
  createEffect(() => {
    const sid = activeSessionId();
    if (!sid) return;
    try {
      setInputPrompt(localStorage.getItem(`llmgw-draft:${sid}`) || "");
    } catch {}
  });
  createEffect(() => {
    const text = inputPrompt();
    const sid = activeSessionId();
    if (!sid) return;
    try {
      if (text) localStorage.setItem(`llmgw-draft:${sid}`, text);
      else localStorage.removeItem(`llmgw-draft:${sid}`);
    } catch {}
  });

  // Close popover menus on outside click / Escape.
  function closeMenus() {
    setDisplayMenuOpen(false);
    setNewProjectMenuOpen(false);
    setAddContextOpen(false);
    setFilesMenuOpen(false);
    setModelMenuOpen(false);
    setProjectMenuOpen(false);
    setUsageOpen(false);
  }

  onCleanup(() => {
    if (ws) {
      try {
        ws.close();
      } catch {}
    }
    clearInterval(heartbeatTimer);
  });

  // Antigravity-style tool rows: one line per call, expandable output,
  // clickable files, inline diffs for edits.
  function toolRowKey(msgId: string, u: ToolUnit, fallback: number) {
    return `${msgId}:${u.call?.toolId || u.result?.toolId || "u" + fallback}`;
  }

  function openToolPreview(u: ToolUnit) {
    const name = u.call?.toolName || "tool";
    const args = tryParseArgs(u.call?.toolArgs);
    if (name === "read") {
      setPreviewFile({
        name: baseNameOf(args.path) || "file",
        mime: "text/plain",
        text: u.result?.toolResult || "(no output captured)",
      });
    } else if (name === "write") {
      setPreviewFile({
        name: baseNameOf(args.path) || "file",
        mime: "text/plain",
        text: String(args.content || u.result?.toolResult || "(empty)"),
      });
    } else if (name === "edit") {
      setPreviewFile({
        name: (baseNameOf(args.path) || "file") + " — diff",
        mime: "text/plain",
        text: u.result?.toolResult || "(no diff captured)",
      });
    } else {
      setPreviewFile({
        name: `${name} output`,
        mime: "text/plain",
        text: u.result?.toolResult || u.call?.toolArgs || "(no output)",
      });
    }
    setPreviewCopied(false);
  }

  function renderToolUnit(msgId: string, u: ToolUnit, ui: number, running: boolean) {
    const key = () => toolRowKey(msgId, u, ui);
    const open = () => toolOpen()[key()] ?? (running && !u.result);
    const sum = toolSummary(u);
    const prog = () => (u.call?.toolId ? toolProgress()[u.call.toolId] : undefined);
    const args = tryParseArgs(u.call?.toolArgs);
    const name = u.call?.toolName || "tool";
    const failed = !!u.result?.isError;
    return (
      <div class="w-full">
        <div
          onClick={() => toggleToolOpen(key())}
          class="group/tool w-full flex items-center gap-2 pl-1 pr-1.5 py-1 rounded-lg cursor-pointer hover:bg-ink-900/70 text-[13px]"
          title={u.call?.toolArgs || name}
        >
          <Show
            when={!(running && !u.result)}
            fallback={
              <span class="w-3.5 h-3.5 border-2 border-ink-500 border-t-transparent rounded-full animate-spin shrink-0" />
            }
          >
            <Iconify
              icon={failed ? "lucide:x" : sum.icon}
              size={14}
              class={`shrink-0 ${failed ? "text-rose-400" : "text-ink-500"}`}
            />
          </Show>
          <span class="text-ink-500 shrink-0">{sum.verb}</span>
          <span class="truncate text-ink-200 font-medium min-w-0 flex-1">{sum.target}</span>
          <Show when={sum.statAdd != null || sum.statDel != null}>
            <span class="font-mono text-[11px] shrink-0">
              <Show when={(sum.statAdd || 0) > 0}>
                <span class="text-emerald-400">+{sum.statAdd}</span>
              </Show>
              <Show when={(sum.statAdd || 0) > 0 && (sum.statDel || 0) > 0}>
                <span class="text-ink-600"> </span>
              </Show>
              <Show when={(sum.statDel || 0) > 0}>
                <span class="text-rose-400">-{sum.statDel}</span>
              </Show>
            </span>
          </Show>
          <Show when={sum.stat && sum.statAdd == null}>
            <span class="text-[11px] text-ink-600 shrink-0">{sum.stat}</span>
          </Show>
          <Show when={prog()}>
            <span class="font-mono text-[11px] text-ink-600 truncate max-w-[40%]">{prog()}</span>
          </Show>
          <Iconify
            icon="lucide:chevron-down"
            size={12}
            class={`shrink-0 text-ink-600 transition-transform ${open() ? "rotate-180" : ""}`}
          />
        </div>
        <Show when={open()}>
          <div class="ml-5 mt-0.5 mb-1.5 rounded-lg border border-line/50 bg-ink-950/60 overflow-hidden">
            {/* Context body per tool kind */}
            <Show when={name === "edit" && u.result?.toolResult}>
              <DiffView text={u.result?.toolResult || ""} max={40} />
              <div class="flex items-center gap-2 px-3 py-1.5 border-t border-line/50">
                <button
                  onClick={() => openToolPreview(u)}
                  class="text-[11px] text-ink-400 hover:text-ink-100 underline underline-offset-2 cursor-pointer"
                >
                  Open Diff
                </button>
                <button
                  onClick={() => copyWithToast(u.result?.toolResult || "")}
                  class="text-[11px] text-ink-600 hover:text-ink-300 cursor-pointer"
                >
                  Copy
                </button>
              </div>
            </Show>
            <Show when={name === "read"}>
              <Show
                when={u.result?.toolResult}
                fallback={<div class="px-3 py-2 text-[11px] text-ink-600">Waiting for output…</div>}
              >
                <pre class="px-3 py-2 text-[11px] text-ink-300 overflow-x-auto max-h-56 whitespace-pre-wrap">
                  {(u.result?.toolResult || "").slice(0, 3000)}
                </pre>
                <div class="px-3 py-1.5 border-t border-line/50">
                  <button
                    onClick={() => openToolPreview(u)}
                    class="text-[11px] text-ink-400 hover:text-ink-100 underline underline-offset-2 cursor-pointer"
                  >
                    Open file
                  </button>
                </div>
              </Show>
            </Show>
            <Show when={name === "write"}>
              <pre class="px-3 py-2 text-[11px] text-ink-300 overflow-x-auto max-h-56 whitespace-pre-wrap">
                {String(args.content || u.result?.toolResult || "").slice(0, 3000)}
              </pre>
              <div class="px-3 py-1.5 border-t border-line/50">
                <button
                  onClick={() => openToolPreview(u)}
                  class="text-[11px] text-ink-400 hover:text-ink-100 underline underline-offset-2 cursor-pointer"
                >
                  Open file
                </button>
              </div>
            </Show>
            <Show when={name !== "edit" && name !== "read" && name !== "write"}>
              <Show
                when={u.result?.toolResult}
                fallback={<div class="px-3 py-2 text-[11px] text-ink-600">Waiting for output…</div>}
              >
                <pre class="px-3 py-2 text-[11px] text-ink-300 overflow-x-auto max-h-56 whitespace-pre-wrap">
                  {(u.result?.toolResult || "").slice(0, 3000)}
                </pre>
              </Show>
            </Show>
          </div>
        </Show>
      </div>
    );
  }

  function groupTitle(cat: "explore" | "command", units: ToolUnit[]): string {
    if (cat === "command") {
      return `Ran ${units.length} command${units.length === 1 ? "" : "s"}`;
    }
    const files = units.filter((u) => u.call?.toolName === "read").length;
    const searches = units.filter((u) => u.call?.toolName === "glob").length;
    let t = `Explored ${files} file${files === 1 ? "" : "s"}`;
    if (searches > 0) t += `, ${searches} search${searches === 1 ? "" : "es"}`;
    return t;
  }

  function renderToolSegs(msgId: string, units: ToolUnit[], running: boolean) {
    // Partition consecutive explore/command runs into collapsible groups.
    const segs: Array<{ kind: "group"; cat: "explore" | "command"; units: ToolUnit[] } | { kind: "unit"; unit: ToolUnit; idx: number }> = [];
    let run: ToolUnit[] = [];
    let runIdx: number[] = [];
    let runCat: "explore" | "command" | null = null;
    const flush = () => {
      if (run.length >= 2 && runCat) segs.push({ kind: "group", cat: runCat, units: run });
      else run.forEach((unit, k) => segs.push({ kind: "unit", unit, idx: runIdx[k] }));
      run = [];
      runIdx = [];
      runCat = null;
    };
    units.forEach((unit, i) => {
      const cat = toolCatOf(unit.call?.toolName);
      if ((cat === "explore" || cat === "command") && (runCat === null || runCat === cat)) {
        runCat = cat;
        run.push(unit);
        runIdx.push(i);
      } else {
        flush();
        if (cat === "explore" || cat === "command") {
          runCat = cat;
          run.push(unit);
          runIdx.push(i);
        } else {
          segs.push({ kind: "unit", unit, idx: i });
        }
      }
    });
    flush();
    return (
      <div class="w-full space-y-0.5">
        <For each={segs}>
          {(seg, si) => {
            if (seg.kind === "unit") return renderToolUnit(msgId, seg.unit, seg.idx, running);
            const gkey = `${msgId}:g${si()}`;
            const open = () => toolGroupOpen()[gkey] ?? true;
            return (
              <div class="w-full">
                <button
                  onClick={() => toggleToolGroup(gkey)}
                  class="w-full flex items-center gap-1.5 pl-1 pr-1.5 py-1 rounded-lg hover:bg-ink-900/70 text-[13px] text-ink-400 hover:text-ink-200 cursor-pointer"
                >
                  <span class="font-medium">{groupTitle(seg.cat, seg.units)}</span>
                  <Iconify
                    icon="lucide:chevron-down"
                    size={12}
                    class={`text-ink-600 transition-transform ${open() ? "rotate-180" : ""}`}
                  />
                </button>
                <Show when={open()}>
                  <div class="ml-3 border-l border-line/40 pl-1.5 space-y-0.5">
                    <For each={seg.units}>
                      {(u, ui) => renderToolUnit(msgId, u, ui() + si() * 100, running)}
                    </For>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    );
  }

  // One session row, reused by the nested project groups and the flat list.
  function sessionRow(s: SessionSummary) {    const isActive = () => s.id === activeSessionId();
    const selected = () => selectedSessions().has(s.id);
    return (
      <div
        onClick={() => {
          if (selectionMode()) {
            toggleSessionSelect(s.id);
            return;
          }
          setHistoryView(false);
          selectSession(s.id);
          closeSidebarOnMobile();
        }}
        onDblClick={() => {
          if (selectionMode()) return;
          setRenamingId(s.id);
          setRenameText(s.title);
        }}
        class={`group flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg cursor-pointer text-[13px] transition-colors ${
          isActive() && !selectionMode()
            ? "bg-ink-800 text-ink-50"
            : selected()
              ? "bg-ink-900 text-ink-100 ring-1 ring-ink-500/50"
              : "text-ink-400 hover:bg-ink-900/60 hover:text-ink-200"
        }`}
        title={`${s.title}\n${s.cwd}`}
      >
        <Show when={selectionMode()}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleSessionSelect(s.id);
            }}
            class={`w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
              selected() ? "bg-ink-100 border-ink-100" : "border-line bg-ink-950"
            }`}
            title="Select"
          >
            <Show when={selected()}>
              <Iconify icon="lucide:check" size={11} class="text-ink-950" />
            </Show>
          </button>
        </Show>
        <Show when={s.pinned && !selectionMode()}>
          <Iconify icon="lucide:pin" size={11} class="text-ink-500 shrink-0" />
        </Show>
        <Show
          when={renamingId() === s.id}
          fallback={
            <>
              <span class="truncate flex-1 min-w-0">{s.title}</span>
              <span class="text-[10px] text-ink-600 shrink-0">{timeAgo(s.updatedAt)}</span>
              <Show when={s.status === "running"}>
                <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
              </Show>
              <Show when={!selectionMode()}>
                <div class="hidden group-hover:flex items-center shrink-0">
                  <button
                    onClick={(e) => togglePin(s.id, e)}
                    class="p-0.5 text-ink-600 hover:text-ink-200 cursor-pointer"
                    title={s.pinned ? "Unpin" : "Pin"}
                  >
                    <Iconify icon={s.pinned ? "lucide:pin-off" : "lucide:pin"} size={11} />
                  </button>
                  <button
                    onClick={(e) => deleteSession(s.id, e)}
                    class="p-0.5 text-ink-600 hover:text-rose-400 cursor-pointer"
                    title="Delete"
                  >
                    <Iconify icon="lucide:trash-2" size={11} />
                  </button>
                </div>
              </Show>
            </>
          }
        >
          <input
            type="text"
            class="flex-1 min-w-0 bg-ink-950 border border-ink-500 rounded px-1.5 py-0.5 text-[13px] text-ink-100 focus:outline-none"
            value={renameText()}
            onInput={(e) => setRenameText(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") submitRename(s.id);
              if (e.key === "Escape") setRenamingId(null);
            }}
            onClick={(e) => e.stopPropagation()}
            ref={(el) => setTimeout(() => el?.select(), 30)}
          />
        </Show>
      </div>
    );
  }

  return (
    <div
      class="fixed inset-0 w-screen h-screen flex flex-col bg-ink-950 text-ink-100 overflow-hidden font-sans select-none z-50"
      onClick={closeMenus}
    >

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
                            `./llmgw-daemon -connect "${pairingData()?.connectUrl}"`,
                          )
                        }
                        class="text-brand-400 hover:text-brand-300 flex items-center gap-1 text-[11px] cursor-pointer"
                      >
                        <Iconify icon="lucide:copy" size={12} />
                        <span>Copy Command</span>
                      </button>
                    </div>
                    <div class="p-3 rounded-xl bg-ink-950 border border-line font-mono text-xs text-brand-300 break-all select-all">
                      ./llmgw-daemon -connect "{pairingData()?.connectUrl}"
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
        {/* Mobile: overlay drawer with backdrop (chatbot useMobile). */}
        <Show when={isMobile() && sidebarOpen()}>
          <div
            class="fixed inset-0 z-30 bg-black/55 backdrop-blur-sm md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        </Show>
        <aside
          class={`border-r border-line/70 bg-ink-950 flex flex-col shrink-0 transition-all duration-200 ${
            sidebarOpen()
              ? isMobile()
                ? "fixed inset-y-0 left-0 z-40 w-72 shadow-2xl"
                : "w-64"
              : "w-0 overflow-hidden border-r-0"
          }`}
        >
          {/* New Conversation */}
          <div class="p-2">
            <button
              onClick={() => {
                startNewConversation();
                closeSidebarOnMobile();
              }}
              class="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-ink-900 hover:bg-ink-800 border border-line/60 text-[13px] font-medium text-ink-200 transition-colors cursor-pointer"
            >
              <Iconify icon="lucide:plus" size={14} />
              <span>New Conversation</span>
            </button>
            <button
              onClick={() => {
                setHistoryView(true);
                closeSidebarOnMobile();
              }}
              class="w-full flex items-center gap-2 px-3 py-1.5 mt-1 rounded-lg text-xs text-ink-500 hover:text-ink-300 hover:bg-ink-900/60 transition-colors cursor-pointer"
            >
              <Iconify icon="lucide:clock" size={13} />
              <span>Conversation History</span>
            </button>
          </div>


          {/* Projects */}
          <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-3 min-h-0">
              <div class="flex items-center justify-between px-1.5 py-1 bg-ink-950 border-b border-line/50">
                <Show
                  when={selectionMode()}
                  fallback={
                    <span class="text-[11px] font-medium text-ink-500">Projects</span>
                  }
                >
                  <span class="text-[11px] font-medium text-ink-300">
                    {selectedSessions().size} selected
                  </span>
                </Show>
                <div class="flex items-center gap-0.5">
                  {/* Selection mode toggle (chatbot) */}
                  <button
                    onClick={() => {
                      if (selectionMode()) exitSelectionMode();
                      else setSelectionMode(true);
                    }}
                    class={`p-1 rounded cursor-pointer ${selectionMode() ? "bg-ink-800 text-ink-100" : "text-ink-500 hover:text-ink-200 hover:bg-ink-900"}`}
                    title={selectionMode() ? "Exit selection mode" : "Select conversations"}
                  >
                    <Iconify icon={selectionMode() ? "lucide:x" : "lucide:list-todo"} size={13} />
                  </button>
                  {/* Display Options */}
            <div class="shrink-0">
              <button
                ref={displayBtn}
                data-menubtn
                onClick={(e) => {
                  e.stopPropagation();
                  setDisplayMenuOpen(!displayMenuOpen());
                  setNewProjectMenuOpen(false);
                }}
                class="p-1.5 rounded-lg text-ink-500 hover:text-ink-200 hover:bg-ink-900 cursor-pointer"
                title="Display options"
              >
                <Iconify icon="lucide:list-filter" size={14} />
              </button>
              <FloatMenu anchor={() => displayBtn} open={displayMenuOpen()} placement="bottom-start" width="13rem">
                  <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
                    Group by
                  </div>
                  <For each={[["project", "Project"], ["none", "None"]] as const}>
                    {([v, label]) => (
                      <button
                        onClick={() => {
                          setGroupBy(v);
                          try { localStorage.setItem("llmgw-rc-groupby", v); } catch {}
                        }}
                        class="w-full text-left px-2.5 py-1.5 rounded-lg text-ink-300 hover:bg-ink-800/60 flex items-center justify-between cursor-pointer"
                      >
                        <span>{label}</span>
                        <Show when={groupBy() === v}>
                          <Iconify icon="lucide:check" size={13} />
                        </Show>
                      </button>
                    )}
                  </For>
                  <div class="mt-1 pt-1 border-t border-line/60 px-2 py-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
                    Sort conversations
                  </div>
                  <For each={[["updated", "Last updated"], ["added", "Date added"], ["alpha", "Alphabetical (A-Z)"]] as const}>
                    {([v, label]) => (
                      <button
                        onClick={() => {
                          setSortBy(v);
                          try { localStorage.setItem("llmgw-rc-sort", v); } catch {}
                        }}
                        class="w-full text-left px-2.5 py-1.5 rounded-lg text-ink-300 hover:bg-ink-800/60 flex items-center justify-between cursor-pointer"
                      >
                        <span>{label}</span>
                        <Show when={sortBy() === v}>
                          <Iconify icon="lucide:check" size={13} />
                        </Show>
                      </button>
                    )}
                  </For>
              </FloatMenu>
            </div>
                  {/* New Project split button (Antigravity: New Project / Quick Start) */}
                <div>
                  <button
                    ref={newProjBtn}
                    data-menubtn
                    onClick={(e) => {
                      e.stopPropagation();
                      setNewProjectMenuOpen(!newProjectMenuOpen());
                      setDisplayMenuOpen(false);
                    }}
                    class="p-1 rounded text-ink-500 hover:text-ink-200 hover:bg-ink-900 cursor-pointer"
                    title="Create new project"
                  >
                    <Iconify icon="lucide:folder-plus" size={13} />
                  </button>
                  <FloatMenu anchor={() => newProjBtn} open={newProjectMenuOpen()} placement="bottom-start" width="11rem">
                      <button
                        onClick={() => {
                          setNewProjectMenuOpen(false);
                          openNewProjectModal();
                        }}
                        class="w-full text-left px-2.5 py-1.5 rounded-lg text-ink-200 hover:bg-ink-800/60 flex items-center gap-2 cursor-pointer"
                      >
                        <Iconify icon="lucide:folder-plus" size={13} />
                        <span>New Project</span>
                      </button>
                      <button
                        onClick={() => {
                          setNewProjectMenuOpen(false);
                          quickStartProject();
                        }}
                        class="w-full text-left px-2.5 py-1.5 rounded-lg text-ink-300 hover:bg-ink-800/60 flex items-center gap-2 cursor-pointer"
                      >
                        <Iconify icon="lucide:zap" size={13} />
                        <span>Quick Start</span>
                      </button>
                  </FloatMenu>
                  </div>
                </div>
              </div>
              <Show
                when={projects().length > 0}
                fallback={
                  <button
                    onClick={openNewProjectModal}
                    class="w-full text-left px-2.5 py-2 rounded-lg border border-dashed border-line text-xs text-ink-500 hover:text-ink-300 hover:border-ink-500 transition-colors cursor-pointer"
                  >
                    + Select a project folder on the host
                  </button>
                }
              >
                {/* Nested view (Antigravity): sessions live under their project */}
                <Show
                  when={groupBy() === "project"}
                  fallback={
                    <div class="space-y-0.5">
                      <For
                        each={sortedSessions(sessions().filter(matchQuery))}
                        fallback={
                          <div class="px-2.5 py-3 text-xs text-ink-600">
                            No conversations yet. Start one above.
                          </div>
                        }
                      >
                        {(s) => sessionRow(s)}
                      </For>
                    </div>
                  }
                >
                  <div class="space-y-2">
                    <For each={projects()}>
                      {(p) => {
                        const list = () => projectSessions(p.path);
                        return (
                          <div>
                            <div
                              onClick={() => {
                                pickProject(p.id);
                                toggleProjectExpanded(p.id);
                              }}
                              class={`group flex items-center gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer text-[13px] transition-colors ${
                                p.id === (activeProject()?.id || "")
                                  ? "text-ink-100"
                                  : "text-ink-400 hover:bg-ink-900/60 hover:text-ink-200"
                              }`}
                              title={p.path}
                            >
                              <Iconify
                                icon="lucide:chevron-right"
                                size={12}
                                class={`shrink-0 text-ink-600 transition-transform ${isProjectExpanded(p) ? "rotate-90" : ""}`}
                              />
                              <Iconify icon="lucide:folder" size={14} class="shrink-0 text-ink-500" />
                              <span class="truncate flex-1 font-medium">{p.name}</span>
                              <button
                                onClick={(e) => deleteProject(p.id, e)}
                                class="opacity-0 group-hover:opacity-100 p-0.5 text-ink-600 hover:text-rose-400 cursor-pointer shrink-0"
                                title="Remove project"
                              >
                                <Iconify icon="lucide:x" size={12} />
                              </button>
                            </div>
                            <Show when={isProjectExpanded(p)}>
                              <div class="ml-[13px] mt-0.5 space-y-0.5 border-l border-line/50 pl-1.5">
                                <For each={list()}>
                                  {(s) => sessionRow(s)}
                                </For>
                              </div>
                            </Show>
                          </div>
                        );
                      }}
                    </For>
                    <Show when={looseSessions().length > 0}>
                      <div>
                        <div class="px-2 py-1.5 text-[11px] font-medium text-ink-600">
                          Not in Project
                        </div>
                        <div class="space-y-0.5">
                          <For each={looseSessions()}>
                            {(s) => sessionRow(s)}
                          </For>
                        </div>
                      </div>
                    </Show>
                  </div>
                </Show>
              </Show>
            </div>
          {/* Batch bar (chatbot selection mode) */}
          <Show when={selectionMode() && selectedSessions().size > 0}>
            <div class="p-2 border-t border-line/70 bg-ink-950/95">
              <div class="flex items-center justify-between gap-2">
                <span class="text-[11px] text-ink-500 pl-1">
                  {selectedSessions().size} selected
                </span>
                <div class="flex items-center gap-1.5">
                  <button
                    onClick={pinSelected}
                    class="px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-ink-900 border border-line/70 text-ink-300 hover:text-ink-100 cursor-pointer"
                  >
                    Pin / Unpin
                  </button>
                  <button
                    onClick={deleteSelected}
                    class="px-2.5 py-1.5 rounded-lg text-[11px] font-medium bg-rose-500/10 border border-rose-500/30 text-rose-300 hover:bg-rose-500/20 cursor-pointer"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          </Show>

          {/* Sidebar Footer: host switcher + settings (Antigravity) */}
          <div class="p-2 border-t border-line/70 space-y-1">
            <div class="flex items-center gap-1.5 px-1">
              <span class={`w-1.5 h-1.5 rounded-full shrink-0 ${activeHost()?.status === "online" ? "bg-emerald-500" : "bg-amber-500"}`} />
              <div class="flex-1 min-w-0">
                <Select
                  value={activeHostId()}
                  onChange={(v) => setActiveHostId(v)}
                  options={hosts().map((h) => ({
                    value: h.id,
                    label: `${h.name || h.hostname || h.id} (${h.status || "offline"})`,
                  }))}
                />
              </div>
              <button
                onClick={loadHosts}
                class="p-1 rounded text-ink-500 hover:text-ink-200 hover:bg-ink-900 cursor-pointer shrink-0"
                title="Refresh hosts"
              >
                <Iconify icon="lucide:refresh-cw" size={12} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  generatePairingToken();
                }}
                class="p-1 rounded text-ink-500 hover:text-ink-200 hover:bg-ink-900 cursor-pointer shrink-0"
                title="Connect another host"
              >
                <Iconify icon="lucide:plus" size={12} />
              </button>
            </div>
            {/* () => … — openSettings takes an optional section id; passing it
                directly would feed the MouseEvent in as the section. */}
            <button
              onClick={() => openSettings()}
              class="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-ink-500 hover:text-ink-200 hover:bg-ink-900/60 transition-colors cursor-pointer"
            >
              <Iconify icon="lucide:settings" size={14} />
              <span>Settings</span>
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
                  Host <strong>{activeHost()?.name || activeHost()?.hostname || activeHost()?.id}</strong> is offline. Start the daemon on your machine: <code class="bg-amber-500/20 px-1 py-0.5 rounded font-mono">./llmgw-daemon</code>
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

          {/* Floating top-left: back + sidebar toggle (no topbar) */}
          <div class="absolute top-2 left-2 z-20 flex items-center gap-1.5">
            <a
              href="#/"
              class="p-1.5 rounded-md bg-ink-900/80 hover:bg-ink-800 border border-line/70 text-ink-400 hover:text-ink-200 transition-colors shadow-sm"
              title="Back to LLM Gateway"
            >
              <Iconify icon="lucide:arrow-left" size={14} />
            </a>
            <button
              onClick={() => setSidebarOpen(!sidebarOpen())}
              class="p-1.5 rounded-md bg-ink-900/80 hover:bg-ink-800 border border-line/70 text-ink-400 hover:text-ink-200 transition-colors shadow-sm cursor-pointer"
              title={sidebarOpen() ? "Collapse sidebar" : "Expand sidebar"}
            >
              <Iconify
                icon={
                  sidebarOpen()
                    ? "lucide:panel-left-close"
                    : "lucide:panel-left-open"
                }
                size={14}
              />
            </button>
          </div>

          {/* Chat Stream Viewport */}
          <Show
            when={!historyView()}
            fallback={
              <div class="flex-1 overflow-y-auto px-4 md:px-8 py-8">
                <div class="max-w-2xl mx-auto">
                  <div class="flex items-center justify-between mb-4">
                    <h2 class="text-base font-semibold text-ink-100">Conversation History</h2>
                    <button
                      onClick={() => setHistoryView(false)}
                      class="p-1.5 rounded-lg text-ink-400 hover:text-ink-100 hover:bg-ink-900 cursor-pointer"
                      title="Back to chat"
                    >
                      <Iconify icon="lucide:x" size={15} />
                    </button>
                  </div>
                  <div class="relative mb-4">
                    <Iconify icon="lucide:search" size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-ink-600" />
                    <input
                      type="text"
                      placeholder={
                        isMobile()
                          ? "Search conversations and messages..."
                          : "Search conversations and messages... (Ctrl+K)"
                      }
                      class="w-full text-[13px] bg-ink-900 border border-line/70 rounded-xl pl-9 pr-3 py-2 text-ink-100 placeholder:text-ink-600 focus:outline-none focus:border-ink-500"
                      value={sessionFilter()}
                      onInput={(e) => {
                        setSessionFilter(e.currentTarget.value);
                        queueDaemonSearch(e.currentTarget.value);
                      }}
                      ref={(el) => setTimeout(() => el?.focus(), 50)}
                    />
                  </div>
                  {/* Daemon full-text hits (message content, host-local) */}
                  <Show when={searchResults().length > 0}>
                    <div class="px-1 pb-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
                      Message matches
                    </div>
                    <div class="space-y-1 mb-4">
                      <For each={searchResults()}>
                        {(r) => (
                          <button
                            onClick={() => {
                              setHistoryView(false);
                              setSearchResults([]);
                              selectSession(r.sessionId);
                            }}
                            class="w-full text-left px-3 py-2.5 rounded-xl border border-line/50 hover:bg-ink-900/70 transition-colors cursor-pointer"
                          >
                            <div class="flex items-center justify-between gap-3">
                              <span class="text-[13px] text-ink-200 truncate font-medium">{r.title}</span>
                              <span class="text-[11px] text-ink-600 shrink-0">
                                {r.matchCount > 1 ? `${r.matchCount} hits · ` : ""}{timeAgo(r.updatedAt)}
                              </span>
                            </div>
                            <p class="text-[11px] text-ink-500 mt-1 line-clamp-2 leading-relaxed">{r.snippet}</p>
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                  <div class="px-1 pb-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
                    Conversations
                  </div>
                  <div class="space-y-1">
                    <For
                      each={sortedSessions(sessions().filter(matchQuery))}
                      fallback={
                        <p class="text-xs text-ink-600 py-6 text-center">No conversations found.</p>
                      }
                    >
                      {(s) => (
                        <button
                          onClick={() => {
                            setHistoryView(false);
                            selectSession(s.id);
                          }}
                          class="w-full text-left px-3 py-2.5 rounded-xl hover:bg-ink-900/70 transition-colors group cursor-pointer"
                        >
                          <div class="flex items-center justify-between gap-3">
                            <span class="text-[13px] text-ink-200 truncate font-medium">{s.title}</span>
                            <span class="text-[11px] text-ink-600 shrink-0">{timeAgo(s.updatedAt)}</span>
                          </div>
                          <div class="flex items-center gap-1.5 mt-0.5 text-[11px] text-ink-500">
                            <Iconify icon="lucide:folder" size={11} />
                            <span class="truncate font-mono">{s.cwd}</span>
                          </div>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </div>
            }
          >
          <div
            ref={setChatContainerRef}
            onScroll={onChatScroll}
            class="flex-1 overflow-y-auto px-4 md:px-8 py-6 space-y-6 select-text scroll-smooth"
          >
            {/* Empty state: subtle hint only — the real input is the
                composer pinned at the bottom, never something mid-screen. */}
            <Show when={messages().length === 0 && !activeSessionId()}>
              <div class="max-w-xl mx-auto my-16 text-center">
                <Show
                  when={activeProject()}
                  fallback={
                    <div class="space-y-3">
                      <div class="text-sm text-ink-300 font-medium">No project yet</div>
                      <p class="text-xs text-ink-500 max-w-sm mx-auto leading-relaxed">
                        Projects are just folders on the host. Create one first — every conversation lives inside a project.
                      </p>
                      <div class="flex items-center justify-center gap-2 pt-1">
                        <button
                          onClick={openNewProjectModal}
                          class="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-ink-100 text-ink-950 text-[13px] font-medium hover:bg-white cursor-pointer"
                        >
                          <Iconify icon="lucide:folder-plus" size={14} />
                          <span>Select project folder</span>
                        </button>
                        <button
                          onClick={quickStartProject}
                          class="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-line text-[13px] text-ink-300 hover:text-ink-100 hover:bg-ink-900 cursor-pointer"
                          title="Use your home folder (~) as the project"
                        >
                          <Iconify icon="lucide:zap" size={14} />
                          <span>Quick start (~)</span>
                        </button>
                      </div>
                    </div>
                  }
                >
                  <p class="text-xs text-ink-600">
                    Type below to start a conversation in{" "}
                    <span class="text-ink-300 font-mono">{activeProject()?.path}</span>
                  </p>
                </Show>
              </div>
            </Show>

            {/* Conversation Messages */}
            <For each={messages()}>
              {(msg, idx) => {
                const isLast = () => idx() === messages().length - 1;
                const textOf = () =>
                  msg.blocks
                    .filter((b) => b.type === "text" && b.text)
                    .map((b) => b.text as string)
                    .join("\n");
                return (
                  <div
                    class={`group/msg flex flex-col w-full ${convWidthClass()} mx-auto ${
                      msg.role === "user" ? "items-end" : "items-start"
                    }`}
                  >
                    {/* ===== SYSTEM NOTICE (e.g. auto-compaction) ===== */}
                    <Show when={msg.system}>
                      <div class="w-full flex justify-center">
                        <div class="max-w-xl text-center px-4 py-2.5 rounded-xl border border-line/60 bg-ink-900/60">
                          <div class="flex items-center justify-center gap-1.5 text-xs font-medium text-ink-300">
                            <Iconify icon="lucide:boxes" size={13} class="text-ink-500" />
                            <span>Context auto-compacted — oldest 30% summarized</span>
                          </div>
                          <details class="mt-1.5 text-left">
                            <summary class="text-[11px] text-ink-500 hover:text-ink-300 cursor-pointer select-none text-center">
                              View summary
                            </summary>
                            <div class="rc-markdown mt-2 text-left text-xs max-h-48 overflow-y-auto">
                              <Streamdown>{textOf().replace(/^## Context Summary \(compacted\)\n\n/, "")}</Streamdown>
                            </div>
                          </details>
                        </div>
                      </div>
                    </Show>
                    <Show when={!msg.system}>
                    {/* ===== USER ===== */}
                    <Show when={msg.role === "user"}>
                      <div class="flex flex-col items-end max-w-[90%] sm:max-w-[80%]">
                        <Show when={msg.attachments && msg.attachments.length > 0}>
                          <div class="flex flex-wrap gap-1.5 mb-1.5 justify-end">
                            <For each={msg.attachments || []}>
                              {(name) => (
                                <span class="text-[11px] bg-ink-900 border border-line/70 px-2 py-1 rounded-lg text-ink-400 flex items-center gap-1.5">
                                  <Iconify icon="lucide:paperclip" size={11} />
                                  {name}
                                </span>
                              )}
                            </For>
                          </div>
                        </Show>
                        {/* Inline edit mode (chatbot) */}
                        <Show
                          when={editingMsgIdx() === idx()}
                          fallback={
                            <div class="bg-ink-900 border border-line/70 text-ink-100 px-3.5 py-2.5 rounded-2xl rounded-tr-md">
                              <p class="whitespace-pre-line text-sm leading-relaxed">{textOf()}</p>
                            </div>
                          }
                        >
                          <div class="w-full bg-ink-900 p-3 rounded-2xl border border-ink-500/60">
                            <textarea
                              value={editingMsgText()}
                              onInput={(e) => setEditingMsgText(e.currentTarget.value)}
                              class="w-full bg-transparent text-ink-100 text-sm outline-none resize-none"
                              rows={4}
                              ref={(el) => setTimeout(() => el?.focus(), 40)}
                            />
                            <div class="flex justify-between items-center mt-2">
                              <button
                                onClick={() => {
                                  setEditingMsgText(messageText(msg));
                                  setLargeEditorOpen(true);
                                }}
                                class="p-1.5 hover:bg-ink-800 rounded-lg text-ink-500 hover:text-ink-200 cursor-pointer"
                                title="Expand editor"
                              >
                                <Iconify icon="lucide:expand" size={14} />
                              </button>
                              <div class="flex gap-2">
                                <button
                                  onClick={cancelEditMsg}
                                  class="text-xs text-ink-400 hover:text-ink-100 px-2 py-1 cursor-pointer"
                                >
                                  Cancel
                                </button>
                                <button
                                  onClick={() => saveEditMsg(idx(), msg)}
                                  class="text-xs bg-ink-100 text-ink-950 px-3 py-1 rounded-lg hover:bg-white font-medium cursor-pointer"
                                >
                                  Save and Send
                                </button>
                              </div>
                            </div>
                          </div>
                        </Show>
                        <Show when={editingMsgIdx() !== idx()}>
                          <div class="flex items-center gap-0.5 mt-1 opacity-0 group-hover/msg:opacity-100 transition-opacity">
                            <button
                              onClick={() => copyMsg(msg.id, textOf())}
                              class="p-1 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-900 transition-colors cursor-pointer"
                              title="Copy"
                            >
                              <Iconify icon={copiedMsgId() === msg.id ? "lucide:check" : "lucide:copy"} size={13} />
                            </button>
                            <button
                              onClick={() => startEditMsg(idx(), msg)}
                              class="p-1 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-900 transition-colors cursor-pointer"
                              title="Edit and resend"
                            >
                              <Iconify icon="lucide:pencil" size={13} />
                            </button>
                            <button
                              onClick={() => editUserMsg(msg)}
                              class="p-1 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-900 transition-colors cursor-pointer"
                              title="Edit in large editor"
                            >
                              <Iconify icon="lucide:expand" size={13} />
                            </button>
                            <button
                              onClick={() => deleteMsg(idx())}
                              class="p-1 rounded-md text-ink-500 hover:text-rose-400 hover:bg-ink-900 transition-colors cursor-pointer"
                              title="Delete"
                            >
                              <Iconify icon="lucide:trash-2" size={13} />
                            </button>
                          </div>
                        </Show>
                      </div>
                    </Show>

                    {/* ===== ASSISTANT ===== */}
                    <Show when={msg.role !== "user"}>
                      <div class="w-full flex flex-col items-start overflow-hidden">
                        {/* Loading dots while the first tokens arrive */}
                        <Show
                          when={
                            sessionStatus() === "running" &&
                            isLast() &&
                            msg.blocks.length === 0
                          }
                        >
                          <div class="dot-typing flex items-center gap-1 px-1 py-2">
                            <span class="w-1.5 h-1.5 bg-ink-500 rounded-full inline-block" />
                            <span class="w-1.5 h-1.5 bg-ink-500 rounded-full inline-block" />
                            <span class="w-1.5 h-1.5 bg-ink-500 rounded-full inline-block" />
                          </div>
                        </Show>

                        {/* Inline edit mode for assistant text (chatbot) */}
                        <Show
                          when={editingMsgIdx() === idx()}
                          fallback={
                        <div class="w-full space-y-2.5">
                          <For each={splitToolRuns(msg.blocks)}>
                            {(part) => {
                              if (part.kind === "tools") {
                                return (
                                  <Show when={verboseChat()}>
                                    {renderToolSegs(msg.id, part.units, isLast() && sessionStatus() === "running")}
                                  </Show>
                                );
                              }
                              return (
                                <For each={part.blocks}>
                                  {(block) => {
                                    if (block.type === "text" && block.text) {
                                      return (
                                        <div class="rc-markdown w-full text-sm leading-relaxed break-words overflow-x-auto">
                                          <Streamdown>{block.text}</Streamdown>
                                        </div>
                                      );
                                    }
                                    if (block.type === "reasoning" && block.reasoning) {
                                      const live = () =>
                                        isLast() &&
                                        sessionStatus() === "running" &&
                                        thinkingStart() !== null;
                                      return (
                                        <Show when={verboseChat()}>
                                          <div class="w-full">
                                            <button
                                              onClick={() =>
                                                setExpandedThinking((prev) => ({
                                                  ...prev,
                                                  [msg.id]: !prev[msg.id],
                                                }))
                                              }
                                              class={`flex items-center gap-1.5 text-xs transition-colors cursor-pointer ${
                                                live() ? "text-ink-300" : "text-ink-500 hover:text-ink-300"
                                              }`}
                                            >
                                              <Iconify icon="lucide:bot" size={14} />
                                              <span>
                                                {live()
                                                  ? `Thinking ${thinkingElapsed()}s`
                                                  : msg.thinkingDuration
                                                    ? `Thinking ${msg.thinkingDuration}s`
                                                    : expandedThinking()[msg.id]
                                                      ? "Hide thinking"
                                                      : "Thinking"}
                                              </span>
                                              <Show when={live()}>
                                                <span class="thinking-indicator">
                                                  <span />
                                                  <span />
                                                  <span />
                                                </span>
                                              </Show>
                                              <Iconify
                                                icon="lucide:chevron-down"
                                                size={12}
                                                class={`transition-transform ${expandedThinking()[msg.id] ? "rotate-180" : ""}`}
                                              />
                                            </button>
                                            <Show when={expandedThinking()[msg.id] || live()}>
                                              <div class="mt-1.5 pl-3 border-l-2 border-line text-ink-400 whitespace-pre-wrap text-xs leading-relaxed">
                                                {block.reasoning}
                                              </div>
                                            </Show>
                                          </div>
                                        </Show>
                                      );
                                    }
                                    if (block.type === "image") {
                                      const src = () =>
                                        block.imageData
                                          ? `data:${block.imageMime || "image/jpeg"};base64,${block.imageData}`
                                          : undefined;
                                      return (
                                        <Show
                                          when={src()}
                                          fallback={
                                            <div class="flex items-center gap-1.5 text-[11px] text-ink-500 border border-line/60 rounded-lg px-2 py-1">
                                              <Iconify icon="lucide:image" size={12} />
                                              <span>[attached {block.text || "image"}]</span>
                                            </div>
                                          }
                                        >
                                          <button
                                            onClick={() =>
                                              setPreviewFile({
                                                name: "attached image",
                                                mime: block.imageMime || "image/jpeg",
                                                dataUrl: src(),
                                              })
                                            }
                                            class="block rounded-lg overflow-hidden border border-line/60 hover:border-ink-500 transition-colors cursor-pointer"
                                            title="Open preview"
                                          >
                                            <img src={src()} class="max-h-64 max-w-full object-contain" />
                                          </button>
                                        </Show>
                                      );
                                    }
                                    return null;
                                  }}
                                </For>
                              );
                            }}
                          </For>
                        </div>
                          }
                        >
                          <div class="w-full bg-ink-900 p-3 rounded-2xl border border-ink-500/60">
                            <textarea
                              value={editingMsgText()}
                              onInput={(e) => setEditingMsgText(e.currentTarget.value)}
                              class="w-full bg-transparent text-ink-200 text-sm outline-none resize-none"
                              rows={8}
                              ref={(el) => setTimeout(() => el?.focus(), 40)}
                            />
                            <div class="flex justify-end gap-2 mt-2">
                              <button
                                onClick={cancelEditMsg}
                                class="text-xs text-ink-400 hover:text-ink-100 px-2 py-1 cursor-pointer"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => saveEditMsg(idx(), msg)}
                                class="text-xs bg-ink-100 text-ink-950 px-3 py-1 rounded-lg hover:bg-white font-medium cursor-pointer"
                              >
                                Save
                              </button>
                            </div>
                          </div>
                        </Show>

                        {/* Hover actions (chatbot-style) */}
                        <Show when={(!sessionStatus() || !isLast()) && editingMsgIdx() !== idx()}>
                          <div class="flex items-center gap-0.5 mt-1.5 opacity-0 group-hover/msg:opacity-100 transition-opacity">
                            <button
                              onClick={() => copyMsg(msg.id, textOf())}
                              class="p-1.5 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-900 transition-colors cursor-pointer"
                              title="Copy"
                            >
                              <Iconify icon={copiedMsgId() === msg.id ? "lucide:check" : "lucide:copy"} size={14} />
                            </button>
                            <button
                              onClick={() => regenerateMsg(idx())}
                              class="p-1.5 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-900 transition-colors cursor-pointer"
                              title="Regenerate response"
                            >
                              <Iconify icon="lucide:rotate-cw" size={14} />
                            </button>
                            <button
                              onClick={() => startEditMsg(idx(), msg)}
                              class="p-1.5 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-900 transition-colors cursor-pointer"
                              title="Edit response"
                            >
                              <Iconify icon="lucide:pencil" size={14} />
                            </button>
                            <button
                              onClick={() => deleteMsg(idx())}
                              class="p-1.5 rounded-md text-ink-500 hover:text-rose-400 hover:bg-ink-900 transition-colors cursor-pointer"
                              title="Delete"
                            >
                              <Iconify icon="lucide:trash-2" size={14} />
                            </button>
                          </div>
                        </Show>
                      </div>
                    </Show>
                    </Show>
                  </div>
                );
              }}
            </For>

            {/* Pending Tool Approval (Antigravity-style, human-readable) */}
            <Show when={pendingApproval()}>
              {(pa) => {
                const args = tryParseArgs(pa().args);
                const name = pa().tool || "tool";
                return (
                  <div class={`${convWidthClass()} mx-auto rounded-2xl border border-amber-500/40 bg-amber-500/[0.06] p-4 shadow-xl`}>
                    <div class="flex items-center gap-2 text-[13px]">
                      <Iconify icon="lucide:shield" size={15} class="text-amber-400 shrink-0" />
                      <span class="font-semibold text-ink-100">Review tool call</span>
                      <span class="text-[11px] text-ink-500">Safe mode — nothing ran yet</span>
                    </div>
                    {/* Human summary per tool (never raw JSON) */}
                    <div class="mt-2.5 rounded-xl border border-line/60 bg-ink-950/70 overflow-hidden">
                      <Show when={name === "bash"}>
                        <div class="px-3.5 py-2.5">
                          <div class="text-[11px] text-ink-500 mb-1">Run command</div>
                          <pre class="font-mono text-[13px] text-ink-100 whitespace-pre-wrap break-all">{String(args.command || "")}</pre>
                        </div>
                      </Show>
                      <Show when={name === "read"}>
                        <div class="px-3.5 py-2.5 flex items-center gap-2 text-[13px]">
                          <Iconify icon="lucide:file-text" size={14} class="text-ink-400 shrink-0" />
                          <span class="text-ink-500">Read</span>
                          <span class="font-mono text-ink-100 truncate">{String(args.path || "")}</span>
                          <Show when={args.limit || args.offset}>
                            <span class="font-mono text-[11px] text-ink-500 shrink-0">
                              L{Number(args.offset || 0) + 1}-{Number(args.offset || 0) + Number(args.limit || 0)}
                            </span>
                          </Show>
                        </div>
                      </Show>
                      <Show when={name === "write"}>
                        <div class="px-3.5 py-2.5 text-[13px]">
                          <div class="flex items-center gap-2">
                            <Iconify icon="lucide:file-text" size={14} class="text-ink-400 shrink-0" />
                            <span class="text-ink-500">Create</span>
                            <span class="font-mono text-ink-100 truncate">{String(args.path || "")}</span>
                          </div>
                          <Show when={args.content}>
                            <pre class="mt-2 font-mono text-[11px] text-ink-400 whitespace-pre-wrap max-h-32 overflow-y-auto border-t border-line/50 pt-2">
                              {String(args.content).split("\n").slice(0, 12).join("\n")}
                              {String(args.content).split("\n").length > 12 ? "\n…" : ""}
                            </pre>
                          </Show>
                        </div>
                      </Show>
                      <Show when={name === "edit"}>
                        <div class="px-3.5 py-2.5 text-[13px]">
                          <div class="flex items-center gap-2">
                            <Iconify icon="lucide:pencil" size={14} class="text-ink-400 shrink-0" />
                            <span class="text-ink-500">Edit</span>
                            <span class="font-mono text-ink-100 truncate">{String(args.path || "")}</span>
                            <Show when={Array.isArray(args.edits)}>
                              <span class="text-[11px] text-ink-500 shrink-0">
                                {args.edits.length} change{args.edits.length === 1 ? "" : "s"}
                              </span>
                            </Show>
                          </div>
                          <Show when={Array.isArray(args.edits) && args.edits.length > 0}>
                            <div class="mt-2 rounded-lg overflow-hidden border border-line/50 font-mono text-[11px]">
                              <For each={args.edits.slice(0, 2)}>
                                {(e: any) => (
                                  <>
                                    <div class="px-2.5 py-1 bg-rose-500/10 text-rose-300 whitespace-pre-wrap break-all max-h-20 overflow-y-auto">
                                      {(String(e.oldText || "").split("\n").slice(0, 6).join("\n"))}
                                    </div>
                                    <div class="px-2.5 py-1 bg-emerald-500/10 text-emerald-300 whitespace-pre-wrap break-all max-h-20 overflow-y-auto">
                                      {(String(e.newText || "").split("\n").slice(0, 6).join("\n"))}
                                    </div>
                                  </>
                                )}
                              </For>
                              <Show when={args.edits.length > 2}>
                                <div class="px-2.5 py-1 text-ink-600">+{args.edits.length - 2} more changes</div>
                              </Show>
                            </div>
                          </Show>
                        </div>
                      </Show>
                      <Show when={name === "glob"}>
                        <div class="px-3.5 py-2.5 flex items-center gap-2 text-[13px]">
                          <Iconify icon="lucide:search" size={14} class="text-ink-400 shrink-0" />
                          <span class="text-ink-500">Search files</span>
                          <span class="font-mono text-ink-100 truncate">{String(args.pattern || "")}</span>
                        </div>
                      </Show>
                      <Show when={!["bash", "read", "write", "edit", "glob"].includes(name)}>
                        <div class="px-3.5 py-2.5 flex items-center gap-2 text-[13px]">
                          <Iconify icon="lucide:wrench" size={14} class="text-ink-400 shrink-0" />
                          <span class="font-mono text-ink-100">{name}</span>
                        </div>
                      </Show>
                      <details>
                        <summary class="px-3.5 py-1.5 text-[11px] text-ink-600 hover:text-ink-300 cursor-pointer select-none border-t border-line/50">
                          Details
                        </summary>
                        <pre class="px-3.5 pb-3 font-mono text-[11px] text-ink-500 overflow-x-auto whitespace-pre-wrap max-h-40">
                          {pa().args}
                        </pre>
                      </details>
                    </div>
                    <div class="mt-3 flex items-center justify-end gap-2">
                      <button
                        onClick={() => respondApproval(false)}
                        class="px-3.5 py-1.5 rounded-xl text-xs font-medium text-ink-300 hover:text-ink-100 border border-line hover:bg-ink-800 transition-colors cursor-pointer"
                      >
                        Reject
                      </button>
                      <button
                        onClick={() => respondApproval(true)}
                        class="px-4 py-1.5 rounded-xl bg-ink-100 text-ink-950 hover:bg-white text-xs font-semibold transition-colors cursor-pointer"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => {
                          setYoloMode(true);
                          respondApproval(true);
                        }}
                        class="px-3.5 py-1.5 rounded-xl bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 border border-amber-500/30 text-xs font-semibold transition-colors cursor-pointer"
                        title="Approve and stop asking (YOLO)"
                      >
                        Always allow
                      </button>
                    </div>
                  </div>
                );
              }}
            </Show>
          </div>
          </Show>

          {/* Composer estilo Antigravity — hidden entirely until a project
              exists: without a project there is nothing to type into. */}
          <Show when={!historyView()}>
          <Show
            when={projects().length > 0}
            fallback={
              <div class="px-4 pb-4 pt-2 bg-ink-950 relative z-20">
                <div class="max-w-2xl mx-auto rounded-2xl border border-dashed border-line/70 bg-ink-900/50 px-4 py-3.5 flex flex-wrap items-center justify-between gap-3">
                  <p class="text-xs text-ink-400 leading-relaxed">
                    <span class="text-ink-200 font-medium">Create a project first.</span>{" "}
                    Conversations live inside a project folder on the host.
                  </p>
                  <div class="flex items-center gap-2">
                    <button
                      onClick={openNewProjectModal}
                      class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-ink-100 text-ink-950 text-xs font-semibold hover:bg-white cursor-pointer"
                    >
                      <Iconify icon="lucide:folder-plus" size={13} />
                      <span>Select folder</span>
                    </button>
                    <button
                      onClick={quickStartProject}
                      class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line text-xs text-ink-300 hover:text-ink-100 hover:bg-ink-900 cursor-pointer"
                      title="Use your home folder (~) as the project"
                    >
                      <Iconify icon="lucide:zap" size={13} />
                      <span>Quick start (~)</span>
                    </button>
                  </div>
                </div>
              </div>
            }
          >
          <div class="px-4 pb-4 pt-2 bg-ink-950 relative z-20">
            {/* Floating scroll-to-bottom (chatbot FEAT-06) */}
            <Show when={!isAtBottom() && messages().length > 0}>
              <div class="flex justify-center pb-2">
                <button
                  onClick={() => {
                    setIsAtBottom(true);
                    scrollToBottom(true);
                  }}
                  class="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium bg-ink-900 border border-line/70 text-ink-300 shadow-lg hover:text-ink-100 cursor-pointer"
                >
                  <Iconify icon="lucide:arrow-down" size={13} />
                  <span>Scroll to bottom</span>
                </button>
              </div>
            </Show>
            {/* Slash Command Autocomplete Menu */}
            <Show when={slashMatches().length > 0}>
              <div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-full max-w-2xl rounded-xl border border-line bg-ink-900/95 shadow-2xl p-1.5 max-h-60 overflow-y-auto z-[60] backdrop-blur">
                <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-500 tracking-wider">
                  Slash Commands
                </div>
                <For each={slashMatches()}>
                  {(sc, idx) => (
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pickSlash(sc.cmd)}
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
              {/* z-index: composer sits above the chat (z-30); popovers z-[60]
                  escape via no overflow clipping on this box. */}
              <div class="rounded-2xl border border-line/70 bg-ink-900/80 shadow-xl focus-within:border-ink-500 transition-colors relative">
                {/* Attachment chips (chatbot-style) */}
                <Show when={pendingAttachments().length > 0}>
                  <div class="flex flex-wrap gap-1.5 px-3.5 pt-3">
                    <For each={pendingAttachments()}>
                      {(att) => (
                        <div
                          onClick={() => previewPending(att)}
                          class="relative group flex items-center gap-1.5 bg-ink-950 rounded-lg border border-line/70 pl-1.5 pr-2 py-1 text-xs max-w-[180px] cursor-pointer hover:border-ink-500 transition-colors"
                          title={`${att.name} (${Math.round(att.size / 1024)}KB) — click to preview`}
                        >
                          <Show
                            when={att.loading}
                            fallback={
                              <Show
                                when={att.objectUrl}
                                fallback={<Iconify icon="lucide:file-text" size={20} class="text-ink-500 shrink-0" />}
                              >
                                <img src={att.objectUrl} class="w-7 h-7 object-cover rounded shrink-0 border border-line/60" />
                              </Show>
                            }
                          >
                            <span class="w-5 h-5 border-2 border-ink-500 border-t-transparent rounded-full animate-spin shrink-0" />
                          </Show>
                          <span class="truncate text-ink-300">{att.name}</span>
                          <Show when={att.uploading}>
                            <span class="w-3 h-3 border-2 border-ink-500 border-t-transparent rounded-full animate-spin shrink-0" />
                          </Show>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              removePendingAttachment(att.key);
                            }}
                            class="absolute -top-1.5 -right-1.5 bg-ink-700 hover:bg-rose-500 rounded-full p-0.5 transition-colors shadow cursor-pointer"
                            title="Remove"
                          >
                            <Iconify icon="lucide:x" size={10} />
                          </button>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
                <textarea
                  id="rc-composer"
                  rows={1}
                  class="w-full bg-transparent text-base sm:text-[13px] text-ink-100 placeholder:text-ink-500 focus:outline-none resize-none px-4 pt-3 pb-1 max-h-[160px] min-h-[48px] overflow-y-auto"
                  placeholder={
                    activeSession()
                      ? `Ask anything, @ to mention, / for actions`
                      : `Start a conversation in ${activeProject()?.name || "project"}...`
                  }
                  value={inputPrompt()}
                  onInput={(e) => {
                    setInputPrompt(e.currentTarget.value);
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = Math.min(el.scrollHeight, 160) + "px";
                  }}
                  onPaste={(e) => {
                    const files: File[] = [];
                    try {
                      const items = e.clipboardData?.items;
                      if (items) {
                        for (const it of items) {
                          if (it.kind === "file") {
                            const f = it.getAsFile();
                            if (f) files.push(f);
                          }
                        }
                      }
                    } catch {}
                    if (files.length > 0) {
                      e.preventDefault();
                      handleFiles(files);
                    }
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    try {
                      const files = Array.from(e.dataTransfer?.files || []);
                      if (files.length > 0) handleFiles(files);
                    } catch {}
                  }}
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
                      if (pick) pickSlash(pick.cmd);
                      return;
                    }
                  }

                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendPrompt();
                  }
                }}
              />
              <Show when={inputPrompt().length > 0}>
                <button
                  onClick={() => setInputPrompt("")}
                  class="absolute top-2.5 right-2.5 p-1 rounded-md text-ink-600 hover:text-ink-300 hover:bg-ink-800 transition-colors cursor-pointer"
                  title="Clear input"
                >
                  <Iconify icon="lucide:x" size={13} />
                </button>
              </Show>

              <div class="flex items-center justify-between px-3 pb-2.5 pt-1">
                <div class="flex items-center gap-0.5 text-xs text-ink-400">
                  {/* Session files (stored on the daemon) */}
                  <Show when={(sessionFiles()[activeSessionId()] || []).length > 0}>
                    <div>
                      <button
                        ref={filesBtn}
                        data-menubtn
                        onClick={(e) => {
                          e.stopPropagation();
                          setFilesMenuOpen(!filesMenuOpen());
                          setAddContextOpen(false);
                          setModelMenuOpen(false);
                        }}
                        class="flex items-center gap-1 px-1.5 py-1 rounded-md hover:bg-ink-800 cursor-pointer"
                        title="Session files"
                      >
                        <Iconify icon="lucide:paperclip" size={13} />
                        <span>{(sessionFiles()[activeSessionId()] || []).length}</span>
                      </button>
                      <FloatMenu anchor={() => filesBtn} open={filesMenuOpen()} placement="top-start" width="15rem">
                          <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
                            Session files
                          </div>
                          <div class="max-h-48 overflow-y-auto">
                            <For each={sessionFiles()[activeSessionId()] || []}>
                              {(f) => (
                                <button
                                  onClick={() => {
                                    setFilesMenuOpen(false);
                                    openStoredPreview(activeSessionId(), f.id);
                                  }}
                                  class="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-ink-300 hover:bg-ink-800/60 flex items-center gap-2 cursor-pointer"
                                  title={`${f.name} (${Math.round(f.size / 1024)}KB)`}
                                >
                                  <Iconify icon="lucide:file-text" size={13} class="shrink-0 text-ink-500" />
                                  <span class="truncate flex-1">{f.name}</span>
                                  <span class="text-[10px] text-ink-600 shrink-0">{Math.round(f.size / 1024)}K</span>
                                </button>
                              )}
                            </For>
                          </div>
                      </FloatMenu>
                    </div>
                  </Show>
                  {/* Add Context (+) — Antigravity-style */}
                  <div>
                    <button
                      ref={addBtn}
                      data-menubtn
                      onClick={(e) => {
                        e.stopPropagation();
                        setAddContextOpen(!addContextOpen());
                        setModelMenuOpen(false);
                      }}
                      class="w-6 h-6 rounded-full hover:bg-ink-800 flex items-center justify-center cursor-pointer"
                      title="Add context"
                    >
                      <Iconify icon="lucide:plus" size={14} />
                    </button>
                    <FloatMenu anchor={() => addBtn} open={addContextOpen()} placement="top-start" width="12rem">
                        <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
                          Add context
                        </div>
                        <button
                          onClick={() => {
                            setAddContextOpen(false);
                            document.querySelector<HTMLInputElement>("#rc-file-input")?.click();
                          }}
                          class="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-ink-300 hover:bg-ink-800/60 flex items-center gap-2 cursor-pointer"
                        >
                          <Iconify icon="lucide:paperclip" size={13} />
                          <span>Attach files</span>
                        </button>
                        <button
                          onClick={() => {
                            setAddContextOpen(false);
                            setInputPrompt((p) => p + "@");
                            try {
                              document.querySelector<HTMLTextAreaElement>("#rc-composer")?.focus();
                            } catch {}
                          }}
                          class="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-ink-300 hover:bg-ink-800/60 flex items-center gap-2 cursor-pointer"
                        >
                          <Iconify icon="lucide:at-sign" size={13} />
                          <span>Mentions</span>
                        </button>
                        <button
                          onClick={() => {
                            setAddContextOpen(false);
                            setInputPrompt("/");
                            try {
                              document.querySelector<HTMLTextAreaElement>("#rc-composer")?.focus();
                            } catch {}
                          }}
                          class="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-ink-300 hover:bg-ink-800/60 flex items-center gap-2 cursor-pointer"
                        >
                          <Iconify icon="lucide:slash" size={13} />
                          <span>Actions</span>
                        </button>
                      </FloatMenu>
                  </div>
                  {/* Expand to fullscreen editor (chatbot LargeEditor) */}
                  <button
                    onClick={() => {
                      setLargeEditorText(inputPrompt());
                      setLargeEditorSend(false);
                      setLargeEditorOpen(true);
                    }}
                    class="w-6 h-6 rounded-full hover:bg-ink-800 hidden sm:flex items-center justify-center cursor-pointer"
                    title="Expand editor"
                  >
                    <Iconify icon="lucide:expand" size={13} />
                  </button>
                  {/* Project picker — where the next conversation starts.
                      Default: project of the newest conversation (daemon). */}
                  <div>
                    <button
                      ref={projBtn}
                      data-menubtn
                      onClick={(e) => {
                        e.stopPropagation();
                        setProjectMenuOpen(!projectMenuOpen());
                        setModelMenuOpen(false);
                        setAddContextOpen(false);
                        setUsageOpen(false);
                      }}
                      class="flex items-center gap-1 px-1.5 py-1 rounded-md hover:bg-ink-800 font-medium cursor-pointer"
                      title="Project (where new conversations start)"
                    >
                      <Iconify icon="lucide:folder" size={13} />
                      <span class="max-w-[110px] truncate">
                        {activeProject()?.name || "Select project"}
                      </span>
                      <Iconify icon="lucide:chevron-down" size={11} />
                    </button>
                    <FloatMenu anchor={() => projBtn} open={projectMenuOpen()} placement="top-start" width="15rem">
                        <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
                          Project
                        </div>
                        <div class="max-h-56 overflow-y-auto">
                          <For
                            each={projects()}
                            fallback={
                              <div class="px-2.5 py-2 text-[11px] text-ink-600">
                                No projects yet.
                              </div>
                            }
                          >
                            {(p) => (
                              <button
                                onClick={() => {
                                  pickProject(p.id);
                                  setProjectMenuOpen(false);
                                }}
                                class={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between gap-2 cursor-pointer ${
                                  p.id === activeProject()?.id
                                    ? "bg-ink-800 text-ink-100"
                                    : "text-ink-300 hover:bg-ink-800/60"
                                }`}
                                title={p.path}
                              >
                                <span class="flex items-center gap-1.5 min-w-0">
                                  <Iconify icon="lucide:folder" size={13} class="shrink-0 text-ink-500" />
                                  <span class="truncate">{p.name}</span>
                                </span>
                                <Show when={p.id === activeProject()?.id}>
                                  <Iconify icon="lucide:check" size={13} />
                                </Show>
                              </button>
                            )}
                          </For>
                        </div>
                        <button
                          onClick={() => {
                            setProjectMenuOpen(false);
                            openNewProjectModal();
                          }}
                          class="mt-1 w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-ink-400 hover:bg-ink-800/60 hover:text-ink-200 flex items-center gap-2 cursor-pointer border-t border-line/60"
                        >
                          <Iconify icon="lucide:folder-plus" size={13} />
                          <span>New project…</span>
                        </button>
                    </FloatMenu>
                  </div>
                  {/* Model picker (moved from the removed topbar) */}
                  <div>
                    <button
                      ref={modelBtn}
                      data-menubtn
                      onClick={(e) => {
                        e.stopPropagation();
                        setModelMenuOpen(!modelMenuOpen());
                        setProjectMenuOpen(false);
                        setAddContextOpen(false);
                        setUsageOpen(false);
                      }}
                      class="flex items-center gap-1 px-1.5 py-1 rounded-md hover:bg-ink-800 font-medium cursor-pointer"
                      title="Switch model"
                    >
                      <span class="max-w-[130px] truncate">{activeModel().split("/").pop()}</span>
                      <Iconify icon="lucide:chevron-down" size={11} />
                    </button>
                    <FloatMenu anchor={() => modelBtn} open={modelMenuOpen()} placement="top-start" width="16rem">
                        <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider flex items-center justify-between">
                          <span>Model</span>
                          <button
                            onClick={async () => {
                              await loadGatewayModels();
                              toast("Models refreshed", "ok");
                            }}
                            class="p-0.5 text-ink-600 hover:text-ink-200 cursor-pointer"
                            title="Refresh models"
                          >
                            <Iconify icon="lucide:refresh-cw" size={11} />
                          </button>
                        </div>
                        <div class="max-h-56 overflow-y-auto">
                          <For each={gatewayModels()}>
                            {(m) => (
                              <button
                                onClick={() => {
                                  const id = m.id;
                                  setActiveModel(id);
                                  setModelMenuOpen(false);
                                  if (activeSessionId() && wsOpen()) {
                                    sendWS({ type: "set_model", sessionId: activeSessionId(), model: id });
                                  }
                                }}
                                class={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between gap-2 cursor-pointer ${
                                  m.id === activeModel()
                                    ? "bg-ink-800 text-ink-100"
                                    : "text-ink-300 hover:bg-ink-800/60"
                                }`}
                              >
                                <span class="truncate">{m.name || m.id}</span>
                                <Show when={m.id === activeModel()}>
                                  <Iconify icon="lucide:check" size={13} />
                                </Show>
                              </button>
                            )}
                          </For>
                        </div>
                        <div class="mt-1.5 pt-1.5 border-t border-line/60">
                          <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
                            Reasoning effort
                          </div>
                          <div class="grid grid-cols-4 gap-1 p-1 rounded-lg bg-ink-950 border border-line/50">
                            <For each={["off", "low", "medium", "high"]}>
                              {(lvl) => (
                                <button
                                  onClick={() => {
                                    setDaemonSettings({ ...daemonSettings(), reasoning: lvl });
                                    setModelMenuOpen(false);
                                    if (wsOpen()) sendWS({ type: "set_reasoning", effort: lvl });
                                  }}
                                  class={`py-1 rounded-md text-center text-[11px] font-medium capitalize cursor-pointer ${
                                    (daemonSettings().reasoning || "medium") === lvl
                                      ? "bg-ink-100 text-ink-950"
                                      : "text-ink-400 hover:text-ink-200"
                                  }`}
                                >
                                  {lvl}
                                </button>
                              )}
                            </For>
                          </div>
                        </div>
                        <button
                          onClick={() => {
                            setModelMenuOpen(false);
                            setUsageOpen(true);
                          }}
                          class="mt-1 w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-ink-400 hover:bg-ink-800/60 hover:text-ink-200 flex items-center gap-2 cursor-pointer"
                        >
                          <Iconify icon="lucide:chart-column" size={13} />
                          <span>View Usage</span>
                        </button>
                    </FloatMenu>
                    <FloatMenu anchor={() => modelBtn} open={usageOpen()} placement="top-start" width="16rem">
                      <div class="p-1.5 text-xs">
                        <div class="font-semibold text-ink-200 mb-2">Session usage</div>
                        <Show
                          when={activeUsage()}
                          fallback={
                            <p class="text-ink-500 text-[11px]">
                              No usage reported yet. Run the agent to see input / cache / output tokens here.
                            </p>
                          }
                        >
                          {(u) => (
                            <div class="space-y-1.5 font-mono text-[11px]">
                              <div class="flex justify-between"><span class="text-ink-500">Input</span><span class="text-ink-200">{u().inTok.toLocaleString()}</span></div>
                              <div class="flex justify-between"><span class="text-ink-500">Cache</span><span class="text-ink-200">{u().cacheTok.toLocaleString()}</span></div>
                              <div class="flex justify-between"><span class="text-ink-500">Output</span><span class="text-ink-200">{u().outTok.toLocaleString()}</span></div>
                              <div class="flex justify-between"><span class="text-ink-500">Reasoning</span><span class="text-ink-200">{u().reasoningTok.toLocaleString()}</span></div>
                              <Show when={u().costUsd > 0}>
                                <div class="flex justify-between pt-1 border-t border-line/60"><span class="text-ink-500">Cost</span><span class="text-ink-200">${u().costUsd.toFixed(4)}</span></div>
                              </Show>
                            </div>
                          )}
                        </Show>
                      </div>
                    </FloatMenu>
                  </div>
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
                    onClick={sendPrompt}
                    disabled={
                      sessionStatus() === "running" ||
                      (activeSessionId()
                        ? !inputPrompt().trim() && pendingAttachments().length === 0
                        : !inputPrompt().trim() || !activeProject())
                    }
                    class="w-7 h-7 rounded-full bg-ink-100 text-ink-950 hover:bg-white disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition-all cursor-pointer"
                    title={!activeSessionId() ? "Start conversation" : "Send"}
                  >
                    <Iconify icon="lucide:arrow-right" size={14} />
                  </button>
                </div>
              </div>
              <input
                id="rc-file-input"
                type="file"
                class="hidden"
                multiple
                onChange={(e) => {
                  handleFiles(e.currentTarget.files ?? []);
                  e.currentTarget.value = "";
                }}
               />
            </div>
            </div>
          </div>
          </Show>
          </Show>
        </main>
      </div>
      </Show>

      {/* Modal: New Project (pasta no host) */}
      <Modal
        open={showNewProjectModal()}
        onClose={() => setShowNewProjectModal(false)}
        title="Select project folder"
        fullOnMobile
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

      {/* Modal: Large editor (chatbot FullscreenEditor) */}
      <Modal
        open={largeEditorOpen()}
        onClose={() => setLargeEditorOpen(false)}
        title="Edit message"
        width="max-w-2xl"
        fullOnMobile
      >
        <div class="space-y-3">
          <textarea
            class="w-full h-64 bg-ink-950 border border-line rounded-xl px-3.5 py-3 text-sm text-ink-100 placeholder:text-ink-600 focus:outline-none focus:border-ink-500 resize-y font-mono leading-relaxed"
            placeholder="Type your message..."
            value={largeEditorText()}
            onInput={(e) => setLargeEditorText(e.currentTarget.value)}
            ref={(el) => setTimeout(() => el?.focus(), 60)}
          />
          <div class="flex items-center justify-between">
            <span class="text-[11px] text-ink-600 font-mono">
              {largeEditorText().length} chars
            </span>
            <div class="flex items-center gap-2">
              <button
                onClick={() => setLargeEditorOpen(false)}
                class="px-4 py-2 rounded-xl text-xs text-ink-400 hover:text-ink-100 hover:bg-ink-800 cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setInputPrompt(largeEditorText());
                  setLargeEditorOpen(false);
                }}
                class="px-4 py-2 rounded-xl border border-line text-xs font-medium text-ink-200 hover:bg-ink-800 cursor-pointer"
              >
                Apply
              </button>
              <button
                onClick={() => {
                  const t = largeEditorText();
                  setLargeEditorOpen(false);
                  if (!t.trim()) return;
                  setInputPrompt(t);
                  setTimeout(() => sendPrompt(), 30);
                }}
                class="px-5 py-2 rounded-xl bg-ink-100 text-ink-950 text-xs font-semibold hover:bg-white cursor-pointer"
              >
                Apply & Send
              </button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Modal: File Preview (chatbot FilePreviewModal) */}
      <Modal
        open={!!previewFile()}
        onClose={() => setPreviewFile(null)}
        title={previewFile()?.name || "File Preview"}
        width="max-w-3xl"
        fullOnMobile
      >
        <Show when={previewFile()}>
          {(f) => (
            <div class="space-y-3">
              <Show when={f().truncated}>
                <span class="inline-flex text-[10px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/30 px-1.5 py-0.5 rounded-full">
                  truncated
                </span>
              </Show>
              {/* Toolbar */}
              <div class="flex items-center gap-1.5 flex-wrap">
                <Show when={f().truncated && f().fullText}>
                  <button
                    onClick={restorePreviewFile}
                    class="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20 cursor-pointer"
                  >
                    <Iconify icon="lucide:rotate-ccw" size={13} />
                    <span>Restore</span>
                  </button>
                </Show>
                <Show when={!f().dataUrl}>
                  <button
                    onClick={() => setShowTruncateInput(!showTruncateInput())}
                    class="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border bg-ink-900 border-line text-ink-400 hover:text-ink-200 cursor-pointer"
                    title="Truncate to reduce tokens"
                  >
                    <Iconify icon="lucide:scissors" size={13} />
                    <span>Truncate</span>
                  </button>
                </Show>
                <Show when={f().text}>
                  <button
                    onClick={() => {
                      copyWithToast(f().text || "");
                      setPreviewCopied(true);
                      setTimeout(() => setPreviewCopied(false), 1500);
                    }}
                    class="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border bg-ink-900 border-line text-ink-400 hover:text-ink-200 cursor-pointer"
                  >
                    <Iconify icon={previewCopied() ? "lucide:check" : "lucide:copy"} size={13} />
                    <span>{previewCopied() ? "Copied!" : "Copy all"}</span>
                  </button>
                </Show>
                <Show when={f().dataB64}>
                  <button
                    onClick={downloadPreviewFile}
                    class="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border bg-ink-900 border-line text-ink-400 hover:text-ink-200 cursor-pointer"
                  >
                    <Iconify icon="lucide:download" size={13} />
                    <span>Download</span>
                  </button>
                </Show>
              </div>
              {/* Truncate input */}
              <Show when={showTruncateInput() && !f().dataUrl}>
                <div class="flex flex-wrap items-center gap-2 p-2.5 rounded-xl bg-ink-900/60 border border-line/60">
                  <Iconify icon="lucide:scissors" size={14} class="text-ink-500" />
                  <span class="text-xs text-ink-400">Truncate to</span>
                  <input
                    type="number"
                    min={100}
                    max={200000}
                    step={1000}
                    class="w-24 bg-ink-950 border border-line rounded-lg px-2 py-1 text-ink-100 text-xs focus:outline-none"
                    value={truncateTokens() || 16000}
                    onInput={(e) => setTruncateTokens(parseInt(e.currentTarget.value) || 16000)}
                  />
                  <span class="text-xs text-ink-500">tokens (~{(((truncateTokens() || 16000) * 4)).toLocaleString()} chars)</span>
                  <div class="flex items-center gap-2 ml-auto">
                    <button
                      onClick={() => setShowTruncateInput(false)}
                      class="text-xs text-ink-400 hover:text-ink-100 px-2 py-1 cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => {
                        truncatePreviewFile();
                        setShowTruncateInput(false);
                      }}
                      class="px-3 py-1.5 text-xs font-medium bg-ink-100 text-ink-950 rounded-lg hover:bg-white cursor-pointer"
                    >
                      Apply
                    </button>
                  </div>
                </div>
              </Show>
              {/* Content */}
              <div class="max-h-[50vh] overflow-auto rounded-xl border border-line/60 bg-ink-950 p-3">
                <Show
                  when={f().dataUrl}
                  fallback={
                    <pre class="text-xs text-ink-200 font-mono whitespace-pre-wrap break-words leading-relaxed">{f().text || "(empty)"}</pre>
                  }
                >
                  <div class="flex items-center justify-center">
                    <img src={f().dataUrl} class="max-w-full rounded-lg object-contain" />
                  </div>
                </Show>
              </div>
              {/* Footer stats */}
              <Show when={f().text}>
                <div class="flex items-center justify-between text-[11px] text-ink-500">
                  <span>
                    {(f().text || "").length.toLocaleString()} chars ·{" "}
                    {(f().text || "").split("\n").length.toLocaleString()} lines
                    <Show when={f().truncated && f().fullText}>
                      <span class="text-amber-400"> (original: {(f().fullText || "").length.toLocaleString()} chars)</span>
                    </Show>
                  </span>
                  <span class="flex items-center gap-1 font-mono">
                    <Iconify icon="lucide:hash" size={11} />
                    {Math.round((f().text || "").length / 4).toLocaleString()} tokens
                  </span>
                </div>
              </Show>
            </div>
          )}
        </Show>
      </Modal>

      {/* Confirm dialog (chatbot showConfirm, promise-based) */}
      <Show when={confirmState()}>
        {(c) => (
          <div class="fixed inset-0 z-[70] overflow-y-auto bg-black/55 backdrop-blur-sm">
            <div class="min-h-full flex items-center justify-center p-4">
              <div class="anim-pop-in w-full max-w-sm rounded-2xl border border-line bg-ink-900 shadow-2xl">
                <div class="px-5 pt-5 pb-3">
                  <h3 class="text-sm font-semibold text-ink-100">{c().title}</h3>
                  <p class="text-xs text-ink-400 mt-1.5 whitespace-pre-line leading-relaxed">
                    {c().message}
                  </p>
                </div>
                <div class="flex justify-end gap-2 px-5 pb-5">
                  <button
                    onClick={() => {
                      c().resolve(false);
                      setConfirmState(null);
                    }}
                    class="px-4 py-2 rounded-xl text-xs font-medium text-ink-300 hover:text-ink-100 border border-line hover:bg-ink-800 transition-colors cursor-pointer"
                  >
                    {c().cancelText}
                  </button>
                  <button
                    onClick={() => {
                      c().resolve(true);
                      setConfirmState(null);
                    }}
                    class={`px-4 py-2 rounded-xl text-xs font-semibold transition-colors cursor-pointer ${
                      c().danger
                        ? "bg-rose-500/90 text-white hover:bg-rose-500"
                        : "bg-ink-100 text-ink-950 hover:bg-white"
                    }`}
                  >
                    {c().confirmText}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </Show>

      {/* Modal: Slash command reference */}
      <Modal
        open={helpOpen()}
        onClose={() => setHelpOpen(false)}
        title="Slash Commands"
        width="max-w-lg"
        fullOnMobile
      >
        <div class="space-y-1.5 max-h-[60vh] overflow-y-auto pr-0.5">
          <For each={SLASH_COMMANDS}>
            {(sc) => (
              <div class="p-3 rounded-xl border border-line/70 bg-ink-900/50 flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <div class="font-mono font-bold text-[13px] text-ink-100 flex items-center gap-2">
                    <span>{sc.cmd}</span>
                    <Show when={sc.args}>
                      <span class="text-ink-500 font-normal text-[11px]">{sc.args}</span>
                    </Show>
                  </div>
                  <div class="text-[11px] text-ink-500 mt-0.5">{sc.desc}</div>
                </div>
                <button
                  onClick={() => {
                    setHelpOpen(false);
                    executeSlashCommand(sc.cmd + (sc.args ? " " : ""));
                  }}
                  class="px-3 py-1.5 rounded-lg bg-ink-800 hover:bg-ink-100 hover:text-ink-950 text-ink-300 text-xs font-medium transition-colors shrink-0 cursor-pointer"
                >
                  Run
                </button>
              </div>
            )}
          </For>
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

      {/* Modal: Settings (chatbot-style sections) */}
      <Modal
        open={showConfigModal()}
        title="Settings"
        width="max-w-2xl"
        fullOnMobile
        onClose={cancelSettings}
      >
          <div class="w-full space-y-4 max-h-[70vh] overflow-y-auto pr-0.5">
            <div class="rounded-2xl border border-line/70 bg-ink-900/40 p-4 space-y-3">
              <h3 class="text-sm font-semibold text-ink-100 flex items-center gap-2">
                <Iconify icon="lucide:palette" size={15} class="text-ink-500" />
                <span>Appearance</span>

              </h3>
              <div class="space-y-3 text-xs">
                <div class="p-3.5 rounded-xl border border-line bg-ink-900/60 flex items-center justify-between gap-3">
                  <div>
                    <div class="font-semibold text-ink-200">Theme</div>
                    <div class="text-[11px] text-ink-500 mt-0.5">
                      White or dark interface.
                    </div>
                  </div>
                  <ThemeToggle />
                </div>
                <div class="p-3.5 rounded-xl border border-line bg-ink-900/60 flex items-center justify-between gap-3">
                  <div>
                    <div class="font-semibold text-ink-200">Verbose Agent Chat</div>
                    <div class="text-[11px] text-ink-500 mt-0.5">
                      Display intermediate thinking steps and tool calls.
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      const v = !verboseChat();
                      setVerboseChat(v);
                      try { localStorage.setItem("llmgw-rc-verbose", v ? "1" : "0"); } catch {}
                    }}
                    class={`w-10 h-5.5 rounded-full p-0.5 transition-colors shrink-0 cursor-pointer ${verboseChat() ? "bg-sky-500" : "bg-ink-700"}`}
                    style={{ height: "22px" }}
                    title="Toggle verbose agent chat"
                  >
                    <span
                      class={`block w-4 h-4 rounded-full bg-white transition-transform ${verboseChat() ? "translate-x-[18px]" : "translate-x-0"}`}
                      style={{ height: "16px", width: "16px" }}
                    />
                  </button>
                </div>
                <div class="p-3.5 rounded-xl border border-line bg-ink-900/60">
                  <div class="font-semibold text-ink-200">Conversation Width</div>
                  <div class="text-[11px] text-ink-500 mt-0.5 mb-2">
                    Maximum width of the conversation panel.
                  </div>
                  <div class="grid grid-cols-3 gap-1 bg-ink-950 p-1 rounded-xl border border-line/60">
                    <For each={[["narrow", "Narrow"], ["default", "Default"], ["wide", "Wide"]] as const}>
                      {([v, label]) => (
                        <button
                          onClick={() => {
                            setConvWidth(v);
                            try { localStorage.setItem("llmgw-rc-width", v); } catch {}
                          }}
                          class={`py-1.5 rounded-lg text-center font-medium transition-colors cursor-pointer ${
                            convWidth() === v
                              ? "bg-ink-800 text-ink-100"
                              : "text-ink-500 hover:text-ink-300"
                          }`}
                        >
                          {label}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </div>
            </div>

            <div class="rounded-2xl border border-line/70 bg-ink-900/40 p-4 space-y-3">
              <h3 class="text-sm font-semibold text-ink-100 flex items-center gap-2">
                <Iconify icon="lucide:bot" size={15} class="text-ink-500" />
                <span>Agent</span>

              </h3>
              <div class="space-y-4 text-xs">
                <div>
                  <Select
                    label="Default Model"
                    value={daemonSettings().model}
                    onChange={(v) => {
                      setDaemonSettings({ ...daemonSettings(), model: v });
                      setActiveModel(v);
                    }}
                    options={gatewayModels().map((m) => ({ value: m.id, label: m.name || m.id }))}
                  />
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


                </div>

                <div class="space-y-2 pt-2 border-t border-line/60">
                  <label class="flex items-start gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={yoloMode()}
                      onChange={(e) => {
                        const next = e.currentTarget.checked;
                        setYoloMode(next);
                        toast(
                          next
                            ? "YOLO Mode: tools run without asking"
                            : "Safe Mode: each tool asks for approval",
                          next ? "err" : "ok",
                        );
                      }}
                      class="rounded accent-amber-500 mt-0.5"
                    />
                    <span>
                      <span class="text-ink-200 font-medium">
                        Autonomous execution (YOLO)
                      </span>
                      <span class="block text-[11px] text-ink-500 font-normal">
                        On by default. When off, every file write and shell command asks for approval first.
                      </span>
                    </span>
                  </label>



                  <label class="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={daemonSettings().autoSwarmEnabled ?? false}
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
              </div>
            </div>

            <div class="rounded-2xl border border-line/70 bg-ink-900/40 p-4 space-y-3">
              <h3 class="text-sm font-semibold text-ink-100 flex items-center gap-2">
                <Iconify icon="lucide:sliders-horizontal" size={15} class="text-ink-500" />
                <span>Advanced</span>
              </h3>
              <div class="space-y-4 text-xs">
                <div>
                  <label class="block font-semibold text-ink-200 mb-1">
                    Auto-compact threshold
                  </label>
                  <div class="grid grid-cols-6 gap-1 bg-ink-900 p-1 rounded-xl border border-line">
                    <For each={[0, 70, 80, 85, 90, 95]}>
                      {(v) => (
                        <button
                          onClick={() =>
                            setDaemonSettings({ ...daemonSettings(), autoCompactPercent: v })
                          }
                          class={`py-1 rounded-lg text-center font-medium transition-colors cursor-pointer ${
                            (daemonSettings().autoCompactPercent ?? 95) === v
                              ? "bg-ink-100 text-ink-950"
                              : "text-ink-400 hover:text-ink-200"
                          }`}
                        >
                          {v === 0 ? "Off" : `${v}%`}
                        </button>
                      )}
                    </For>
                  </div>
                  <p class="text-[11px] text-ink-500 mt-1">
                    Compact the transcript automatically past this context usage.
                  </p>
                </div>
              </div>
            </div>

            <div class="rounded-2xl border border-line/70 bg-ink-900/40 p-4 space-y-3">
              <h3 class="text-sm font-semibold text-ink-100 flex items-center gap-2">
                <Iconify icon="lucide:type" size={15} class="text-ink-500" />
                <span>Title Generator</span>
              </h3>
              <label class="flex items-start gap-2 cursor-pointer select-none text-xs">
                <input
                  type="checkbox"
                  checked={!(daemonSettings().noAutoTitle ?? false)}
                  onChange={(e) =>
                    setDaemonSettings({ ...daemonSettings(), noAutoTitle: !e.currentTarget.checked })
                  }
                  class="rounded accent-brand-500 mt-0.5"
                />
                <span>
                  <span class="text-ink-200 font-medium">Auto-generate conversation titles</span>
                  <span class="block text-[11px] text-ink-500 font-normal mt-0.5">
                    The host asks the model for a short title after the first exchange. Off leaves "New conversation".
                  </span>
                </span>
              </label>
            </div>

            <div class="rounded-2xl border border-line/70 bg-ink-900/40 p-4 space-y-3">
              <h3 id="sec-mcp" class="text-sm font-semibold text-ink-100 flex items-center gap-2 scroll-mt-2">
                <Iconify icon="lucide:cpu" size={15} class="text-ink-500" />
                <span>MCP Servers</span>
                <span class="px-1.5 py-0.2 rounded-full bg-ink-800 text-[10px] text-ink-400">{Object.keys(mcpServers()).length}</span>
              </h3>
              <div class="space-y-4 text-xs">
                <div class="border border-line rounded-xl p-3 bg-ink-900/50 space-y-2">
                  <div class="font-semibold text-ink-200 text-xs">
                    Add Model Context Protocol (MCP) Server
                  </div>
                  <div class="grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      placeholder="Server name (e.g. github)"
                      class="bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100"
                      value={newMcpName()}
                      onInput={(e) => setNewMcpName(e.currentTarget.value)}
                    />
                    <input
                      type="text"
                      placeholder="Command (e.g. npx, uvx)"
                      class="bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100"
                      value={newMcpCmd()}
                      onInput={(e) => setNewMcpCmd(e.currentTarget.value)}
                    />
                  </div>
                  <div class="grid grid-cols-3 gap-1 bg-ink-950 p-1 rounded-lg border border-line/60">
                    <For each={[["stdio", "stdio"], ["sse", "SSE"], ["http", "HTTP"]] as const}>
                      {([v, label]) => (
                        <button
                          onClick={() => setNewMcpTransport(v)}
                          class={`py-1 rounded-md text-center font-medium cursor-pointer ${
                            newMcpTransport() === v
                              ? "bg-ink-100 text-ink-950"
                              : "text-ink-400 hover:text-ink-200"
                          }`}
                        >
                          {label}
                        </button>
                      )}
                    </For>
                  </div>
                  <Show when={newMcpTransport() !== "stdio"}>
                    <input
                      type="text"
                      placeholder="Server URL"
                      class="w-full bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100"
                      value={newMcpUrl()}
                      onInput={(e) => setNewMcpUrl(e.currentTarget.value)}
                    />
                  </Show>
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
            </div>

            <div class="rounded-2xl border border-line/70 bg-ink-900/40 p-4 space-y-3">
              <h3 id="sec-skills" class="text-sm font-semibold text-ink-100 flex items-center gap-2 scroll-mt-2">
                <Iconify icon="lucide:puzzle" size={15} class="text-ink-500" />
                <span>Skills</span>
                <span class="px-1.5 py-0.2 rounded-full bg-ink-800 text-[10px] text-ink-400">{Object.keys(skills()).length}</span>
              </h3>
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
            </div>

            <div class="rounded-2xl border border-line/70 bg-ink-900/40 p-4 space-y-3">
              <h3 class="text-sm font-semibold text-ink-100 flex items-center gap-2">
                <Iconify icon="lucide:slash" size={15} class="text-ink-500" />
                <span>Slash Commands</span>

              </h3>
              <div class="space-y-2 text-xs">
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
            </div>

            {/* Footer: Save / Cancel (chatbot) */}
            <div class="flex justify-end items-center gap-2 pt-1 sticky bottom-0 bg-ink-950/95 backdrop-blur py-2">
              <button
                onClick={cancelSettings}
                class="px-4 py-2 rounded-xl text-xs font-medium text-ink-400 hover:text-ink-100 border border-line hover:bg-ink-900 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  saveDaemonConfig();
                  setShowConfigModal(false);
                  toast("Settings saved", "ok");
                }}
                class="px-5 py-2 rounded-xl bg-ink-100 text-ink-950 text-xs font-semibold hover:bg-white cursor-pointer"
              >
                Save
              </button>
            </div>
          </div>
        </Modal>
    </div>
  );
}
