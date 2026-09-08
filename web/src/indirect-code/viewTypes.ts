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

export interface ReviewFile {
  state?: "exists" | "deleted" | "unavailable";
  canUndo?: boolean;
  truncated?: boolean;
  path: string;
  kind: string;
  diff?: string;
  binary?: boolean;
  added?: number;
  removed?: number;
}

export interface Review {
  checkedAt?: number;
  id: string;
  files: ReviewFile[];
  notice?: string;
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
  loadError?: string;
  serverId?: string;
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
