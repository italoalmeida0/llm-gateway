import {
  createSignal,
  createEffect,
  createMemo,
  batch,
  untrack,
  onMount,
  onCleanup,
  For,
  Show,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import { createStore, reconcile } from "solid-js/store";
import { FileIcon, RemoteHints } from "../rcPresentation";
import { createTranscriptScroll } from "../rcScroll";
import { compactTokens, contextDisplay, type GatewayModel, type SessionContext } from "../rcContext";
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
  Btn,
  Tooltip,
  ThemeToggle,
  copyWithToast,
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
            onCleanup(anchorFloat(a, el, { placement: props.placement ?? "bottom-start", maxHeight: 520 }));
          }}
          data-floatmenu
          class="anim-float-in max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-line bg-card shadow-xl p-1.5 text-xs"
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
 * Canonical reasoning effort levels offered by the UI. The daemon accepts
 * these (and more aliases); providers clamp them internally (see
 * remote-code-daemon/packages/provider/reasoning.go). "none" is an explicit
 * off — NormalizeReasoning maps it to the disabled state.
 */
const REASONING_LEVELS = ["none", "minimum", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Slash command definitions for autocomplete palette.
 * Only commands NOT already configurable somewhere in the UI are listed:
 * model + reasoning effort live in the composer picker,
 * and help + protocols (mcp/skills) live in Settings (sec-* sections).
 */
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
  | { kind: "tools"; units: ToolUnit[] }
  | { kind: "thinking"; blocks: ContentBlock[] };

/** A message with no visible content (loading dots only) never forms part of a series. */
export function msgIsEmpty(m: { blocks: ContentBlock[] }): boolean {
  return (m.blocks || []).every(
    (b) =>
      (b.type === "text" && !(b.text || "").trim()) ||
      (b.type === "reasoning" && !(b.reasoning || "").trim()) ||
      b.type === "image",
  );
}

/** A message carries tool activity when it has a call, a result, or (after
 * normalization) anything only a tool run leaves behind. Display helpers
 * treat image-only leftovers as tool residue, never as new thought. */
export function msgHasTools(m: { blocks: ContentBlock[] }): boolean {
  return (m.blocks || []).some((b) => b.type === "tool_call" || b.type === "tool_result");
}

/**
 * Pairs the tool units of one assistant message, then attaches any orphan
 * tool_result blocks found in the following user/tool envelopes to the SAME
 * series (the daemon persists results separately; rendering must not
 * pretend they belong to a later turn). `tail` is the slice of following
 * raw messages considered part of the still-open turn; indices of consumed
 * envelopes are reported so the renderer can skip them.
 */

/**
 * Splits a message into text runs, thinking runs and consecutive tool runs
 * (order kept). Thinking panels break a tool series on purpose: a thinking
 * block renders ABOVE its own group, never swallowed inside one, so every
 * reasoning stays visible even in a tool-heavy transcript.
 */
export function splitToolRuns(blocks: ContentBlock[]): MsgPart[] {
  const parts: MsgPart[] = [];
  let buf: ContentBlock[] = [];
  let think: ContentBlock[] = [];
  let run: ToolUnit[] = [];
  const byId = new Map<string, ToolUnit>();
  const flushBuf = () => {
    if (buf.length) {
      parts.push({ kind: "blocks", blocks: buf });
      buf = [];
    }
  };
  const flushThink = () => {
    if (think.length) {
      parts.push({ kind: "thinking", blocks: think });
      think = [];
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
      flushThink();
      const u: ToolUnit = { call: b };
      run.push(u);
      if (b.toolId) byId.set(b.toolId, u);
    } else if (b.type === "tool_result") {
      flushBuf();
      flushThink();
      const u = (b.toolId && byId.get(b.toolId)) || null;
      if (u && !u.result) u.result = b;
      else run.push({ result: b });
    } else if (b.type === "reasoning") {
      flushBuf();
      flushRun();
      think.push(b);
    } else {
      flushRun();
      flushThink();
      buf.push(b);
    }
  }
  flushRun();
  flushThink();
  flushBuf();
  return parts;
}

/**
 * Display-only cross-message series grouping. The renderer calls this with
 * the rendered message array; consecutive rendered assistant messages that
 * contain ONLY tool blocks (no visible text/thinking of their own) fuse
 * into one "series" block that renders as a single aggregate balloon —
 * whatever tools happened inside, in whatever invocation order, with no
 * distinction. A series ends at the first assistant message with its own
 * real text/thinking, at any user message, or at an empty (pending) one.
 *
 * Implementation detail: series fusing happens at RENDER time over
 * ChatMessage[] (not in applySessionContent) so the raw transcript array
 * — and therefore every srcIdx used by edit/delete/regenerate — stays
 * byte-identical to the daemon's wire order.
 */
export type RenderBlockKind = "single" | "series";

export interface RenderBlockBase {
  kind: RenderBlockKind;
}

export interface RenderBlockSingle extends RenderBlockBase {
  kind: "single";
  msg: ChatMessage;
}

export interface RenderBlockSeries extends RenderBlockBase {
  kind: "series";
  /** Lead message (carries the visible header chunk + thinking/text). */
  msg: ChatMessage;
  /** Fused-in following tool-only messages (rendered inside the card). */
  extras: ChatMessage[];
  /** Every ToolUnit of the whole series, in display order. */
  units: ToolUnit[];
}

export type RenderBlock = RenderBlockSingle | RenderBlockSeries;

/** A rendered assistant message is series-fusible when it shows tools and
 * nothing else of its own (empty loading shells never fuse). */
function fusableAssistant(m: ChatMessage): boolean {
  if (m.role === "user" || m.system || msgIsEmpty(m)) return false;
  if (!msgHasTools(m)) return false;
  return (m.blocks || []).every(
    (b) =>
      b.type === "tool_call" ||
      b.type === "tool_result" ||
      (b.type === "text" && !(b.text || "").trim()) ||
      (b.type === "reasoning" && !(b.reasoning || "").trim()) ||
      b.type === "image",
  );
}

export function collectSeriesUnits(
  head: ChatMessage,
  tail: ChatMessage[],
): { units: ToolUnit[]; consumed: number } {
  const units: ToolUnit[] = [];
  const byId = new Map<string, ToolUnit>();
  const absorb = (m: ChatMessage) => {
    for (const b of m.blocks || []) {
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
  };
  absorb(head);
  let consumed = 0;
  for (const m of tail) {
    if (!fusableAssistant(m)) break;
    absorb(m);
    consumed++;
  }
  return { units, consumed };
}

export function buildRenderBlocks(list: ChatMessage[]): RenderBlock[] {
  const out: RenderBlock[] = [];
  let i = 0;
  while (i < list.length) {
    const m = list[i];
    if (fusableAssistant(m)) {
      const tail = list.slice(i + 1);
      const { units, consumed } = collectSeriesUnits(m, tail);
      out.push({
        kind: "series",
        msg: m,
        extras: tail.slice(0, consumed),
        units,
      });
      i += 1 + consumed;
      continue;
    }
    out.push({ kind: "single", msg: m });
    i++;
  }
  return out;
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

/**
 * Lightweight token highlighter on top of highlight.js (already a runtime
 * dep — no new libs). `languageForPath` maps a file extension to an hljs
 * language id; `highlightCode` returns HTML for <CodeBlock> (auto-detect
 * for diffs and extension-less files). Theme-agnostic: keep classes
 * structural (`tok-…`) and map them to CSS vars in the stylesheet so
 * white/dark flip for free.
 */
export function languageForPath(name?: string): string | undefined {
  if (!name) return undefined;
  const base = String(name).replace(/\\/g, "/").split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
    case "jsonc":
      return "json";
    case "py":
    case "pyi":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "rb":
      return "ruby";
    case "java":
    case "kt":
    case "kts":
      return "java";
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "hpp":
    case "cxx":
      return "cpp";
    case "cs":
      return "csharp";
    case "php":
      return "php";
    case "swift":
      return "swift";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
    case "vue":
    case "svelte":
      return "xml";
    case "md":
    case "mdx":
    case "markdown":
      return "markdown";
    case "yml":
    case "yaml":
      return "yaml";
    case "toml":
    case "ini":
    case "cfg":
    case "env":
      return "ini";
    case "sh":
    case "bash":
    case "zsh":
      return "bash";
    case "sql":
      return "sql";
    case "xml":
    case "svg":
    case "plist":
      return "xml";
    case "diff":
    case "patch":
      return "diff";
    case "dockerfile":
      return "dockerfile";
    case "graphql":
    case "gql":
      return "graphql";
    case "lua":
      return "lua";
    case "r":
      return "r";
    case "scala":
      return "scala";
    case "dart":
      return "dart";
    case "ex":
    case "exs":
      return "elixir";
    case "hs":
      return "haskell";
    // "tf" → hcl: highlight.js has no hcl in the loaded bundle, so it
    // falls through to auto-detect.
    default:
      return undefined;
  }
}

/** hljs → our structural classes (mapped to theme vars in the stylesheet). */
const HLJS_CLASS_MAP: Array<[RegExp, string]> = [
  [/^hljs-keyword$/, "tok-kw"],
  [/^hljs-built_in$/, "tok-builtin"],
  [/^hljs-type$/, "tok-type"],
  [/^hljs-literal$/, "tok-lit"],
  [/^hljs-number$/, "tok-num"],
  [/^hljs-string$/, "tok-str"],
  [/^hljs-regexp$/, "tok-regex"],
  [/^hljs-comment$/, "tok-com"],
  [/^hljs-doctag$/, "tok-doc"],
  [/^hljs-title function_$/, "tok-fn"],
  [/^hljs-title class_$/, "tok-class"],
  [/^hljs-title$/, "tok-title"],
  [/^hljs-params$/, "tok-params"],
  [/^hljs-variable$/, "tok-var"],
  [/^hljs-name$/, "tok-name"],
  [/^hljs-attr$/, "tok-attr"],
  [/^hljs-attribute$/, "tok-attr"],
  [/^hljs-selector-/, "tok-sel"],
  [/^hljs-operator$/, "tok-op"],
  [/^hljs-punctuation$/, "tok-punct"],
  [/^hljs-meta/, "tok-meta"],
  [/^hljs-addition$/, "tok-add"],
  [/^hljs-deletion$/, "tok-del"],
];

let hljsPromise: Promise<any> | null = null;
async function getHljs(): Promise<any> {
  hljsPromise ??= import("highlight.js/lib/common").then((mod) => mod.default);
  return hljsPromise;
}

function mapHljsClasses(html: string): string {
  return html.replace(/class="([^"]*)"/g, (_m, cls: string) => {
    const mapped = cls
      .split(/\s+/)
      .map((c) => {
        if (c === "hljs") return "tok";
        for (const [re, out] of HLJS_CLASS_MAP) {
          if (re.test(cls) && c !== "hljs") {
            if (re.source === "^hljs-title function_$" && c === "title") return "tok-fn";
            if (re.source === "^hljs-title class_$" && c === "title") return "tok-class";
            if (re.source === "^hljs-meta" && c === "meta") return "tok-meta";
            if (re.source === "^hljs-title$" && c === "title") return out;
            if (re.test(c)) return out;
          }
        }
        return c;
      })
      .join(" ");
    return `class="${mapped}"`;
  });
}

export async function highlightCode(text: string, language?: string): Promise<string> {
  const src = text || "";
  const hljs = await getHljs();
  let html: string;
  if (language && typeof hljs.getLanguage === "function" && hljs.getLanguage(language)) {
    html = hljs.highlight(src, { language, ignoreIllegals: true }).value;
  } else if (typeof hljs.highlightAuto === "function") {
    html = hljs.highlightAuto(src).value;
  } else {
    html = src
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  return mapHljsClasses(html);
}

/** Display-only file preview payload with an optional highlight language. */
export interface PreviewFile {
  name: string;
  mime: string;
  text?: string;
  dataUrl?: string;
  dataB64?: string;
  size?: number;
  truncated?: boolean;
  fullText?: string;
  /** hljs language id (undefined = auto-detect). */
  language?: string;
}

/**
 * Escapes raw text to HTML. Used as a stopgap identity "highlight" so raw
 * tool/file output renders identically until the async highlighter resolves.
 */
export function escapeHtml(src: string): string {
  return (src || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Renders code/text with syntax highlighting (extension-detected or
 * auto-detected for extension-less content like diffs). The highlighted
 * HTML is re-computed reactively when text/language change via the
 * hl-loaded singleton — escaped <pre> until the lib arrives (same paint as
 * before, zero layout shift). innerHTML below only ever carries one of two
 * safe payloads: highlight.js-generated spans (built from escaped text) or
 * escapeHtml() output — never raw upstream strings.
 */
export function CodeBlock(props: {
  text: string;
  language?: string;
  bare?: boolean;
  maxH?: string;
}) {
  const [html, setHtml] = createSignal<string | null>(null);
  createEffect(() => {
    const text = props.text || "";
    const lang = props.language;
    setHtml(null);
    let cancelled = false;
    void highlightCode(text, lang).then((h) => {
      if (!cancelled) setHtml(h);
    }).catch(() => { if (!cancelled) setHtml(escapeHtml(text)); });
    onCleanup(() => {
      cancelled = true;
    });
  });
  return (
    <pre
      class={`px-3 py-2 text-[11px] text-ink-300 overflow-x-auto whitespace-pre-wrap ${
        props.maxH || "max-h-56"
      }`}
    >
      <Show
        when={html() !== null}
        // eslint-disable-next-line solid/no-innerhtml
        fallback={<code class="tok" innerHTML={escapeHtml(props.text || "")} />}
      >
        {/* eslint-disable-next-line solid/no-innerhtml */}
        <code class="tok" innerHTML={html() || ""} />
      </Show>
    </pre>
  );
}
/**
 * Renders a unified context diff (daemon edit results). Diff marker lines
 * (+/-) keep their red/green lane so added/removed still jump out; the line
 * BODY is syntax-highlighted per the file extension, and a truncate
 * control caps long diffs exactly like the file preview.
 */
export function DiffView(props: { text: string; max?: number; name?: string }) {
  const [expanded, setExpanded] = createSignal(false);
  const [html, setHtml] = createSignal<string | null>(null);
  const lines = () => (props.text || "").split("\n");
  const max = () => props.max ?? 80;
  const shown = () => {
    const all = lines();
    return expanded() ? all : all.slice(0, max());
  };
  const shownText = () => shown().join("\n");
  const hidden = () => Math.max(0, lines().length - shown().length);
  createEffect(() => {
    const text = shownText();
    const lang = languageForPath(props.name);
    setHtml(null);
    let cancelled = false;
    void Promise.all(text.split("\n").map(async (line) => {
      const marker = /^[ +-]/.test(line) ? line[0] : "";
      return escapeHtml(marker) + await highlightCode(marker ? line.slice(1) : line, lang);
    })).then((rows) => { if (!cancelled) setHtml(rows.join("\n")); })
      .catch(() => { if (!cancelled) setHtml(escapeHtml(text)); });
    onCleanup(() => {
      cancelled = true;
    });
  });
  // Keep one token per line so lane classes line up with the highlighted
  // body (the hl spans are injected inside each lane row, never across;
  // same safe-payload rule as CodeBlock applies). Newline splitting is
  // correct: hljs emits no raw newlines inside its own tags, so each source
  // line maps 1:1 to one rendered row (verified for diff + typescript).
  const rows = () => (html() ?? "").split("\n");
  return (
    <div class="font-mono text-[11px] leading-relaxed overflow-x-auto">
      <Show
        when={html() !== null}
        fallback={
          <For each={shown()}>
            {(ln) => (
              // eslint-disable-next-line solid/no-innerhtml
              <div class="px-3 whitespace-pre text-ink-400" innerHTML={escapeHtml(ln || " ")} />
            )}
          </For>
        }
      >
        <For each={rows()}>
          {(row) => {
            const plain = row.replace(/<[^>]*>/g, "");
            const cls =
              plain.startsWith("+") && !plain.startsWith("+++")
                ? "bg-emerald-500/10"
                : plain.startsWith("-") && !plain.startsWith("---")
                  ? "bg-rose-500/10"
                  : "text-ink-600";
            return (
              <div class={`px-3 whitespace-pre ${cls}`}>
                {/* eslint-disable-next-line solid/no-innerhtml */}
                <code class="tok" innerHTML={row || " "} />
              </div>
            );
          }}
        </For>
      </Show>
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
  const [appNotice, setAppNotice] = createSignal<{ message: string; kind: "ok" | "err" } | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  function toast(message: string, kind: "ok" | "err" = "ok") {
    clearTimeout(noticeTimer);
    setAppNotice({ message, kind });
    if (kind === "ok") noticeTimer = setTimeout(() => setAppNotice(null), 5000);
  }
  onCleanup(() => clearTimeout(noticeTimer));
  const [draftMode, setDraftMode] = createSignal(true);
  const [creatingSession, setCreatingSession] = createSignal(false);
  let creationRequestId = "";
  const [effort, setEffort] = createSignal("medium");
  const [agentMode, setAgentMode] = createSignal("build");
  const [selectedSkills, setSelectedSkills] = createSignal<string[]>([]);
  const [modeMenuOpen, setModeMenuOpen] = createSignal(false);
  const [accessMenuOpen, setAccessMenuOpen] = createSignal(false);
  let modeBtn: HTMLButtonElement | undefined;
  let accessBtn: HTMLButtonElement | undefined;
  const [expandedSessionLists, setExpandedSessionLists] = createSignal<Record<string, boolean>>({});
  const [folderEntries, setFolderEntries] = createSignal<{ name: string; path: string }[]>([]);
  const [folderParent, setFolderParent] = createSignal("");
  const [folderCurrent, setFolderCurrent] = createSignal("");
  const [folderLoading, setFolderLoading] = createSignal(false);
  const [folderError, setFolderError] = createSignal("");
  let folderRequestId = "";
  let projectCreationId = "";
  const [pendingProjectId, setPendingProjectId] = createSignal("");
  interface ReviewFile { canUndo?: boolean; truncated?: boolean; path: string; kind: string; before?: string; after?: string; binary?: boolean; }
  interface Review { id: string; files: ReviewFile[]; notice?: string; }
  const [taskReview, setTaskReview] = createSignal<Review | null>(null);
  const [reviewOpen, setReviewOpen] = createSignal(false);
  const [reviewLoading, setReviewLoading] = createSignal(false);
  const [reviewError, setReviewError] = createSignal("");
  let reviewRequestId = "";
  function sessionOptions() { return { effort: effort(), mode: agentMode(), skills: selectedSkills(), access: yoloMode() ? "full" : "ask" }; }
  function configureSession() {
    if (wsOpen()) sendWS({ type: "configure_session", sessionId: activeSessionId(), model: activeModel(), options: sessionOptions() });
  }
  function applyOptions(options: any) {
    setEffort(options?.effort || "medium");
    setAgentMode(options?.mode || "build");
    setSelectedSkills(Array.isArray(options?.skills) ? options.skills : []);
    setYoloMode(options?.access !== "ask");
  }
  function requestFolders(path: string) {
    setNewProjectPath(path);
    if (!wsOpen() || activeHost()?.status !== "online") { setFolderError("Connect this host to browse its folders."); return; }
    setFolderLoading(true); setFolderError("");
    folderRequestId = crypto.randomUUID();
    sendWS({ type: "browse_folders", path: path || "~", requestId: folderRequestId });
  }
  function requestReview(detail = false) {
    if (!activeSessionId() || !wsOpen()) return;
    if (detail) { setReviewOpen(true); setReviewLoading(true); setReviewError(""); }
    reviewRequestId = crypto.randomUUID();
    sendWS({ type: "get_changes", sessionId: activeSessionId(), detail, requestId: reviewRequestId });
  }
  async function undoChanges(path = "") {
    const review = taskReview();
    if (!review || sessionStatus() === "running" || !wsOpen()) return;
    const yes = await showConfirm({ title: path ? "Undo this file?" : "Undo task changes?", message: "Restore the captured files to their state before the task. Files edited afterward will be preserved.", confirmText: "Undo changes" });
    if (!yes) return;
    setReviewLoading(true); setReviewError("");
    reviewRequestId = crypto.randomUUID();
    sendWS({ type: "undo_changes", sessionId: activeSessionId(), reviewId: review.id, path, detail: reviewOpen(), requestId: reviewRequestId });
  }

  // Hosts & Pairing
  const [hosts, setHosts] = createSignal<RemoteHostDto[]>([]);
  const [activeHostId, setActiveHostId] = createSignal<string>("");
  const [showPairModal, setShowPairModal] = createSignal(false);
  const [pairingData, setPairingData] = createSignal<RemotePairDto | null>(null);
  const [pairingLoading, setPairingLoading] = createSignal(false);

  // Gateway Models (Fetched live from /api/me/models)
  const [gatewayModels, setGatewayModels] = createSignal<
    GatewayModel[]
  >([]);

  // UI-only state. Projects / sessions / config are NOT signals here: they
  // are SignalDB collections mirroring the daemon (IndexedDB per host), so
  // they paint instantly from cache and self-correct on every change ping.
  // The page never owns this data — reconnecting from any device/domain
  // shows the very same truth.
  const [activeSessionId, setActiveSessionId] = createSignal<string>("");
  const [sessionFilter, setSessionFilter] = createSignal<string>("");
  // New conversations remain local drafts until their first message is sent.

  // Projects (Antigravity-style: pasta no host agrupa conversas)
  const [activeProjectId, setActiveProjectId] = createSignal<string>("");
  const [showNewProjectModal, setShowNewProjectModal] = createSignal(false);
  const [newProjectPath, setNewProjectPath] = createSignal("");
  const [projectMenuOpen, setProjectMenuOpen] = createSignal(false);

  function pickProject(id: string) {
    setActiveProjectId(id);
  }
  function openNewProjectModal() {
    setShowNewProjectModal(true);
    requestFolders(activeProject()?.path || "~");
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
  const [activeModel, setActiveModel] = createSignal("");
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
  const [sessionContexts, setSessionContexts] = createSignal<Record<string, SessionContext | null>>({});
  const activeContext = createMemo(() => contextDisplay(
    sessionContexts()[activeSessionId()] ?? null,
    gatewayModels().find((model) => model.id === activeModel()),
  ));
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
  // Expanded thinking blocks: reasoning never starts open by itself —
  // the exception is the live one (auto-opens while it streams, then keeps
  // the user's toggle state after it ends).
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
  const [modelFilter, setModelFilter] = createSignal("");
  /** Fresh snapshot on every open: stale scroll position/filter never linger. */
  createEffect(() => {
    if (modelMenuOpen()) setModelFilter("");
  });
  const filteredGatewayModels = createMemo(() => {
    const q = modelFilter().trim().toLowerCase();
    const all = gatewayModels();
    if (!q) return all;
    return all.filter(
      (m) =>
        m.id.toLowerCase().includes(q) || (m.name || "").toLowerCase().includes(q),
    );
  });
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

  // Live thinking timer (chatbot thinkingElapsed). thinkingIndex tracks
  // WHICH reasoning block of the live assistant message the timer belongs
  // to, so the clock + ticking dots stick to the right panel when one
  // message carries several thinkings.
  const [thinkingStart, setThinkingStart] = createSignal<number | null>(null);
  const [thinkingElapsed, setThinkingElapsed] = createSignal(0);
  const [thinkingIndex, setThinkingIndex] = createSignal(0);
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
  const [previewFile, setPreviewFile] = createSignal<PreviewFile | null>(null);
  const [previewCopied, setPreviewCopied] = createSignal(false);
  const [truncateTokens, setTruncateTokens] = createSignal(16000);
  const [showTruncateInput, setShowTruncateInput] = createSignal(false);

  // Agent Configuration & MCP Center
  const [showConfigModal, setShowConfigModal] = createSignal(false);
  const [daemonSettings, setDaemonSettings] = createSignal<AgentSettings>({
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
  const [connectionState, setConnectionState] = createSignal<"connecting" | "connected" | "disconnected">("disconnected");
  const [hostMenuOpen, setHostMenuOpen] = createSignal(false);
  let hostBtn: HTMLButtonElement | undefined;
  let contextBtn: HTMLButtonElement | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let disposed = false;
  let initialScrollSession = "";
  let transcriptRequestId = "";
  const [chatContentRef, setChatContentRef] = createSignal<HTMLDivElement | null>(null);
  const transcriptScroll = createTranscriptScroll({
    element: chatContainerRef,
    running: () => sessionStatus() === "running",
    atBottom: setIsAtBottom,
  });
  createEffect(() => {
    const content = chatContentRef();
    if (!content) return;
    const observer = new ResizeObserver(() => transcriptScroll.schedule());
    observer.observe(content);
    onCleanup(() => observer.disconnect());
  });
  onCleanup(() => {
    disposed = true;
    clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    stopThinkingTimer();
    transcriptScroll.dispose();
    dataLayer.disconnect();
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    confirmState()?.resolve(false);
  });
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

  function visibleSessions(key: string, list: SessionSummary[]) {
    if (expandedSessionLists()[key] || sessionFilter().trim()) return list;
    return sortedSessions([...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10));
  }
  function sessionListToggle(key: string, count: number) {
    return <Show when={count > 10 && !sessionFilter().trim()}><button class="px-3 py-2 text-xs text-ink-500 hover:text-ink-200 cursor-pointer" aria-expanded={!!expandedSessionLists()[key]}
      onClick={() => setExpandedSessionLists((prev) => ({ ...prev, [key]: !prev[key] }))}>{expandedSessionLists()[key] ? "Show less" : `See all (${count})`}</button></Show>;
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
      const res = await api<{ models: GatewayModel[] }>("GET", "/api/me/models");
      if (disposed) return;
      const models = (res.models || []).filter((m) => m.proto !== "anthropic");
      setGatewayModels(models);
      if (!models.some((m) => m.id === activeModel())) {
        setActiveModel(models[0]?.id || "");
      }
    } catch {
      toast("Could not refresh the gateway model catalog", "err");
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
    clearTimeout(reconnectTimer);
    clearInterval(heartbeatTimer);
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
    dataLayer.disconnect();
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
      void loadGatewayModels();
      dataLayer.storeFor(hostId).syncAll();
      if (activeSessionId()) { sendWS({ type: "get_session", sessionId: activeSessionId() }); requestReview(reviewOpen()); }
      heartbeatTimer = setInterval(() => sendWS({ type: "ping", ts: Date.now() }), 15000);
    };
    socket.onmessage = (ev) => {
      if (socket !== ws || disposed) return;
      try { batch(() => handleIncomingMessage(JSON.parse(ev.data))); }
      catch (err) { console.error("Remote Code message error:", err); }
    };
    socket.onclose = () => {
      if (socket !== ws || disposed) return;
      clearInterval(heartbeatTimer);
      setConnectionState("disconnected");
      setCreatingSession(false);
      setFolderLoading(false);
      setReviewLoading(false);
      dataLayer.disconnect();
      stopThinkingTimer();
      const delay = Math.min(1000 * 2 ** reconnectAttempt++, 15000);
      reconnectTimer = setTimeout(async () => {
        // An authenticated request refreshes an expired dashboard token first.
        await loadHosts();
        if (!disposed && activeHostId() === hostId) connectWebSocket(hostId);
      }, delay);
    };
  }

  function sendWS(payload: any) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (!payload.hostId && activeHostId()) {
        payload.hostId = activeHostId();
      }
      if (payload.type === "get_session") {
        transcriptRequestId = crypto.randomUUID();
        payload.requestId = transcriptRequestId;
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
  // Tool results in provider shape ({content:[...]}): text stays raw, image
  // parts become a one-line placeholder (never dump base64 JSON into a
  // row). The real image bytes ride the daemon's user-mirror message and
  // are rendered as previews from there.
  function toolResultText(c: any): string {
    const content = c.content ?? c.result;
    if (typeof content === "string") return content;
    const partText = (p: any): string => {
      if (typeof p === "string") return p;
      if (typeof p?.text === "string") return p.text;
      if (p && typeof p.mime_type === "string") {
        return `[image${p.mime_type ? ` ${p.mime_type}` : ""}]`;
      }
      return prettyArgs(p);
    };
    if (Array.isArray(content)) {
      return content.map(partText).join("\n");
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
        const txt = c.summary || c.thinking || c.reasoning || c.text || "";
        if (txt || typeof c.reasoning_id === "string" || typeof c.encrypted_content === "string") {
          blocks.push({ type: "reasoning", reasoning: txt });
        }
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
      // Daemon's image mirror: the tool already shows a collapsible row with
      // its output — the mirror carries the SAME bytes, so drop it (keeping
      // a duplicate caption under the tool would just repeat the tool). The
      // image blocks here and the ones folded from tool results both die
      // together with their carrier row.
      if (
        rest.length > 0 &&
        rest[0].type === "text" &&
        (rest[0].text || "").trim().startsWith(TOOLS_IMAGE_MARKER)
      ) {
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
    if (initialScrollSession === sessionId) {
      initialScrollSession = "";
      scrollToBottom(true);
    } else {
      scrollToBottom();
    }
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
          (src.cache_read_tokens ?? 0) + (src.cache_write_tokens ?? src.cache_creation_tokens ?? 0),
        reasoningTok: src.reasoning_tokens ?? prev[sessionId]?.reasoningTok ?? 0,
        costUsd: src.cost_usd ?? prev[sessionId]?.costUsd ?? 0,
      },
    }));
  }
  function handleIncomingMessage(msg: any) {
    // SignalDB sync protocol messages (pull responses / change pings) are
    // owned by the data layer; everything else is event-driven below.
    if (dataLayer.handleMessage(msg)) return;
    // The relay fans out every host; foreground events belong to the selected host only.
    if (msg.type !== "host_status" && msg.hostId && msg.hostId !== activeHostId()) return;
    switch (msg.type) {
      case "relay_connected":
        break;
      case "host_status": {
        if (msg.hostId === activeHostId() && msg.status === "online") {
          dataLayer.storeFor(msg.hostId).syncAll();
          if (activeSessionId()) sendWS({ type: "get_session", sessionId: activeSessionId() });
        }
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
        if (!creatingSession() || msg.requestId !== creationRequestId) break;
        const r = msg.session;
        if (!r?.id) break;
        setCreatingSession(false);
        setDraftMode(false);
        const firstDraft = inputPrompt();
        setActiveSessionId(r.id);
        setInputPrompt(firstDraft);
        try { localStorage.setItem(`llmgw-draft:${r.id}`, firstDraft); } catch {}
        applyOptions(r.options);
        // Attachments stay in the draft until upload succeeds on this new session.
        void sendPrompt();
        break;
      }
      case "project_created": {
        if (msg.requestId !== projectCreationId) break;
        const p = msg.project;
        if (!p?.id) break;
        setShowNewProjectModal(false);
        setPendingProjectId(p.id);
        dataLayer.storeFor(activeHostId()).syncAll();
        toast(`Project '${p.name || "Project"}' added`, "ok");
        break;
      }
      case "folders": {
        if (msg.requestId !== folderRequestId) break;
        setFolderLoading(false);
        if (msg.error) { setFolderError(msg.error); break; }
        setFolderEntries(msg.folders || []);
        setFolderParent(msg.parent || "");
        setFolderCurrent(msg.path || "");
        setNewProjectPath(msg.path || "");
        break;
      }
      case "session_changes": {
        if (msg.sessionId !== activeSessionId() || (msg.requestId && msg.requestId !== reviewRequestId)) break;
        setReviewLoading(false);
        if (msg.error) { setReviewError(msg.error); if (!reviewOpen()) toast(msg.error, "err"); break; }
        setTaskReview(msg.review || null);
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
        if (msg.requestId && msg.requestId !== transcriptRequestId) break;
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
          setSessionStatus(r.status === "running" ? "running" : "idle");
          if (r.model) setActiveModel(gatewayModels().some((m) => m.id === r.model) ? r.model : gatewayModels()[0]?.id || "");
          applyOptions(r.options);
          if (r.usage) applyUsage(sid, r.usage, null);
          setSessionContexts((prev) => ({ ...prev, [sid]: r.context ?? null }));
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
          setSessionStatus(msg.status === "running" ? "running" : "idle");
          if (msg.status === "idle") {
            requestReview(reviewOpen());
            setPendingApproval(null);
            setToolProgress({});
            if (thinkingStart() !== null) stampThinkingDuration(stopThinkingTimer());
          }
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
          setSessionContexts((prev) => ({ ...prev, [msg.sessionId]: msg.context ?? null }));
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
        } else if (ev.type === "assistant_start") {
          // Each model step gets its own carrier. Tool loops cannot merge new
          // thinking into the previous assistant response.
          setMessages((prev) => [...prev, {
            id: `asst_${crypto.randomUUID()}`, role: "assistant", blocks: [], time: Date.now(),
          }]);
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
          if (thinkingStart() !== null) stampThinkingDuration(stopThinkingTimer());
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
          if (ev.context) {
            setSessionContexts((prev) => ({ ...prev, [msg.sessionId]: ev.context }));
            const configured = gatewayModels().find((m) => m.id === ev.context.model)?.limit?.context ?? 0;
            if (configured !== ev.context.windowTokens) void loadGatewayModels();
          }
        } else if (ev.type === "compact_progress") {
          if (ev.text === "Compacting older context…") toast(ev.text, "ok");
        } else if (ev.type === "turn_end") {
          // This ends one model call; tools and subsequent steps may still run.
          if (thinkingStart() !== null) {
            const dur = stopThinkingTimer();
            stampThinkingDuration(dur);
          }
          if (ev.usage || ev.cumulative) applyUsage(msg.sessionId, ev.usage, ev.cumulative);
          if (ev.error) toast(ev.error, "err");
          // The daemon sends the final snapshot and idle status after the task.
        } else if (ev.type === "done") {
          // Compatibility with daemons that predate final session snapshots.
          sendWS({ type: "get_session", sessionId: msg.sessionId });
        } else if (ev.type === "error") {
          toast(ev.message || "Agent error", "err");
          setSessionStatus("idle");
        }
        scrollToBottom();
        break;
      }

      case "error": {
        if (msg.requestId === creationRequestId) { setCreatingSession(false); }
        if (msg.requestId === folderRequestId) { setFolderLoading(false); setFolderError(msg.message || "Could not browse folders"); break; }
        if (msg.requestId === projectCreationId && showNewProjectModal()) { setFolderError(msg.message || "Could not create project"); break; }
        if (msg.sessionId && msg.sessionId !== activeSessionId()) break;
        if (msg.requestId && uploadWaiters.has(msg.requestId)) {
          const w = uploadWaiters.get(msg.requestId)!;
          uploadWaiters.delete(msg.requestId);
          w.fail(msg.message || "Upload failed");
          break;
        }
        if (msg.replyTo === "create_session") setCreatingSession(false);
        if (msg.replyTo === "get_changes" || msg.replyTo === "undo_changes") { setReviewLoading(false); setReviewError(msg.message || "Host unavailable"); }
        if (msg.message === "Remote host is offline") {
          setHosts((prev) => prev.map((h) => h.id === activeHostId() ? { ...h, status: "offline" } : h));
          if (msg.replyTo === "browse_folders") { setFolderLoading(false); setFolderError("The host went offline. Reconnect to browse its folders."); }
          break;
        }
        // Sync pulls on an offline host are expected background noise.
        if (msg.replyTo === "pull") break;

        toast(msg.message || "Daemon returned an error", "err");
        if (activeSessionId()) sendWS({ type: "get_session", sessionId: activeSessionId() });
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
          const merged = {
            ...blocks[ri],
            reasoning: (blocks[ri].reasoning || "") + delta,
          };
          const next = [...blocks];
          // Keep the merged panel at the top so text never overtakes it.
          next.splice(ri, 1);
          next.unshift(merged);
          return [...prev.slice(0, -1), { ...last, blocks: next }];
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
    // The live clock/ticks belong to this message's first reasoning block.
    setThinkingIndex(0);
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

  function scrollToBottom(force = false) { transcriptScroll.schedule(force); }
  function onChatScroll() { transcriptScroll.measure(); }

  function selectSession(id: string) {
    if (creatingSession()) return;
    setDraftMode(false);
    setTaskReview(null);
    setReviewOpen(false);
    setAppNotice(null);
    initialScrollSession = id;
    transcriptScroll.reset();
    setMessages([]);
    setSessionStatus("idle");
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
    requestReview();
  }

  // Open a centered draft without creating a conversation on the host.
  function startNewConversation(projectId?: string) {
    if (creatingSession()) return;
    setDraftMode(true);
    setHistoryView(false);
    setActiveSessionId("");
    setMessages([]);
    setInputPrompt("");
    setSessionStatus("idle");
    setPendingApproval(null);
    setTaskReview(null);
    setReviewOpen(false);
    setAppNotice(null);
    setAgentMode("build");
    setSelectedSkills([]);
    stopThinkingTimer();
    transcriptScroll.reset();
    for (const p of pendingAttachments()) if (p.objectUrl) URL.revokeObjectURL(p.objectUrl);
    setPendingAttachments([]);
    if (projectId) setActiveProjectId(projectId);
    if (isMobile()) setSidebarOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("#rc-composer")?.focus());
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
    // Daemon is the source of truth; ack arrives as project_created.
    projectCreationId = crypto.randomUUID();
    sendWS({ type: "create_project", path: rawPath, requestId: projectCreationId });
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
    projectCreationId = crypto.randomUUID();
    sendWS({ type: "create_project", path: "~", requestId: projectCreationId });
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

  /** Session choices, also remembered by the daemon for the next draft. */
  function modelPickerBody() {
    return (
      <>
        <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider flex items-center justify-between">
          <span>Model</span>
          <button
            onClick={async () => {
              await loadGatewayModels();
              toast("Models refreshed", "ok");
            }}
            class="p-0.5 text-ink-600 hover:text-ink-200 cursor-pointer"
            data-rc-tip="Refresh models" aria-label="Refresh models"
          >
            <Iconify icon="lucide:refresh-cw" size={11} />
          </button>
        </div>
        <div class="px-2 pb-1">
          <input
            type="text"
            placeholder="Search models..."
            class="w-full bg-ink-950 border border-line/60 rounded-lg px-2.5 py-1.5 text-[11px] text-ink-100 placeholder:text-ink-600 focus:outline-none focus:border-ink-500"
            value={modelFilter()}
            onInput={(e) => setModelFilter(e.currentTarget.value)}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            ref={(el) => setTimeout(() => el?.focus(), 40)}
          />
        </div>
        <div class="max-h-56 overflow-y-auto">
          <For
            each={filteredGatewayModels()}
            fallback={
              <div class="px-2.5 py-2 text-[11px] text-ink-600">
                {gatewayModels().length ? "No models match." : "No compatible models configured in the gateway."}
              </div>
            }
          >
            {(m) => (
              <button
                onClick={() => {
                  const id = m.id;
                  setActiveModel(id);
                  setModelMenuOpen(false);
                  configureSession();
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
          <div class="grid grid-cols-7 gap-1 p-1 rounded-lg bg-ink-950 border border-line/50">
            <For each={REASONING_LEVELS}>
              {(lvl) => (
                <button
                  onClick={() => {
                    setEffort(lvl);
                    configureSession();
                    setModelMenuOpen(false);

                  }}
                  class={`py-1 rounded-md text-center text-[11px] font-medium lowercase cursor-pointer ${
                    effort() === lvl
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

      </>
    );
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

  /**
   * One thinking panel (button + collapsible body). Rendered from the
   * dedicated "thinking" parts (never from the text path), so reasoning is
   * always ABOVE its own tool group, live-streaming or persisted. The block
   * carries its own id so two thinkings inside one series never collide.
   */
  function renderThinkingBlock(
    msg: ChatMessage,
    block: ContentBlock,
    isLast: boolean,
    nth: number,
  ) {
    const thinkKey = () => `${msg.id}:think:${nth}`;
    const openNow = () => isLast && sessionStatus() === "running";
    const live = () =>
      openNow() && thinkingStart() !== null && thinkingIndex() === nth;
    const open = () => expandedThinking()[thinkKey()] ?? live();
    return (
      <div class="w-full">
        <button
          aria-expanded={open()}
          onClick={() => setExpandedThinking((prev) => ({ ...prev, [thinkKey()]: !open() }))}
          class={`flex items-center gap-1.5 text-xs transition-colors cursor-pointer ${
            openNow() ? "text-ink-300" : "text-ink-500 hover:text-ink-300"
          }`}
        >
          <Iconify icon="lucide:bot" size={14} />
          <span>
            {live()
              ? `Thinking ${thinkingElapsed()}s`
              : msg.thinkingDuration
                ? `Thinking ${msg.thinkingDuration}s`
                : open()
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
            class={`transition-transform ${open() ? "rotate-180" : ""}`}
          />
        </button>
        <Show when={open()}>
          <div class="mt-2 max-h-64 overflow-y-auto pl-3 border-l-2 border-line text-ink-400 whitespace-pre-wrap break-words text-xs leading-relaxed">
            {block.reasoning || "(thinking…)"}
          </div>
        </Show>
      </div>
    );
  }

  /**
   * The special aggregate balloon: one card per consecutive tool-call series
   * (possibly spanning several rendered assistant messages — see
   * buildRenderBlocks). It has its own chrome (header + collapse) and NO
   * per-message chrome of its own: the lead message's hover actions cover
   * the whole turn; the card itself carries no edit/delete/copy buttons.
   * `extraSrcIds` are the raw daemon indices fused in, used only for keys.
   */
  function renderAssistantSpecial(
    msgId: string,
    units: ToolUnit[],
    isLast: boolean,
    extraSrcIds: number[] = [],
  ) {
    const running = createMemo(() => isLast && sessionStatus() === "running");
    const summary = createMemo(() => specialTitle(units));
    const key = `${msgId}:special:${extraSrcIds.join(",")}`;
    const open = () => toolGroupOpen()[key] ?? true;
    return (
      <Show when={verboseChat()}>
        <div class="w-full rounded-xl border border-line/60 bg-ink-900/40 overflow-hidden">
          <button
            onClick={() => toggleToolGroup(key)}
            class="w-full flex items-center gap-2 px-3 py-2 hover:bg-ink-900/60 transition-colors cursor-pointer text-left"
          >
            <Show
              when={!running()}
              fallback={
                <span class="w-3.5 h-3.5 border-2 border-ink-500 border-t-transparent rounded-full animate-spin shrink-0" />
              }
            >
              <Iconify icon="lucide:bot" size={14} class="shrink-0 text-ink-500" />
            </Show>
            <span class="text-[13px] font-medium text-ink-300 truncate flex-1 min-w-0">
              {summary()}
            </span>
            <Show when={specialProgress(units)}>
              {(t) => (
                <span class="font-mono text-[11px] text-ink-600 truncate max-w-[40%] shrink-0">
                  {t()}
                </span>
              )}
            </Show>
            <Iconify
              icon="lucide:chevron-down"
              size={12}
              class={`shrink-0 text-ink-600 transition-transform ${open() ? "rotate-180" : ""}`}
            />
          </button>
          <Show when={open()}>
            <div class="border-t border-line/60 px-2 py-1.5 space-y-0.5">
              {renderToolSegs(msgId, extraSrcIds.join(",") || "lead", units, running())}
            </div>
          </Show>
        </div>
      </Show>
    );
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
  function beginConversationWith() {
    const proj = activeProject();
    if (!proj) {
      toast("Create a project first", "err");
      return;
    }
    if (!wsOpen()) {
      toast("Not connected to host yet — wait for online status", "err");
      return;
    }
    if (creatingSession()) return;
    setCreatingSession(true);
    creationRequestId = crypto.randomUUID();
    sendWS({ type: "create_session", requestId: creationRequestId, cwd: proj.path, title: "", model: activeModel(), options: sessionOptions() });
  }

  async function sendPrompt() {
    if (!wsOpen() || activeHost()?.status !== "online") {
      toast("Reconnect the host before sending a message", "err");
      return;
    }
    if (creatingSession()) return;
    if (!activeModel()) { toast("Configure a compatible model in the gateway first", "err"); return; }
    const text = inputPrompt().trim();
    const sid = activeSessionId();
    const hostId = activeHostId();
    const model = activeModel();
    const options = sessionOptions();
    // Slash fast-path: UI commands resolve locally, transcript ops go down.
    if (text.startsWith("/")) {
      try {
        if (sid) localStorage.removeItem(`llmgw-draft:${sid}`);
      } catch {}
      if (routeSlash(text)) { setInputPrompt(""); return; }
      if (!sid) {
        beginConversationWith();
        return;
      }
    }
    if (!text && pendingAttachments().length === 0) return;
    if (!sid) {
      beginConversationWith();
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
        if (activeHostId() === hostId && activeSessionId() === sid) {
          setSessionStatus("idle");
          toast(e?.message || "Attachment upload failed", "err");
        }
        return;
      }
    }
    if (disposed || activeHostId() !== hostId || activeSessionId() !== sid) return;
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
      model,
      yolo: options.access === "full",
      options,
      attachmentIds,
    });
  }

  function cancelCurrentTurn() {
    if (!activeSessionId()) return;
    sendWS({ type: "cancel", sessionId: activeSessionId() });
    stopThinkingTimer();
    transcriptScroll.detach();
    toast("Stopping generation…", "ok");
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

  // (executeSlashCommand: dead since the palette/help runtimes were removed —
  // the composer is the only entry point now, and it routes through routeSlash.)

  // Normalizes UI-visible effort labels to the daemon's canonical guess.
  // Matches NormalizeReasoning's aliases (off/min/med/hi/maximum) plus a
  // grid-friendly "none". Unknown input passes through: the provider layer
  // clamps it to the nearest supported level of the active model.
  function normalizeEffort(raw: string): string {
    const v = (raw || "").trim().toLowerCase();
    switch (v) {
      case "":
        return "";
      case "no":
      case "false":
      case "disabled":
      case "none":
      case "off":
        return "none";
      case "min":
      case "minimum":
        return "minimum";
      case "low":
        return "low";
      case "med":
      case "medium":
        return "medium";
      case "hi":
      case "high":
        return "high";
      case "maximum":
      case "xhigh":
        return "xhigh";
      case "max":
        return "max";
      default:
        return v;
    }
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
    switch (head) {
      case "/clear":
        startNewConversation();
        return true;
      case "/model":
        if (!arg) {
          toast(`Current model: ${activeModel()}`, "ok");
          return true;
        }
        setActiveModel(arg);
        configureSession();
        toast(`Model set to ${arg}`, "ok");
        return true;
      case "/reasoning": {
        const lvl = normalizeEffort(arg);
        if (!lvl || !(REASONING_LEVELS as readonly string[]).includes(lvl)) {
          toast(`Reasoning: ${effort()}`, "ok");
          return true;
        }
        setEffort(lvl);
                    configureSession();

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
  function openSettings(sectionId?: string) {
    try {
      setSettingsSnapshot(
        JSON.stringify({
          settings: daemonSettings(),
          mcp: mcpServers(),
          skills: skills(),
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


      }
    } catch {}
    setShowConfigModal(false);
  }

  // Save Settings to Daemon (translate UI keys to the daemon's Go keys).
  function saveDaemonConfig() {
    if (!wsOpen() || activeHost()?.status !== "online") { toast("Reconnect the host before saving settings", "err"); return false; }
    const s = daemonSettings();
    sendWS({
      type: "update_config",
      requestId: "upd_" + Date.now(),
      settings: {
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
    return true;
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
    if (skills()[name]) { toast("A skill with this name already exists. Choose a different name.", "err"); return; }
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
  onMount(() => {
    void Promise.allSettled([loadGatewayModels(), loadHosts()]).then(() => {
      if (!disposed && hosts().length === 0) generatePairingToken();
    });
    // Sidebar starts closed on mobile (chatbot useMobile).
    if (isMobile()) setSidebarOpen(false);
    const onResize = () => {
      try {
        const mobile = window.innerWidth <= 768;
        if (mobile && !isMobile()) setSidebarOpen(false);
        setIsMobile(mobile);
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
        if (document.querySelector("[role=dialog]")) return;
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
    {
      // Switching hosts swaps the whole world: nothing from the previous
      // daemon may bleed through (frontend = dumb monitor).
      untrack(() => {
        setDraftMode(true);
        setCreatingSession(false);
        creationRequestId = "";
        setTaskReview(null);
        setReviewOpen(false);
        setAppNotice(null);
        setActiveSessionId("");
        setActiveProjectId("");
        setMessages([]);
        setSessionStatus("idle");
        setPendingApproval(null);
        setSessionUsage({});
        setSessionContexts({});
        setToolProgress({});
        for (const attachment of pendingAttachments()) {
          if (attachment.objectUrl) URL.revokeObjectURL(attachment.objectUrl);
        }
        setPendingAttachments([]);
        setInputPrompt("");
        stopThinkingTimer();
        transcriptScroll.reset();
        reconnectAttempt = 0;
        connectWebSocket(hid);
      });
    }
  });

  createEffect(() => {
    const id = pendingProjectId();
    if (id && projects().some((p) => p.id === id)) untrack(() => {
      setPendingProjectId("");
      if (draftMode()) setActiveProjectId(id);
      else startNewConversation(id);
    });
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
        setDraftMode(true);
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
    if (draftMode() || activeSessionId()) return;
    if (!activeProjectId()) return;
    const ap = activeProject();
    if (!ap) return;
    const fresh = sessionsOfProject(ap.path)[0];
    if (fresh) selectSession(fresh.id);
  });

  // Daemon config mirror → local settings signals. Never clobbers an open
  // Settings modal (that would fight the user's in-flight edits). Model and
  // effort are restored separately from each session's own options.
  createEffect(() => {
    const doc = configDoc();
    if (!doc || showConfigModal()) return;
    const s: any = doc.settings || {};
    setDaemonSettings({
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

    if (doc.mcpServers && typeof doc.mcpServers === "object") setMcpServers(doc.mcpServers);
    if (doc.skills && typeof doc.skills === "object") setSkills(doc.skills);
  });

  createEffect(() => {
    const catalog = gatewayModels();
    const selection = configDoc()?.lastSelection;
    if (activeSessionId()) return;
    setActiveModel(catalog.find((m) => m.id === selection?.model)?.id || catalog[0]?.id || "");
    setEffort(selection?.effort || "medium");
  });

  // Auto-poll hosts while waiting for initial daemon pairing
  createEffect(() => {
    if (hosts().length === 0 || showPairModal()) {
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
    setModeMenuOpen(false);
    setAccessMenuOpen(false);
    setHostMenuOpen(false);
    setDisplayMenuOpen(false);
    setNewProjectMenuOpen(false);
    setAddContextOpen(false);
    setFilesMenuOpen(false);
    setModelMenuOpen(false);
    setProjectMenuOpen(false);
    setUsageOpen(false);
  }


  // Antigravity-style tool rows: one line per call, expandable output,
  // clickable files, inline diffs for edits.
  function toolRowKey(msgId: string, u: ToolUnit, fallback: number) {
    return `${msgId}:${u.call?.toolId || u.result?.toolId || "u" + fallback}`;
  }

  // (openToolPreview modal: removed — every collapsible tool row already
  //  is the file/diff viewer with its own scroll. Copy stays inline.)

  function renderToolUnit(msgId: string, u: ToolUnit, ui: number, running: boolean) {
    const key = () => toolRowKey(msgId, u, ui);
    const open = () => toolOpen()[key()] ?? (running && !u.result);
    const sum = createMemo(() => toolSummary(u));
    const prog = () => (u.call?.toolId ? toolProgress()[u.call.toolId] : undefined);
    const args = createMemo(() => tryParseArgs(u.call?.toolArgs));
    const name = () => u.call?.toolName || "tool";
    const failed = () => !!u.result?.isError;
    return (
      <div class="w-full">
        <div
          onClick={() => toggleToolOpen(key())}
          class="group/tool w-full flex items-center gap-2 pl-1 pr-1.5 py-1 rounded-lg cursor-pointer hover:bg-ink-900/70 text-[13px]"
          data-rc-tip={u.call?.toolArgs || name()}
        >
          <Show
            when={!(running && !u.result)}
            fallback={
              <span class="w-3.5 h-3.5 border-2 border-ink-500 border-t-transparent rounded-full animate-spin shrink-0" />
            }
          >
            <Iconify
              icon={failed() ? "lucide:x" : sum().icon}
              size={14}
              class={`shrink-0 ${failed() ? "text-rose-400" : "text-ink-500"}`}
            />
          </Show>
          <span class="text-ink-500 shrink-0">{sum().verb}</span>
          <Show when={args().path}><FileIcon path={String(args().path)} /></Show>
          <span class="truncate text-ink-200 font-medium min-w-0 flex-1">{sum().target}</span>
          <Show when={sum().statAdd != null || sum().statDel != null}>
            <span class="font-mono text-[11px] shrink-0">
              <Show when={(sum().statAdd || 0) > 0}>
                <span class="text-emerald-400">+{sum().statAdd}</span>
              </Show>
              <Show when={(sum().statAdd || 0) > 0 && (sum().statDel || 0) > 0}>
                <span class="text-ink-600"> </span>
              </Show>
              <Show when={(sum().statDel || 0) > 0}>
                <span class="text-rose-400">-{sum().statDel}</span>
              </Show>
            </span>
          </Show>
          <Show when={sum().stat && sum().statAdd == null}>
            <span class="text-[11px] text-ink-600 shrink-0">{sum().stat}</span>
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
            {/* Context body per tool kind (scrollable, always inline — the
                collapsible rows already are the "open file/diff" view). */}
            <Show when={name() === "edit" && u.result?.toolResult}>
              <DiffView
                text={u.result?.toolResult || ""}
                max={40}
                name={String(args().path || "")}
              />
              <div class="flex items-center gap-2 px-3 py-1.5 border-t border-line/50">
                <button
                  onClick={() => copyWithToast(u.result?.toolResult || "")}
                  class="text-[11px] text-ink-600 hover:text-ink-300 cursor-pointer"
                >
                  Copy
                </button>
              </div>
            </Show>
            <Show when={name() === "read"}>
              <Show
                when={u.result?.toolResult}
                fallback={<div class="px-3 py-2 text-[11px] text-ink-600">Waiting for output…</div>}
              >
                <CodeBlock
                  text={u.result?.toolResult || ""}
                  language={languageForPath(String(args().path || ""))}
                />
              </Show>
            </Show>
            <Show when={name() === "write"}>
              <CodeBlock
                text={String(args().content || u.result?.toolResult || "")}
                language={languageForPath(String(args().path || ""))}
              />
            </Show>
            <Show when={name() !== "edit" && name() !== "read" && name() !== "write"}>
              <Show
                when={u.result?.toolResult}
                fallback={<div class="px-3 py-2 text-[11px] text-ink-600">Waiting for output…</div>}
              >
                <pre class="px-3 py-2 text-[11px] text-ink-300 overflow-x-auto max-h-56 whitespace-pre-wrap">
                  {u.result?.toolResult || ""}
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

  /**
   * One-line card title for the special aggregate balloon: tool verbs
   * compressed (first 3 distinct, then "+N more") so a 20-call series
   * stays one readable line instead of a paragraph.
   */
  function specialTitle(units: ToolUnit[]): string {
    if (units.length === 0) return "Tools";
    const parts = units.map((u) => {
      const sum = toolSummary(u);
      return `${sum.verb} ${sum.target}`.trim();
    });
    const seen: string[] = [];
    for (const p of parts) {
      if (!seen.includes(p)) seen.push(p);
    }
    if (units.length === 1) return seen[0] || "Tool call";
    if (seen.length <= 3) return `${units.length} tool calls · ${seen.join(" · ")}`;
    return `${units.length} tool calls · ${seen.slice(0, 3).join(" · ")} +${seen.length - 3} more`;
  }

  /** Newest in-flight tool progress line inside a series (spinner sidecar). */
  function specialProgress(units: ToolUnit[]): string | undefined {
    for (let i = units.length - 1; i >= 0; i--) {
      const id = units[i].call?.toolId;
      const t = id ? toolProgress()[id] : undefined;
      if (t) return t;
    }
    return undefined;
  }

  /**
   * Renders the non-tool content of ONE assistant message: thinking panels
   * (top) + text + images in wire order. Images pulled out into their own
   * helper so the series card and the single message share the renderer.
   * Lead thinking/text of a series head render through this same helper.
   */
  function renderImageBlock(block: ContentBlock) {
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
          data-rc-tip="Open preview" aria-label="Open preview"
        >
          <img src={src()} class="max-h-64 max-w-full object-contain" />
        </button>
      </Show>
    );
  }

  function renderMessageContent(msg: ChatMessage, isLast: boolean) {
    let thinkNth = 0;
    return (
      <div class="w-full space-y-2.5">
        <For each={splitToolRuns(msg.blocks)}>
          {(part) => {
            if (part.kind === "tools") {
              return renderAssistantSpecial(msg.id, part.units, isLast);
            }
            if (part.kind === "thinking") {
              return (
                <Show when={verboseChat()}>
                  <div class="w-full space-y-2">
                    <For each={part.blocks}>
                      {(block) => renderThinkingBlock(msg, block, isLast, thinkNth++)}
                    </For>
                  </div>
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
                  if (block.type === "image") return renderImageBlock(block);
                  return null;
                }}
              </For>
            );
          }}
        </For>
      </div>
    );
  }
  /**
   * Renders ONE render block: either a series (lead text/thinking in wire
   * order, then the aggregate card of the whole fused run) or a single
   * message with the legacy per-bubble chrome (edit/copy/regenerate/delete
   * on its own rendered position).
   */
  function renderSeriesLead(lead: ChatMessage, isLast: boolean) {
    let thinkNth = 0;
    return (
      <div class="w-full space-y-2.5">
        <For each={splitToolRuns(lead.blocks)}>
          {(part) => {
            if (part.kind === "tools") return null;
            if (part.kind === "thinking") {
              return (
                <Show when={verboseChat()}>
                  <div class="w-full space-y-2">
                    <For each={part.blocks}>
                      {(block) => renderThinkingBlock(lead, block, isLast, thinkNth++)}
                    </For>
                  </div>
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
                  if (block.type === "image") return renderImageBlock(block);
                  return null;
                }}
              </For>
            );
          }}
        </For>
      </div>
    );
  }
  /**
   * Per-series collapsible sub-groups (explore/command runs) inside the
   * special card. Same grouping as before, keyed on the series card so
   * state never collides across fused messages.
   */
  function renderToolSegs(msgId: string, keySalt: string, units: ToolUnit[], running: boolean) {
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
            const gkey = `${msgId}:${keySalt}:g${si()}`;
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

  /**
   * Render blocks for the conversation (recomputed when the transcript
   * changes). Series fusing is visual only: every block keeps its lead's
   * raw index (blockRawIdx) for per-message ops.
   */
  // Preserve DOM/component identity across deltas. Rebuilding <For> entries
  // on every token remounted Markdown and collapsed its height before repaint.
  const [renderState, setRenderState] = createStore<{ blocks: (RenderBlock & { id: string })[] }>({ blocks: [] });
  createEffect(() => {
    const blocks = buildRenderBlocks(messages()).map((block) => ({ ...block, id: block.msg.id }));
    setRenderState("blocks", reconcile(blocks));
  });
  const renderBlocks = () => renderState.blocks;

  /** Raw daemon index of a render block's lead message. */
  function blockRawIdx(block: RenderBlock): number {
    const i = messages().findIndex((msg) => msg.id === block.msg.id);
    return i >= 0 ? i : 0;
  }
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
        data-rc-tip={`${s.title}\n${s.cwd}`}
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
            data-rc-tip="Select" aria-label="Select"
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
                    data-rc-tip={s.pinned ? "Unpin" : "Pin"} aria-label={s.pinned ? "Unpin" : "Pin"}
                  >
                    <Iconify icon={s.pinned ? "lucide:pin-off" : "lucide:pin"} size={11} />
                  </button>
                  <button
                    onClick={(e) => deleteSession(s.id, e)}
                    class="p-0.5 text-ink-600 hover:text-rose-400 cursor-pointer"
                    data-rc-tip="Delete" aria-label="Delete"
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
      class="fixed inset-0 w-full h-dvh flex flex-col bg-ink-950 text-ink-100 overflow-hidden font-sans select-none z-50"
    >
      <RemoteHints />

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
                    data-rc-tip={selectionMode() ? "Exit selection mode" : "Select conversations"} aria-label={selectionMode() ? "Exit selection mode" : "Select conversations"}
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
                data-rc-tip="Display options" aria-label="Display options"
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
                    data-rc-tip="Create new project" aria-label="Create new project"
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
                        each={visibleSessions("all", sortedSessions(sessions().filter(matchQuery)))}
                        fallback={
                          <div class="px-2.5 py-3 text-xs text-ink-600">
                            No conversations yet. Start one above.
                          </div>
                        }
                      >
                        {(s) => sessionRow(s)}
                      </For>
                      {sessionListToggle("all", sessions().filter(matchQuery).length)}
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
                              data-rc-tip={p.path}
                            >
                              <Iconify
                                icon="lucide:chevron-right"
                                size={12}
                                class={`shrink-0 text-ink-600 transition-transform ${isProjectExpanded(p) ? "rotate-90" : ""}`}
                              />
                              <Iconify icon="lucide:folder" size={14} class="shrink-0 text-ink-500" />
                              <span class="truncate flex-1 font-medium">{p.name}</span>
                              <button aria-label={`New conversation in ${p.name}`} data-rc-tip="New conversation in this project" onClick={(e) => { e.stopPropagation(); startNewConversation(p.id); }}
                                class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 p-1 text-ink-500 hover:text-ink-100 cursor-pointer"><Iconify icon="lucide:plus" size={14} /></button>
                              <Show when={!p.protected}>
                                <button
                                  onClick={(e) => deleteProject(p.id, e)}
                                  class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-0.5 text-ink-600 hover:text-rose-400 cursor-pointer shrink-0"
                                  data-rc-tip="Remove project" aria-label="Remove project"
                                >
                                  <Iconify icon="lucide:x" size={12} />
                                </button>
                              </Show>
                            </div>
                            <Show when={isProjectExpanded(p)}>
                              <div class="ml-[13px] mt-0.5 space-y-0.5 border-l border-line/50 pl-1.5">
                                <For each={visibleSessions(p.id, list())}>
                                  {(s) => sessionRow(s)}
                                </For>
                                {sessionListToggle(p.id, list().length)}
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
                          <For each={visibleSessions("loose", looseSessions())}>
                            {(s) => sessionRow(s)}
                          </For>
                          {sessionListToggle("loose", looseSessions().length)}
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
            <button
              ref={hostBtn}
              data-menubtn
              aria-label="Select host"
              aria-haspopup="menu"
              aria-expanded={hostMenuOpen()}
              onClick={() => { const next = !hostMenuOpen(); closeMenus(); setHostMenuOpen(next); }}
              class="w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-elev transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 cursor-pointer"
            >
              <span class="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-card text-ink-400 shrink-0">
                <Iconify icon="lucide:monitor" size={16} />
              </span>
              <span class="flex-1 min-w-0">
                <span class="block truncate text-xs font-medium text-ink-200">{activeHost()?.name || activeHost()?.hostname || "Select host"}</span>
                <span class="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-500">
                  <span class={`h-1.5 w-1.5 rounded-full ${connectionState() === "connected" && activeHost()?.status === "online" ? "bg-accent-500" : "bg-ink-600"}`} />
                  {connectionState() !== "connected" ? "Reconnecting…" : activeHost()?.status === "online" ? "Connected" : "Offline"}
                </span>
              </span>
              <Iconify icon="lucide:chevrons-up-down" size={13} class="text-ink-500 shrink-0" />
            </button>
            <FloatMenu anchor={() => hostBtn} open={hostMenuOpen()} placement="top-start" width="18rem">
              <div class="px-2.5 py-2 text-[10px] uppercase tracking-wider font-semibold text-ink-500">Your hosts</div>
              <div role="menu" aria-label="Hosts" class="space-y-0.5">
                <For each={hosts()}>{(host) => (
                  <button role="menuitemradio" aria-checked={host.id === activeHostId()}
                    class="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-elev focus-visible:bg-elev cursor-pointer"
                    onClick={() => { setHostMenuOpen(false); setActiveHostId(host.id); }}>
                    <Iconify icon="lucide:monitor" size={15} class="text-ink-500 shrink-0" />
                    <span class="flex-1 min-w-0"><span class="block truncate text-xs text-ink-200">{host.name || host.hostname || host.id}</span>
                      <span class="block text-[11px] text-ink-500">{host.status === "online" ? "Online" : "Offline"}{host.os ? ` · ${host.os}` : ""}</span></span>
                    <Show when={host.id === activeHostId()}><Iconify icon="lucide:check" size={14} /></Show>
                  </button>
                )}</For>
              </div>
              <div class="mt-1 border-t border-line pt-1 space-y-0.5">
                <button class="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-ink-400 hover:bg-elev cursor-pointer"
                  onClick={() => { setHostMenuOpen(false); void loadHosts(); }}><Iconify icon="lucide:refresh-cw" size={13} />Refresh hosts</button>
                <button class="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-ink-200 hover:bg-elev cursor-pointer"
                  onClick={() => { setHostMenuOpen(false); void generatePairingToken(); }}><Iconify icon="lucide:plus" size={13} />Connect another host</button>
              </div>
            </FloatMenu>
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
          <Show when={activeHost() && connectionState() !== "connected"}>
            <div role="status" class="border-b border-line bg-elev px-4 py-2 text-center text-xs text-ink-400">
              Connection interrupted. Reconnecting to your host…
            </div>
          </Show>
          {/* Offline Banner when selected host is offline */}
          <Show when={activeHost() && activeHost()?.status !== "online"}>
            <div class="bg-amber-500/10 border-b border-amber-500/25 px-4 py-2.5 flex items-center justify-end text-xs text-amber-300 z-10">
              <div class="flex items-center gap-2 min-w-0">
                <span class="w-2 h-2 rounded-full bg-amber-400 animate-pulse shrink-0" />
                <span class="truncate">
                  Host <strong>{activeHost()?.name || activeHost()?.hostname || activeHost()?.id}</strong> is offline. Start the daemon on your machine: <code class="bg-amber-500/20 px-1 py-0.5 rounded font-mono">./llmgw-daemon</code>
                </span>
                <button
                  onClick={loadHosts}
                  class="text-[11px] underline hover:text-amber-100 cursor-pointer shrink-0"
                  data-rc-tip="Refresh" aria-label="Refresh"
                >
                  Refresh
                </button>
                <button
                  onClick={generatePairingToken}
                  class="text-[11px] px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 text-amber-200 cursor-pointer shrink-0"
                  data-rc-tip="Connect Another Host" aria-label="Connect Another Host"
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
              data-rc-tip="Back to LLM Gateway"
            >
              <Iconify icon="lucide:arrow-left" size={14} />
            </a>
            <button
              onClick={() => setSidebarOpen(!sidebarOpen())}
              class="p-1.5 rounded-md bg-ink-900/80 hover:bg-ink-800 border border-line/70 text-ink-400 hover:text-ink-200 transition-colors shadow-sm cursor-pointer"
              data-rc-tip={sidebarOpen() ? "Collapse sidebar" : "Expand sidebar"} aria-label={sidebarOpen() ? "Collapse sidebar" : "Expand sidebar"}
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
                      data-rc-tip="Back to chat" aria-label="Back to chat"
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
          <Show when={!draftMode()}>
          <div
            ref={setChatContainerRef}
            onScroll={onChatScroll}
            onWheel={(e) => { if (e.deltaY < 0) transcriptScroll.detach(); }}
            onPointerDown={() => transcriptScroll.detach()}
            onTouchMove={() => transcriptScroll.detach()}
            onKeyDown={(e) => { if (["ArrowUp", "PageUp", "Home"].includes(e.key)) transcriptScroll.detach(); }}
            tabindex="0"
            aria-label="Conversation"
            class="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 md:px-8 select-text [overflow-anchor:none]"
          >
          <div ref={setChatContentRef} class="pt-6 pb-10 space-y-6"
          >
            {/* Conversation Messages.
                buildRenderBlocks fuses consecutive assistant messages that
                are tool-only into one "series" block. Index bookkeeping
                below stays on RAW message positions: series extras are
                skipped for actions, and the lead keeps its own raw index so
                every per-message op still maps 1:1 to the daemon
                transcript — fusing is purely visual. */}
            <For each={renderBlocks()}>
              {(block, bi) => {
                const msg = block.msg;
                const isLast = () => bi() === renderBlocks().length - 1;
                const rawIdx = () => blockRawIdx(block);
                const textOf = () =>
                  msg.blocks
                    .filter((b) => b.type === "text" && b.text)
                    .map((b) => b.text as string)
                    .join("\n");
                const isEditing = () => editingMsgIdx() === rawIdx();
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
                          when={isEditing()}
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
                                data-rc-tip="Expand editor" aria-label="Expand editor"
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
                                  onClick={() => saveEditMsg(rawIdx(), msg)}
                                  class="text-xs bg-ink-100 text-ink-950 px-3 py-1 rounded-lg hover:bg-accent-400 font-medium cursor-pointer"
                                >
                                  Save and Send
                                </button>
                              </div>
                            </div>
                          </div>
                        </Show>
                        <Show when={!isEditing()}>
                          <div class="flex items-center gap-0.5 mt-1 opacity-0 group-hover/msg:opacity-100 transition-opacity">
                            <button
                              onClick={() => copyMsg(msg.id, textOf())}
                              class="p-1 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-900 transition-colors cursor-pointer"
                              data-rc-tip="Copy" aria-label="Copy"
                            >
                              <Iconify icon={copiedMsgId() === msg.id ? "lucide:check" : "lucide:copy"} size={13} />
                            </button>
                            <button
                              onClick={() => startEditMsg(rawIdx(), msg)}
                              class="p-1 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-900 transition-colors cursor-pointer"
                              data-rc-tip="Edit and resend" aria-label="Edit and resend"
                            >
                              <Iconify icon="lucide:pencil" size={13} />
                            </button>
                            <button
                              onClick={() => editUserMsg(msg)}
                              class="p-1 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-900 transition-colors cursor-pointer"
                              data-rc-tip="Edit in large editor" aria-label="Edit in large editor"
                            >
                              <Iconify icon="lucide:expand" size={13} />
                            </button>
                            <button
                              onClick={() => deleteMsg(rawIdx())}
                              class="p-1 rounded-md text-ink-500 hover:text-rose-400 hover:bg-ink-900 transition-colors cursor-pointer"
                              data-rc-tip="Delete" aria-label="Delete"
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
                          when={isEditing()}
                          fallback={
                            block.kind === "series" ? (
                              <>
                                {renderSeriesLead(msg, isLast())}
                                {renderAssistantSpecial(
                                  msg.id,
                                  block.units,
                                  isLast(),
                                  block.extras.map((e) => e.srcIdx ?? 0),
                                )}
                              </>
                            ) : (
                              renderMessageContent(msg, isLast())
                            )
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
                                onClick={() => saveEditMsg(rawIdx(), msg)}
                                class="text-xs bg-ink-100 text-ink-950 px-3 py-1 rounded-lg hover:bg-accent-400 font-medium cursor-pointer"
                              >
                                Save
                              </button>
                            </div>
                          </div>
                        </Show>

                        {/* Hover actions (chatbot-style) */}
                        <Show when={(sessionStatus() !== "running" || !isLast()) && !isEditing()}>
                          <div class="flex items-center gap-0.5 mt-1.5 opacity-0 group-hover/msg:opacity-100 transition-opacity">
                            <button
                              onClick={() => copyMsg(msg.id, textOf())}
                              class="p-1.5 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-900 transition-colors cursor-pointer"
                              data-rc-tip="Copy" aria-label="Copy"
                            >
                              <Iconify icon={copiedMsgId() === msg.id ? "lucide:check" : "lucide:copy"} size={14} />
                            </button>
                            <button
                              onClick={() => regenerateMsg(rawIdx())}
                              class="p-1.5 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-900 transition-colors cursor-pointer"
                              data-rc-tip="Regenerate response" aria-label="Regenerate response"
                            >
                              <Iconify icon="lucide:rotate-cw" size={14} />
                            </button>
                            <button
                              onClick={() => startEditMsg(rawIdx(), msg)}
                              class="p-1.5 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-900 transition-colors cursor-pointer"
                              data-rc-tip="Edit response" aria-label="Edit response"
                            >
                              <Iconify icon="lucide:pencil" size={14} />
                            </button>
                            <button
                              onClick={() => deleteMsg(rawIdx())}
                              class="p-1.5 rounded-md text-ink-500 hover:text-rose-400 hover:bg-ink-900 transition-colors cursor-pointer"
                              data-rc-tip="Delete" aria-label="Delete"
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
                        class="px-4 py-1.5 rounded-xl bg-ink-100 text-ink-950 hover:bg-accent-400 text-xs font-semibold transition-colors cursor-pointer"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => {
                          setYoloMode(true);
                          respondApproval(true);
                        }}
                        class="px-3.5 py-1.5 rounded-xl bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 border border-amber-500/30 text-xs font-semibold transition-colors cursor-pointer"
                        data-rc-tip="Approve and stop asking (YOLO)" aria-label="Approve and stop asking (YOLO)"
                      >
                        Always allow
                      </button>
                    </div>
                  </div>
                );
              }}
            </Show>
          </div>
          </div>
          </Show>
          </Show>

          {/* Composer estilo Antigravity — hidden entirely until a project
              exists: without a project there is nothing to type into. */}
          <Show when={!historyView()}>
          <div class={draftMode() ? "flex-1 min-h-0 overflow-y-auto flex items-center justify-center px-4 py-10" : "px-4 pb-4 pt-2 bg-ink-950 relative z-20"}>
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

            <div class="w-full max-w-2xl mx-auto">
              <Show when={draftMode()}>
                <h1 class="mb-6 text-2xl sm:text-3xl font-semibold tracking-tight text-ink-100">What would you like to work on?</h1>
                <div class="mb-3 flex justify-start" data-draft-project>
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
                      class="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-elev border border-line text-sm text-ink-200 hover:bg-ink-800 font-medium cursor-pointer"
                      data-rc-tip="Project (where new conversations start)" aria-label="Project (where new conversations start)"
                    >
                      <Iconify icon="lucide:folder" size={13} />
                      <span class="max-w-[110px] truncate">
                        {activeProject()?.name || "Select project"}
                      </span>
                      <Iconify icon="lucide:chevron-down" size={11} />
                    </button>
                    <FloatMenu anchor={() => projBtn} open={projectMenuOpen()} placement="bottom-start" width="18rem">
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
                                data-rc-tip={p.path} aria-label={p.path}
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
                </div>
              </Show>
              <Show when={taskReview()?.files.length && activeSessionId()}>
                <div class="mb-2 flex flex-wrap items-center justify-end gap-3 text-xs text-ink-400" data-task-changes>
                  <span class="flex items-center gap-1.5"><Iconify icon="lucide:files" size={14} />{taskReview()?.files.length} file{taskReview()?.files.length === 1 ? "" : "s"} changed</span>
                  <button onClick={() => undoChanges()} disabled={sessionStatus() === "running" || reviewLoading() || !wsOpen()} class="flex items-center gap-1 hover:text-ink-100 disabled:opacity-40 cursor-pointer"><Iconify icon="lucide:undo-2" size={13} />Undo</button>
                  <button onClick={() => requestReview(true)} disabled={sessionStatus() === "running" || reviewLoading() || !wsOpen()} class="px-3 py-1.5 rounded-lg border border-line hover:bg-elev text-ink-200 disabled:opacity-40 cursor-pointer">Review</button>
                </div>
              </Show>
              <Show when={appNotice()}>{(notice) =>
                <div role={notice().kind === "err" ? "alert" : "status"} class={`mb-3 flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs ${notice().kind === "err" ? "border-brand-500/30 bg-brand-500/5 text-ink-200" : "border-line bg-elev text-ink-300"}`}>
                  <Iconify icon={notice().kind === "err" ? "lucide:circle-alert" : "lucide:check"} size={15} class={notice().kind === "err" ? "text-brand-500" : "text-ink-400"} />
                  <span class="min-w-0 flex-1 break-words">{notice().message}</span>
                  <button aria-label="Dismiss notification" onClick={() => setAppNotice(null)} class="text-ink-500 hover:text-ink-100 cursor-pointer"><Iconify icon="lucide:x" size={13} /></button>
                </div>
              }</Show>
              <Show when={activeHost() && (connectionState() !== "connected" || activeHost()?.status !== "online")}>
                <div role="status" class="mb-3 rounded-xl border border-line bg-elev p-3 text-xs text-ink-300 flex items-start gap-2">
                  <Iconify icon="lucide:unplug" size={15} class="text-ink-500" />
                  <div class="flex-1"><p class="font-medium">{connectionState() !== "connected" ? "Reconnecting to the gateway…" : `${activeHost()?.name || "Host"} is offline`}</p><p class="mt-1 text-ink-500">Your draft is kept here. Start the daemon on this host to continue.</p></div>
                  <button onClick={loadHosts} class="text-ink-200 hover:underline cursor-pointer">Retry</button>
                </div>
              </Show>
              {/* Floating menus use the shared portal layer above the composer. */}
              <div class="rounded-2xl border border-line/70 bg-ink-900/80 shadow-xl focus-within:border-ink-500 transition-colors relative">
                {/* Attachment chips (chatbot-style) */}
                <Show when={pendingAttachments().length > 0}>
                  <div class="flex flex-wrap gap-1.5 px-3.5 pt-3">
                    <For each={pendingAttachments()}>
                      {(att) => (
                        <div
                          onClick={() => previewPending(att)}
                          class="relative group flex items-center gap-1.5 bg-ink-950 rounded-lg border border-line/70 pl-1.5 pr-2 py-1 text-xs max-w-[180px] cursor-pointer hover:border-ink-500 transition-colors"
                          data-rc-tip={`${att.name} (${Math.round(att.size / 1024)}KB) — click to preview`}
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
                            data-rc-tip="Remove" aria-label="Remove"
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
                    disabled={creatingSession()}
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
                  data-rc-tip="Clear input" aria-label="Clear input"
                >
                  <Iconify icon="lucide:x" size={13} />
                </button>
              </Show>

              <div class="flex items-end justify-between gap-2 px-3 pb-2.5 pt-1">
                <div class="flex flex-1 min-w-0 flex-wrap items-center gap-0.5 text-xs text-ink-400">
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
                        data-rc-tip="Session files" aria-label="Session files"
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
                                  data-rc-tip={`${f.name} (${Math.round(f.size / 1024)}KB)`} aria-label={`${f.name} (${Math.round(f.size / 1024)}KB)`}
                                >
                                  <FileIcon path={f.name} size={13} />
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
                      data-rc-tip="Add context" aria-label="Add context"
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
                    data-rc-tip="Expand editor" aria-label="Expand editor"
                  >
                    <Iconify icon="lucide:expand" size={13} />
                  </button>
                  <div>
                    <button ref={modeBtn} data-menubtn aria-label="Agent mode and skills" aria-expanded={modeMenuOpen()}
                      onClick={() => { const next = !modeMenuOpen(); closeMenus(); setModeMenuOpen(next); }}
                      class="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs hover:bg-elev cursor-pointer">
                      <Iconify icon={agentMode() === "plan" ? "lucide:list-checks" : agentMode() === "learning" ? "lucide:graduation-cap" : "lucide:hammer"} size={14} />
                      <span class="capitalize">{agentMode()}</span><Show when={selectedSkills().length}><span class="text-ink-500">+{selectedSkills().length}</span></Show>
                      <Iconify icon="lucide:chevron-down" size={11} />
                    </button>
                    <FloatMenu anchor={() => modeBtn} open={modeMenuOpen()} placement="top-start" width="20rem">
                      <p class="px-2 py-1.5 font-medium text-ink-400">Mode</p><Show when={sessionStatus() === "running"}><p class="px-2 pb-2 text-[11px] text-ink-500">Changes apply to the next task.</p></Show>
                      <For each={[{id:"build", label:"Build", description:"Implement and validate changes", icon:"lucide:hammer"}, {id:"plan", label:"Plan", description:"Explore and plan without editing files", icon:"lucide:list-checks"}, {id:"learning", label:"Learning", description:"Learn through hints and guiding questions", icon:"lucide:graduation-cap"}]}>{(mode) =>
                        <button role="menuitemradio" aria-checked={agentMode() === mode.id} onClick={() => { setAgentMode(mode.id); configureSession(); }} class="w-full flex items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-elev cursor-pointer">
                          <Iconify icon={mode.icon} size={16} /><span class="flex-1"><span class="font-medium text-ink-100">{mode.label}</span><span class="block text-[11px] text-ink-500 mt-0.5">{mode.description}</span></span><Show when={agentMode() === mode.id}><Iconify icon="lucide:check" size={14} /></Show>
                        </button>
                      }</For>
                      <div class="mt-1 border-t border-line pt-2"><p class="px-2 pb-1 font-medium text-ink-400">Additional skills</p>
                        <For each={Object.entries(skills()).filter(([,skill]) => skill.enabled)} fallback={<p class="p-2 text-ink-500">Create custom skills in Settings.</p>}>{([name, skill]) =>
                          <button role="menuitemcheckbox" aria-checked={selectedSkills().includes(name)} onClick={() => { setSelectedSkills((prev) => prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]); configureSession(); }} class="w-full rounded-lg px-2 py-2 flex items-center gap-2 text-left hover:bg-elev cursor-pointer">
                            <Iconify icon="lucide:puzzle" size={14} /><span class="flex-1"><span class="text-ink-200">{name}</span><span class="block text-[11px] text-ink-500">{skill.description}</span></span><Show when={selectedSkills().includes(name)}><Iconify icon="lucide:check" size={14} /></Show>
                          </button>
                        }</For>
                      </div>
                    </FloatMenu>
                  </div>
                  <div>
                    <button ref={accessBtn} data-menubtn aria-label="Agent permissions" aria-expanded={accessMenuOpen()}
                      onClick={() => { const next = !accessMenuOpen(); closeMenus(); setAccessMenuOpen(next); }}
                      class="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs hover:bg-elev cursor-pointer">
                      <Iconify icon={yoloMode() ? "lucide:shield-alert" : "lucide:hand"} size={14} /><span class="hidden sm:inline">{yoloMode() ? "Full access" : "Ask for approval"}</span>
                    </button>
                    <FloatMenu anchor={() => accessBtn} open={accessMenuOpen()} placement="top-start" width="22rem">
                      <p class="px-2 py-2 text-ink-400">How should actions be approved?</p>
                      <For each={[{full:false, label:"Ask for approval", description:"Ask before file edits and shell commands.", icon:"lucide:hand"}, {full:true, label:"Full access", description:"Allow edits and commands without asking (YOLO).", icon:"lucide:shield-alert"}]}>{(access) =>
                        <button role="menuitemradio" aria-checked={yoloMode() === access.full} onClick={() => { setYoloMode(access.full); configureSession(); setAccessMenuOpen(false); }} class="w-full flex items-center gap-3 px-2 py-3 text-left rounded-lg hover:bg-elev cursor-pointer">
                          <Iconify icon={access.icon} size={19} /><span class="flex-1"><span class="font-medium text-ink-100">{access.label}</span><span class="block mt-1 text-[11px] text-ink-500">{access.description}</span></span><Show when={yoloMode() === access.full}><Iconify icon="lucide:check" size={14} /></Show>
                        </button>
                      }</For>
                      <Show when={agentMode() !== "build"}><p class="px-2 py-2 text-[11px] text-ink-500">{agentMode() === "plan" ? "Plan" : "Learning"} mode always keeps files read-only.</p></Show>
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
                      data-rc-tip="Switch model" aria-label="Switch model"
                    >
                      <span class="max-w-[120px] sm:max-w-[150px] truncate">{activeModel().split("/").pop() || "Select model"} <span class="capitalize text-ink-500">{effort()}</span></span>
                      <Iconify icon="lucide:chevron-down" size={11} />
                    </button>
                    <FloatMenu anchor={() => modelBtn} open={modelMenuOpen()} placement="top-start" width="32rem">
                      <div>{modelPickerBody()}</div>
                    </FloatMenu>
                    <FloatMenu anchor={() => contextBtn} open={usageOpen()} placement="top-start" width="19rem">
                      <div class="p-1.5 text-xs">
                        <div class="font-semibold text-ink-200 mb-3">Conversation context</div>
                        <div class="text-lg font-medium text-ink-100 tabular-nums">{activeContext().label}</div>
                        <p class="text-[11px] text-ink-500 mt-1 leading-relaxed">
                          {activeContext().window > 0 ? `${compactTokens(activeContext().window)} tokens configured in the gateway.` : "Context limit not configured in the gateway."}
                          {" "}Measured from the latest model request and its response.
                        </p>
                        <Show when={activeContext().percent !== null}>
                          <div class="h-1.5 rounded-full bg-elev overflow-hidden mt-3" role="progressbar" aria-label="Context used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, activeContext().percent ?? 0)}>
                            <div class="h-full rounded-full bg-accent-500" style={{ width: `${Math.min(100, activeContext().percent ?? 0)}%` }} />
                          </div>
                        </Show>
                        <div class="font-semibold text-ink-200 mb-2 mt-4 pt-3 border-t border-line">Session usage</div>
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
                  <Show when={activeSessionId()}>
                  <Tooltip content="Conversation context and session usage">
                    <button ref={contextBtn} data-menubtn aria-label={`Conversation context: ${activeContext().label}`} aria-expanded={usageOpen()}
                      onClick={() => { const next = !usageOpen(); closeMenus(); setUsageOpen(next); }}
                      class="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] tabular-nums text-ink-400 hover:bg-elev hover:text-ink-200 cursor-pointer">
                      <Iconify icon="lucide:chart-pie" size={12} /><span>{activeContext().label}</span>
                    </button>
                  </Tooltip>
                  </Show>
                </div>

                <div class="flex shrink-0 items-center gap-2">
                  <Show when={sessionStatus() === "running"}>
                    <button
                      onClick={cancelCurrentTurn}
                      class="w-7 h-7 rounded-full bg-ink-700 text-ink-100 hover:bg-ink-600 flex items-center justify-center transition-colors cursor-pointer"
                      data-rc-tip="Stop" aria-label="Stop"
                    >
                      <Iconify icon="lucide:square" size={13} />
                    </button>
                  </Show>

                  <button
                    onClick={sendPrompt}
                    disabled={
                      creatingSession() || sessionStatus() === "running" || !activeModel() ||
                      (activeSessionId()
                        ? !inputPrompt().trim() && pendingAttachments().length === 0
                        : (!inputPrompt().trim() && pendingAttachments().length === 0) || !activeProject())
                    }
                    class="w-7 h-7 rounded-full bg-ink-100 text-ink-950 hover:bg-accent-400 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition-all cursor-pointer"
                    data-rc-tip={
                      sessionStatus() === "running"
                        ? "Generating..."
                        : !activeSessionId()
                          ? "Start conversation"
                          : "Send"
                    } aria-label={
                      sessionStatus() === "running"
                        ? "Generating..."
                        : !activeSessionId()
                          ? "Start conversation"
                          : "Send"
                    }
                  >
                    <Show
                      when={sessionStatus() !== "running"}
                      fallback={
                        <span class="w-3.5 h-3.5 border-2 border-ink-950/40 border-t-ink-950 rounded-full animate-spin" />
                      }
                    >
                      <Iconify icon="lucide:arrow-right" size={14} />
                    </Show>
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
        </main>
      </div>
      </Show>

      <Modal open={showNewProjectModal()} onClose={() => setShowNewProjectModal(false)} title="Select project folder" width="max-w-2xl" fullOnMobile>
        <form class="flex items-center gap-2 mb-3" onSubmit={(e) => { e.preventDefault(); requestFolders(newProjectPath()); }}>
          <input aria-label="Folder path on host" class="flex-1 min-w-0 rounded-lg border border-line bg-elev px-3 py-2.5 text-sm font-mono text-ink-100 outline-none focus:border-ink-400" value={newProjectPath()} onInput={(e) => setNewProjectPath(e.currentTarget.value)} />
          <button type="submit" class="p-2 text-ink-400 hover:text-ink-100 cursor-pointer" aria-label="Navigate to folder"><Iconify icon="lucide:arrow-right" size={16} /></button>
          <Btn type="button" disabled={folderLoading() || !folderCurrent() || newProjectPath() !== folderCurrent()} onClick={createProject}>OK</Btn>
        </form>
        <Show when={folderError()}><div role="alert" class="mb-3 p-3 rounded-lg border border-brand-500/30 text-sm text-ink-200">{folderError()}</div></Show>
        <div role="group" aria-label="Host folders" class="h-[50vh] min-h-48 overflow-y-auto -mx-2 space-y-0.5">
          <button disabled={folderLoading() || !folderParent() || folderParent() === folderCurrent()} onClick={() => requestFolders(folderParent())} class="flex w-full items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-ink-300 hover:bg-elev disabled:opacity-40 cursor-pointer"><Iconify icon="lucide:arrow-up" size={17} /><span>..</span></button>
          <Show when={!folderLoading()} fallback={<p class="px-3 py-5 text-sm text-ink-500">Loading folders…</p>}>
            <For each={folderEntries()} fallback={<p class="px-3 py-5 text-sm text-ink-500">No subfolders. Select OK to use this folder.</p>}>{(folder) =>
              <button aria-label={`Open ${folder.name}`} onClick={() => requestFolders(folder.path)} class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-sm text-ink-300 hover:bg-elev focus-visible:bg-elev outline-none cursor-pointer"><Iconify icon="lucide:folder" size={18} /><span class="truncate">{folder.name}</span></button>
            }</For>
          </Show>
        </div>
      </Modal>

      <Modal open={reviewOpen()} onClose={() => setReviewOpen(false)} title="Review task changes" description="Changes captured from the last task. Undo restores their previous contents while preserving later edits." width="max-w-5xl" fullOnMobile
        footer={<><Btn variant="ghost" onClick={() => setReviewOpen(false)}>Close</Btn><Btn disabled={sessionStatus() === "running" || reviewLoading() || !taskReview()?.files.length || !wsOpen()} onClick={() => undoChanges()}>Undo all changes</Btn></>}>
        <Show when={reviewError()}><div role="alert" class="mb-3 rounded-lg border border-brand-500/30 bg-brand-500/5 p-3 text-sm text-ink-200">{reviewError()}</div></Show>
        <Show when={taskReview()?.notice}><p class="mb-3 text-xs text-ink-500">{taskReview()?.notice}</p></Show>
        <Show when={!reviewLoading()} fallback={<p class="p-4 text-sm text-ink-500">Loading changes…</p>}>
          <For each={taskReview()?.files || []} fallback={<p class="p-4 text-sm text-ink-500">No pending file changes from this task.</p>}>{(file) =>
            <details open class="mb-3 rounded-xl border border-line overflow-hidden">
              <summary class="flex items-center gap-2 px-4 py-3 bg-elev/50 text-xs text-ink-200 cursor-pointer"><FileIcon path={file.path} /><span class="flex-1 min-w-0 break-all font-mono">{file.path}</span><span class="text-ink-500 capitalize">{file.kind}</span></summary>
              <Show when={file.truncated}><p class="px-3 py-2 text-xs text-ink-500">Preview truncated. Undo uses the complete backup.</p></Show>
              <Show when={!file.binary} fallback={<p class="p-4 text-xs text-ink-500">Binary file changed.</p>}>
                <div class="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-line">
                  <div class="min-w-0"><p class="px-3 py-2 text-[11px] text-ink-500 border-b border-line">Before</p><CodeBlock text={file.before || ""} language={languageForPath(file.path)} maxH="max-h-96" /></div>
                  <div class="min-w-0"><p class="px-3 py-2 text-[11px] text-ink-500 border-b border-line">After</p><CodeBlock text={file.after || ""} language={languageForPath(file.path)} maxH="max-h-96" /></div>
                </div>
              </Show>
              <div class="flex justify-end border-t border-line px-3 py-2"><button disabled={file.canUndo === false || sessionStatus() === "running" || reviewLoading() || !wsOpen()} onClick={() => undoChanges(file.path)} class="text-xs text-ink-400 hover:text-ink-100 disabled:opacity-40 cursor-pointer">Undo file</button></div>
            </details>
          }</For>
        </Show>
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
                class="px-5 py-2 rounded-xl bg-ink-100 text-ink-950 text-xs font-semibold hover:bg-accent-400 cursor-pointer"
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
                    data-rc-tip="Truncate to reduce tokens" aria-label="Truncate to reduce tokens"
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
                      class="px-3 py-1.5 text-xs font-medium bg-ink-100 text-ink-950 rounded-lg hover:bg-accent-400 cursor-pointer"
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
                    <CodeBlock
                      text={f().text || "(empty)"}
                      language={f().language || languageForPath(f().name)}
                      bare
                      maxH="max-h-none"
                    />
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

      <Modal open={!!confirmState()} title={confirmState()?.title || "Confirm"}
        onClose={() => { confirmState()?.resolve(false); setConfirmState(null); }}
        footer={<>
          <Btn variant="ghost" onClick={() => { confirmState()?.resolve(false); setConfirmState(null); }}>{confirmState()?.cancelText || "Cancel"}</Btn>
          <Btn variant={confirmState()?.danger ? "danger" : "primary"} onClick={() => { confirmState()?.resolve(true); setConfirmState(null); }}>{confirmState()?.confirmText || "Confirm"}</Btn>
        </>}>
        <p class="text-sm text-ink-400 whitespace-pre-line leading-relaxed">{confirmState()?.message}</p>
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
                          data-rc-tip="Copy command" aria-label="Copy command"
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
                          data-rc-tip="Copy URL" aria-label="Copy URL"
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
                class="px-4 py-2 rounded-xl bg-ink-100 text-ink-950 text-xs font-semibold hover:bg-accent-400 cursor-pointer"
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
        description="Appearance and agent preferences for this host."
        footer={<><Btn variant="ghost" onClick={cancelSettings}>Cancel</Btn><Btn onClick={() => {
          if (saveDaemonConfig()) { setShowConfigModal(false); toast("Settings sent to host", "ok"); }
        }}>Save changes</Btn></>}
      >
          <div class="w-full space-y-6">
            <Show when={appNotice()}>{(notice) => <div role={notice().kind === "err" ? "alert" : "status"} class="rounded-xl border border-line bg-elev px-3 py-2.5 text-xs text-ink-300">{notice().message}</div>}</Show>
            <div class="rounded-xl border border-line bg-elev/40 p-4 sm:p-5 space-y-4">
              <h3 class="text-sm font-semibold text-ink-100 flex items-center gap-2">
                <Iconify icon="lucide:palette" size={15} class="text-ink-500" />
                <span>Appearance</span>

              </h3>
              <div class="space-y-3 text-xs">
                <div class="py-2 flex items-center justify-between gap-4">
                  <div>
                    <div class="font-semibold text-ink-200">Theme</div>
                    <div class="text-[11px] text-ink-500 mt-0.5">
                      White or dark interface.
                    </div>
                  </div>
                  <ThemeToggle />
                </div>
                <div class="py-2 flex items-center justify-between gap-4">
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
                    class={`w-10 h-5.5 rounded-full p-0.5 transition-colors shrink-0 cursor-pointer ${verboseChat() ? "bg-accent-500" : "bg-ink-700"}`}
                    style={{ height: "22px" }}
                    role="switch"
                    aria-checked={verboseChat()}
                    aria-label="Verbose agent chat"
                  >
                    <span
                      class={`block w-4 h-4 rounded-full bg-accent-fg transition-transform ${verboseChat() ? "translate-x-[18px]" : "translate-x-0"}`}
                      style={{ height: "16px", width: "16px" }}
                    />
                  </button>
                </div>
                <div class="py-2">
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

            <div class="rounded-xl border border-line bg-elev/40 p-4 sm:p-5 space-y-4">
              <h3 class="text-sm font-semibold text-ink-100 flex items-center gap-2">
                <Iconify icon="lucide:bot" size={15} class="text-ink-500" />
                <span>Agent</span>

              </h3>
              <div class="space-y-4 text-xs">
                <div class="space-y-2">
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

            <div class="rounded-xl border border-line bg-elev/40 p-4 sm:p-5 space-y-4">
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

            <div class="rounded-xl border border-line bg-elev/40 p-4 sm:p-5 space-y-4">
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

            <div class="rounded-xl border border-line bg-elev/40 p-4 sm:p-5 space-y-4">
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
                      class="px-4 py-1.5 rounded-lg bg-accent-500 text-accent-fg font-medium hover:bg-accent-600 cursor-pointer"
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

            <div class="rounded-xl border border-line bg-elev/40 p-4 sm:p-5 space-y-4">
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

          </div>
        </Modal>
    </div>
  );
}
