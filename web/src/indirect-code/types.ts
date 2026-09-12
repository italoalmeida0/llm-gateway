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
  at?: number;
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
  attachments?: string[];
  thinkingDuration?: number;
  /** True when this message included a completion signal (mark_task_as_complete / mark_plan_as_ready_to_execute). */
  hasCompletion?: boolean;
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

/** One ordered row inside a turn aggregate: thinking/text/image entries
 * render as tool-style rows, tool runs render as tool rows. Entries follow
 * message (wire) order; within a message, thinkings come first (they caused
 * what follows) then the remaining blocks in stored order. */
export type TurnEntry =
  | { kind: "thinking"; msg: ChatMessage; block: ContentBlock; /** stored newest-first index (0 = newest/live) */ nth: number; isNewest: boolean }
  | { kind: "text"; msg: ChatMessage; block: ContentBlock; /** text-block index within its message */ nth: number; /** fuzzy-duplicate of a later entry: display:none, last wins */ hidden?: boolean }
  | { kind: "image"; msg: ChatMessage; block: ContentBlock }
  | { kind: "tools"; msg: ChatMessage; units: ToolUnit[] };

/**
 * Display-only turn aggregate. The renderer calls this with
 * the rendered message array; every assistant message of a turn with tool
 * activity or thinking fuses into one "series" block that renders as a
 * single aggregate card — thinkings, texts and tool runs in event order —
 * with the featured final message below once the turn ends.
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
  /** Lead message (first of the turn). */
  msg: ChatMessage;
  /** Fused-in following messages of the same turn. */
  extras: ChatMessage[];
  /** Every ToolUnit of the whole turn, in display order. */
  units: ToolUnit[];
  /** Ordered aggregate rows (thinkings, texts, images, tool runs). */
  entries: TurnEntry[];
  /** Id of the turn's featured final message (long text with no tools or
   * alongside a completion signal): rendered below the card once idle, and
   * display:none inside the card so DOM identity stays stable. */
  finalMsgId: string | null;
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
