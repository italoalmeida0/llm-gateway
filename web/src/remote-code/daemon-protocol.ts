import type { MCPServerConfig, SkillConfig } from "./types";
import type { SessionContext } from "./context";
import type { TodoItem } from "./viewTypes";

/** Protocolo tipado do daemon (fronteira WebSocket).
 *
 * Sem dependências de validação (deps mínimas): os envelopes de saída são
 * verificados pelo tsc nos call sites (`send` só aceita `DaemonCommand`) e
 * os de entrada estreitam no dispatcher (`switch` sobre `DaemonEvent`).
 * Os interiores (registos Go: session/attachment/review) ficam
 * intencionalmente soltos (`WireRecord`) — a fonte de verdade mora no
 * daemon. `parseDaemonMessage` é o único sítio que toca `JSON.parse`.
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
    | {
        type: "update_config";
        requestId: string;
        // Chaves Go (snake_case): tradução das chaves UI em useSettings.
      settings: Record<string, unknown>;
      mcpServers: Record<string, MCPServerConfig>;
      skills: Record<string, SkillConfig>;
    }
  );

/** Interior bruto vindo do daemon (registos Go: session/attachment/review).
 * Intencionalmente `any`: a fonte de verdade mora no daemon e estes
 * objetos já eram `any` em todos os handlers. O rigor vive nos envelopes
 * (comandos/eventos), verificados pelo tsc. */
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
    | { type: "session_content"; sessionId?: string; messages?: unknown[] }
    | { type: "session_status"; sessionId?: string; status?: string; turn?: WireRecord }
    | { type: "session_cleared"; sessionId?: string }
    | { type: "session_compacted"; sessionId?: string; context?: SessionContext; messages?: unknown[]; auto?: boolean }
    | { type: "workspace_status"; requestId?: string; workspace?: WireRecord }
    | { type: "question_request"; sessionId?: string; question?: WireRecord }
    | { type: "question_resolved"; sessionId?: string; questionId: string }
    | { type: "question_error"; sessionId?: string; questionId: string; message?: string }
    | { type: "tool_approval_request"; sessionId?: string; callId: string; tool: string; args: unknown }
    | { type: "agent_event"; sessionId?: string; event?: AgentEvent }
    | { type: "error"; requestId?: string; sessionId?: string; message?: string; replyTo?: string }
  );

/** Resposta de pull do sync (sem `type`: resolvida por id numérico). */
export interface PullWireMessage {
  type?: undefined;
  id: number;
  hostId: string;
  items?: unknown[];
  error?: string;
}

export type DaemonMessage = DaemonEvent | PullWireMessage;

/** Comando pull do sync (único com `id` obrigatório na ida). */
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

/** Fronteira de entrada: objeto com envelope reconhecível ou null. */
export function parseDaemonMessage(data: unknown): DaemonMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (typeof m.type === "string" || typeof m.id === "number") return data as DaemonMessage;
  return null;
}
