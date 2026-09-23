import type { MCPServerConfig, SkillConfig } from "./types";
import type { SessionContext } from "./context";
import type { QueuedMessage, TodoItem } from "./viewTypes";

/** Typed daemon protocol (WebSocket boundary).
 *
 * No validation dependencies (minimal deps): outbound envelopes are
 * verified by tsc at call sites (`send` only accepts `DaemonCommand`) and
 * inbound envelopes narrow in the dispatcher (`switch` over `DaemonEvent`).
 * Payloads (Go records: session/attachment/review) are intentionally
 * loose (`WireRecord`) — the single source of truth lives in the
 * daemon. `parseDaemonMessage` is the only place touching `JSON.parse`.
 */

export interface CommandBase {
  hostId?: string;
  requestId?: string;
  sessionId?: string;
  /** Sync-protocol id (pull request/response correlation). */
  id?: number;
}

export interface SessionChoice {
  model: string;
  effort: string;
  mode: string;
  skills: string[];
  access: string;
}

export type DaemonCommand = CommandBase &
  (
  | { type: "get_session"; sessionId: string; requestId?: string }
  | { type: "get_history"; sessionId: string; beforeTurn: number }
  | { type: "pull"; collection: string }
  | { type: "configure_session"; sessionId: string; model: string; options: Omit<SessionChoice, "model"> }
  | { type: "prompt"; sessionId: string; text: string; model: string; yolo: boolean; options: Omit<SessionChoice, "model">; attachmentIds: string[] }
  | { type: "queue_add"; sessionId: string; text: string; model: string; yolo: boolean; attachmentIds: string[] }
  | { type: "queue_update"; sessionId: string; queueId: string; text: string; attachmentIds: string[] }
  | { type: "queue_remove"; sessionId: string; queueId: string }
  | { type: "queue_send_now"; sessionId: string; queueId: string }
  | { type: "cancel"; sessionId: string }
  | { type: "bg_list" }
  | { type: "bg_cancel"; jobId: string }
  | { type: "bg_tail"; jobId: string }
  | { type: "fork_session"; sessionId: string; index: number; requestId?: string; editText?: string; editModel?: string; editYolo?: boolean; attachmentIds?: string[] }
  | { type: "regenerate"; sessionId: string; index: number; text?: string; model: string; yolo: boolean }
  | { type: "edit_message"; sessionId: string; index: number; text: string; model: string; yolo: boolean; regenerate: boolean; attachmentIds?: string[] }
  | { type: "create_session"; requestId: string; cwd: string; title: string; model: string; options: Omit<SessionChoice, "model"> }
  | { type: "delete_session"; sessionId: string }
  | { type: "rename_session"; sessionId: string; title: string }
  | { type: "toggle_pin"; sessionId: string }
  | { type: "create_project"; path: string; requestId: string }
  | { type: "delete_project"; projectId: string }
  | { type: "test_mcp"; requestId: string; expectedRevision?: string; name: string; server: MCPServerConfig }
  | { type: "browse_folders"; path: string; requestId: string }
  | { type: "upload_attachment"; requestId: string; sessionId: string; name: string; mime: string; data: string; text?: string }
  | { type: "search_files"; requestId: string; sessionId: string; projectId: string; query: string }
  | { type: "get_attachment"; sessionId: string; attachmentId: string }
  | { type: "search"; query: string; limit: number }
  | { type: "check_workspace"; requestId: string; sessionId: string; projectId?: string }
  | { type: "question_response"; sessionId: string; questionId: string; answers: string[][] }
  | { type: "convert_response"; sessionId: string; requestId: string; text?: string; error?: string }
  | { type: "tool_approval_response"; sessionId: string; callId: string; approved: boolean; always: boolean }
  | { type: "set_todos_open"; sessionId: string; open: boolean }
  | { type: "set_project_collapsed"; projectId: string; collapsed: boolean }
  | { type: "get_turn_changes"; sessionId: string; requestId?: string }
  | { type: "daemon_update_check" }
  | { type: "daemon_update_apply" }
  | { type: "daemon_update_toggle"; enabled: boolean }
  | { type: "undo_turn_changes"; sessionId: string; turnIndex: number; path?: string; requestId?: string }
    | {
        type: "update_config";
        expectedRevision?: string;
        requestId: string;
        // Go keys (snake_case): translation of UI keys in useSettings.
      settings: Record<string, unknown>;
      mcpServers: Record<string, MCPServerConfig>;
      skills: Record<string, SkillConfig>;
    }
  );

/** Raw payload from daemon (Go records: session/attachment/review).
 * Intentionally `any`: the source of truth lives in the daemon and these
 * objects were already `any` across all handlers. Strictness lives in envelopes
 * (commands/events), checked by tsc. */
export type WireRecord = any;

interface EventBase {
  hostId?: string;
}

export type AgentEvent = { turnIndex?: number } & (
  | { type: "turn_start" }
  | { type: "todo_update"; items?: TodoItem[] }
  | { type: "user_message"; index: number; message: WireRecord }
  | { type: "assistant_message"; index?: number; message?: WireRecord }
  | { type: "assistant_start"; index?: number }
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta?: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_args"; id: string; delta: string }
  | { type: "tool_use_end"; id: string }
  | { type: "tool_execution_start"; id: string; startedAt: number }
  | { type: "tool_progress"; id: string; text?: string }
  | { type: "tool_call"; id: string; name: string; args?: unknown }
  | { type: "tool_result"; id: string; result?: string; content?: string; isError?: boolean; startedAt?: number; durationMs?: number; details?: any }
  | { type: "usage"; usage?: unknown; cumulative?: unknown; context?: SessionContext }
  | { type: "compact_progress"; text?: string }
  | { type: "turn_end"; usage?: unknown; cumulative?: unknown; cancelled?: boolean; stop?: string; error?: string }
  | { type: "turn_file_changes"; sessionId?: string; live?: boolean; balloon?: WireRecord }
  | { type: "done" }
  | { type: "retry"; index?: number; attempt?: number; delayMs?: number; error?: string }
  | { type: "error"; message?: string });

export interface BgJobWire {
  id: string;
  kind: "bash" | "python" | string;
  sessionId: string;
  label: string;
  status: "running" | "done" | "error" | "cancelled" | string;
  startedAt: number;
  endedAt?: number;
  result?: string;
  /** Absolute path of the task's .log file (brain scratch space). */
  logPath?: string;
}

export type DaemonEvent = EventBase &
  (
    | { type: "relay_connected" }
    | { type: "host_status"; status?: string }
    | { type: "change"; collection: string }
    | { type: "config_updated"; requestId?: string; success?: boolean; error?: string; revision?: string }
    | { type: "mcp_status"; requestId?: string; sessionId?: string; name: string; status: string; toolCount?: number; message?: string }
    | { type: "session_forked"; requestId?: string; session?: WireRecord; resent?: boolean }
    | { type: "session_created"; requestId?: string; session?: WireRecord }
    | { type: "project_created"; requestId?: string; project?: WireRecord }
    | { type: "folders"; requestId?: string; error?: string; folders?: WireRecord[]; parent?: string; path?: string }
    | { type: "turn_file_changes"; sessionId: string; live?: boolean; balloon?: WireRecord }
    | { type: "turn_changes"; sessionId: string; requestId?: string; balloons?: WireRecord[]; live?: WireRecord }
    | { type: "turn_changes_undone"; sessionId: string; requestId?: string; turnIndex?: number; results?: WireRecord[]; complete?: boolean; warning?: string; error?: string }
    | { type: "attachment_uploaded"; requestId?: string; sessionId?: string; attachment?: WireRecord }
    | { type: "search_results"; query?: string; results?: WireRecord[] }
    | { type: "notice"; message?: string }
    | { type: "file_matches"; requestId: string; sessionId?: string; files?: string[]; error?: string; truncated?: boolean }
    | { type: "attachment_data"; requestId?: string; sessionId: string; attachment?: WireRecord }
    | { type: "session_data"; requestId?: string; sessionId?: string; session?: WireRecord }
    | { type: "session_truncated"; sessionId?: string; keepIndex?: number }
    | { type: "session_content"; sessionId?: string; messages?: unknown[]; compaction?: unknown }
    | { type: "session_status"; sessionId?: string; status?: string; turn?: WireRecord }
    | { type: "daemon_update"; current?: string; available?: string; staged?: string; checkedAt?: number; autoUpdate?: boolean; mismatchWant?: string; mismatchGot?: string; mismatchAt?: number; error?: string }
    | { type: "update_failed"; reason?: string }
    | { type: "update_done"; version?: string }
    | { type: "session_compacted"; sessionId?: string; context?: SessionContext; messages?: unknown[]; auto?: boolean; compaction?: unknown; usage?: unknown }
    | { type: "workspace_status"; requestId?: string; workspace?: WireRecord }
    | { type: "question_request"; sessionId?: string; question?: WireRecord }
    | { type: "question_resolved"; sessionId?: string; questionId: string }
    | { type: "question_error"; sessionId?: string; questionId: string; message?: string }
    | { type: "tool_approval_request"; sessionId?: string; callId: string; tool: string; args: unknown }
    | { type: "convert_request"; sessionId?: string; requestId: string; filename: string; data: string }
    | { type: "convert_resolved"; sessionId?: string; requestId: string }
    | { type: "session_queue"; sessionId?: string; queue: QueuedMessage[] }
    | { type: "agent_event"; sessionId?: string; event?: AgentEvent }
    | { type: "bg_update"; jobs?: BgJobWire[] }
    | { type: "bg_list"; jobs?: BgJobWire[] }
    | { type: "bg_output"; jobId?: string; sessionId?: string; text?: string }
    | { type: "bg_tail"; jobId?: string; text?: string; truncated?: boolean }
    | { type: "error"; requestId?: string; sessionId?: string; message?: string; replyTo?: string }
  );

/** Sync pull response (no `type`: resolved via numeric id). */
export interface PullWireMessage {
  type?: undefined;
  id: number;
  hostId: string;
  items?: unknown[];
  error?: string;
}

export type DaemonMessage = DaemonEvent | PullWireMessage;

/** Sync pull command (the only one with mandatory outbound `id`). */
export type PullCommand = Extract<DaemonCommand, { type: "pull" }>;
export type SessionStatusEvent = Extract<DaemonEvent, { type: "session_status" }>;
export type ToolApprovalRequestEvent = Extract<DaemonEvent, { type: "tool_approval_request" }>;
export type ProjectCreatedEvent = Extract<DaemonEvent, { type: "project_created" }>;
export type FoldersEvent = Extract<DaemonEvent, { type: "folders" }>;
export type SearchResultsEvent = Extract<DaemonEvent, { type: "search_results" }>;
export type AttachmentDataEvent = Extract<DaemonEvent, { type: "attachment_data" }>;
export type WorkspaceStatusEvent = Extract<DaemonEvent, { type: "workspace_status" }>;

/** Inbound boundary: object with recognizable envelope or null. */
export function parseDaemonMessage(data: unknown): DaemonMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (typeof m.type === "string" || typeof m.id === "number") return data as DaemonMessage;
  return null;
}
