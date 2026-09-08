import type { RcProject, RcSession } from "./store/sessions";

/**
 * Interfaces
 */

/** Mirrored daemon data comes from the SignalDB layer (RcSession/RcProject). */
export type SessionSummary = RcSession;
export type Project = RcProject;

export interface ContentBlock {
  type: "text" | "tool_call" | "tool_result" | "reasoning" | "image";
  text?: string;
  toolId?: string;
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
  toolProgress?: string;
  toolStartedAt?: number;
  toolDurationMs?: number;
  isError?: boolean;
  reasoning?: string;
  imageMime?: string;
  imageData?: string;
  /** Structured Details forwarded by the daemon (web results, exit codes...). */
  toolDetails?: any;
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

export interface ToolUnit {
  call?: ContentBlock;
  result?: ContentBlock;
}

export type ToolCat = "explore" | "command" | "edit" | "other";

export type MsgPart =
  | { kind: "blocks"; blocks: ContentBlock[] }
  | { kind: "tools"; units: ToolUnit[] }
  | { kind: "thinking"; blocks: ContentBlock[] };

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
