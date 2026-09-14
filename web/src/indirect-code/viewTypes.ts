/** Local view types for the RemoteCode page (ephemeral state, non-wire). */

export interface TurnActivity {
  startedAt: number;
  endedAt?: number;
  status: "running" | "cancelling" | "cancelled" | "completed" | "failed";
}

export interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface PendingAttachment {
  key: string;
  name: string;
  mime: string;
  size: number;
  dataB64: string;
  objectUrl?: string;
  /** Browser-extracted markdown/text for pdf/office/plain files. */
  text?: string;
  loading?: boolean;
  serverId?: string;
  serverSessionId?: string;
  uploading?: boolean;
  uploadKey?: string;
}

export interface SearchHit {
  sessionId: string;
  title: string;
  cwd: string;
  updatedAt: number;
  snippet: string;
  matchCount: number;
}

export interface StoredAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** One waiting user message (daemon session queue). */
export interface QueuedMessage {
  id: string;
  text: string;
  attachmentIds: string[];
  model: string;
  yolo: boolean;
  createdAt: number;
}

export interface WorkspaceStatus {
  path: string;
  status: "available" | "missing" | "unavailable";
}

export interface ChoiceOption {
  id: string;
  label: string;
  hint?: string;
  primary?: boolean;
}

export interface ConfirmState {
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  danger: boolean;
  resolve: (v: boolean) => void;
}
