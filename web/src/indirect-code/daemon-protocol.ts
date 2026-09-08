import type { MCPServerConfig, SkillConfig } from "./types";
import type { SessionContext } from "./context";
import type { TodoItem } from "./viewTypes";

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
    | { type: "ping"; ts: number }
  | { type: "get_session"; sessionId: string; requestId?: string }
  | { type: "pull"; collection: string }
  | { type: "configure_session"; sessionId: string; model: string; options: Omit<SessionChoice, "model"> }
  | { type: "prompt"; sessionId: string; text: string; model: string; yolo: boolean; options: Omit<SessionChoice, "model">; attachmentIds: string[] }
  | { type: "cancel"; sessionId: string }
  | { type: "fork_session"; sessionId: string; index: number; requestId?: string; editText?: string; editModel?: string; editYolo?: boolean }
  | { type: "regenerate"; sessionId: string; index: number; model: string; yolo: boolean }
  | { type: "edit_message"; sessionId: string; index: number; text: string; model: string; yolo: boolean; regenerate: boolean }
  | { type: "delete_message"; sessionId: string; index: number }
  | { type: "create_session"; requestId: string; cwd: string; title: string; model: string; options: Omit<SessionChoice, "model"> }
  | { type: "delete_session"; sessionId: string }
  | { type: "rename_session"; sessionId: string; title: string }
  | { type: "toggle_pin"; sessionId: string }
  | { type: "create_project"; path: string; requestId: string }
  | { type: "delete_project"; projectId: string }
  | { type: "browse_folders"; path: string; requestId: string }
  | { type: "get_changes"; sessionId: string; detail: boolean; requestId: string }
  | { type: "keep_changes"; sessionId: string; reviewId: string; requestId: string }
  | { type: "undo_changes"; sessionId: string; reviewId: string; path: string; detail: boolean; requestId: string }
  | { type: "upload_attachment"; requestId: string; sessionId: string; name: string; mime: string; data: string; text?: string }
  | { type: "get_attachment"; sessionId: string; attachmentId: string }
  | { type: "search"; query: string; limit: number }
  | { type: "check_workspace"; requestId: string; sessionId: string; projectId?: string }
  | { type: "question_response"; sessionId: string; questionId: string; answers: string[][] }
  | { type: "tool_approval_response"; sessionId: string; callId: string; approved: boolean; always: boolean }
  | { type: "set_draft"; sessionId: string; draft: string }
  | { type: "set_todos_open"; sessionId: string; open: boolean }
  | { type: "set_editing_msg"; sessionId: string; index: number | null; text: string }
  | { type: "set_project_collapsed"; projectId: string; collapsed: boolean }
    | {
        type: "update_config";
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

export type AgentEvent =
  | { type: "turn_start" }
  | { type: "todo_update"; items?: TodoItem[] }
  | { type: "assistant_message"; index?: number; message?: WireRecord }
  | { type: "assistant_start" }
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta?: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_args"; id: string; delta: string }
  | { type: "tool_use_end"; id: string }
  | { type: "tool_execution_start"; id: string; startedAt: number }
  | { type: "tool_progress"; id: string; text?: string }
  | { type: "tool_call"; id: string; name: string; args?: unknown }
  | { type: "tool_result"; id: string; result?: string; content?: string; isError?: boolean; startedAt?: number; durationMs?: number }
  | { type: "usage"; usage?: unknown; cumulative?: unknown; context?: SessionContext }
  | { type: "compact_progress"; text?: string }
  | { type: "turn_end"; usage?: unknown; cumulative?: unknown; cancelled?: boolean; stop?: string; error?: string }
  | { type: "done" }
  | { type: "error"; message?: string };

export type DaemonEvent = EventBase &
  (
    | { type: "relay_connected" }
    | { type: "host_status"; status?: string }
    | { type: "change"; collection: string }
    | { type: "session_forked"; requestId?: string; session?: WireRecord; resent?: boolean }
    | { type: "session_created"; requestId?: string; session?: WireRecord }
    | { type: "project_created"; requestId?: string; project?: WireRecord }
    | { type: "folders"; requestId?: string; error?: string; folders?: WireRecord[]; parent?: string; path?: string }
    | { type: "session_changes"; sessionId: string; requestId?: string; error?: string; detail?: boolean; review?: WireRecord }
    | { type: "changes_updated"; sessionId: string }
    | { type: "attachment_uploaded"; requestId?: string; sessionId?: string; attachment?: WireRecord }
    | { type: "search_results"; query?: string; results?: WireRecord[] }
    | { type: "notice"; message?: string }
    | { type: "attachment_data"; sessionId: string; attachment?: WireRecord }
    | { type: "session_data"; requestId?: string; sessionId?: string; session?: WireRecord }
    | { type: "session_truncated"; sessionId?: string; keepIndex?: number }
    | { type: "session_content"; sessionId?: string; messages?: unknown[]; compaction?: unknown }
    | { type: "session_status"; sessionId?: string; status?: string; turn?: WireRecord }
    | { type: "session_cleared"; sessionId?: string }
    | { type: "session_compacted"; sessionId?: string; context?: SessionContext; messages?: unknown[]; auto?: boolean; compaction?: unknown; usage?: unknown }
    | { type: "workspace_status"; requestId?: string; workspace?: WireRecord }
    | { type: "question_request"; sessionId?: string; question?: WireRecord }
    | { type: "question_resolved"; sessionId?: string; questionId: string }
    | { type: "question_error"; sessionId?: string; questionId: string; message?: string }
    | { type: "tool_approval_request"; sessionId?: string; callId: string; tool: string; args: unknown }
    | { type: "agent_event"; sessionId?: string; event?: AgentEvent }
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
export type SessionChangesEvent = Extract<DaemonEvent, { type: "session_changes" }>;
export type AttachmentDataEvent = Extract<DaemonEvent, { type: "attachment_data" }>;
export type ChangesUpdatedEvent = Extract<DaemonEvent, { type: "changes_updated" }>;
export type WorkspaceStatusEvent = Extract<DaemonEvent, { type: "workspace_status" }>;

/** Inbound boundary: object with recognizable envelope or null. */
export function parseDaemonMessage(data: unknown): DaemonMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (typeof m.type === "string" || typeof m.id === "number") return data as DaemonMessage;
  return null;
}
