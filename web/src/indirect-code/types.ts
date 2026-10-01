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
  /** Per-bucket cost split (USD), when the daemon knows model pricing.
   * costOutUsd covers the whole output bucket including reasoning. */
  costInUsd?: number;
  costCacheUsd?: number;
  costOutUsd?: number;
}

export interface CompactionUsage {
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  reasoning_tokens_known?: boolean;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd?: number;
}

export interface CompactionState {
  previousSummary?: string;
  readFiles?: string[];
  modifiedFiles?: string[];
  firstKeptEntryId?: string;
  count?: number;
  keepFrom?: number;
  usage?: CompactionUsage;
}

export interface TurnChangedFile {
  path: string;
  rel?: string;
  status: "new" | "modified" | "deleted" | "binary" | "too_large";
  diff?: string;
  additions?: number;
  deletions?: number;
  undone?: boolean;
}

export interface TurnBalloon {
  turnIndex: number;
  files: TurnChangedFile[];
  messageIndex?: number;
  /** True while the turn is still running (floats above the composer). */
  live?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  blocks: ContentBlock[];
  time?: number;
  attachments?: import("./viewTypes").StoredAttachment[];
  thinkingDuration?: number;
  /** Wall-clock duration of the finished turn in ms (daemon-stamped `turn_ms`
   * meta; only present on messages of completed/cancelled turns). */
  turnDurationMs?: number;
  /** True only while this model response is streaming. */
  streaming?: boolean;
  /** True when this message included a completion signal (mark_task_as_complete / mark_plan_as_ready_to_execute). */
  hasCompletion?: boolean;
  /** True when this message included a progress summary signal. */
  hasSummary?: boolean;
  /**
   * Index of the source message in the daemon's raw transcript. Display
   * normalization merges/drops raw messages (tool results are hoisted onto
   * their assistant carrier), so per-message ops (edit/delete/regenerate)
   * must send this index, never the rendered position.
   */
  srcIdx?: number;
  /** Explicit turn boundary markers (future-proofs mid-turn messages). */
  isTurnStart?: boolean;
  midTurn?: boolean;
  turnIndex?: number;
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

export interface SkillConfig {
  name: string;
  description: string;
  body: string;
  enabled: boolean;
}

export interface ToolUnit {
  id?: string;
  call?: ContentBlock;
  result?: ContentBlock;
}

export type ToolCat = "explore" | "command" | "edit" | "other";

/** One ordered row inside a tool/thinking aggregate: thinking, image and
 * tool runs render in event order. Text messages separate as distinct single blocks. */
export type TurnEntry = { id?: string } & (
  | { kind: "thinking"; msg: ChatMessage; block: ContentBlock; /** stored newest-first index (0 = newest/live) */ nth: number; isNewest: boolean }
  | { kind: "image"; msg: ChatMessage; block: ContentBlock }
  | { kind: "tools"; msg: ChatMessage; units: ToolUnit[] });

/**
 * Display-only turn aggregate. Contiguous tool executions and thinkings
 * form a series aggregate block, while visible text messages (summaries,
 * completions, or normal messages) render as distinct single bubbles.
 */
export type RenderBlockKind = "single" | "series";

export interface RenderBlockBase {
  kind: RenderBlockKind;
  id?: string;
}

export interface RenderBlockSingle extends RenderBlockBase {
  kind: "single";
  msg: ChatMessage;
}

export interface RenderBlockSeries extends RenderBlockBase {
  kind: "series";
  /** Lead message (first of the tool group). */
  msg: ChatMessage;
  /** Fused-in following messages of the same tool group. */
  extras: ChatMessage[];
  /** Every ToolUnit of this tool group, in display order. */
  units: ToolUnit[];
  /** Ordered aggregate rows (thinkings, images, tool runs). */
  entries: TurnEntry[];
  /** Associated message text delivered for this balloon (if any). */
  textMsg?: ChatMessage;
  finalMsgId?: null;
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
