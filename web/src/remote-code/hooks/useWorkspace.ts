import type { DaemonCommand } from "../daemon-protocol";
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { WorkspaceStatus } from "../viewTypes";
import type { WorkspaceStatusEvent } from "../daemon-protocol";

/** Estado do workspace remoto + poll (extraído de RemoteCodePage verbatim). */
export function createWorkspace(opts: {
  send: (payload: DaemonCommand) => void;
  isOpen: () => boolean;
  getSessionId: () => string;
  getSessionCwd: () => string;
  getProjectPath: () => string;
  getProjectId: () => string | undefined;
  getFolderStatus: () => WorkspaceStatus["status"] | undefined;
  getHostId: () => string;
  isConnected: () => boolean;
}) {
  const [workspace, setWorkspace] = createSignal<WorkspaceStatus | null>(null);
  const workspacePath = createMemo(() => opts.getSessionId() ? opts.getSessionCwd() : opts.getProjectPath());
  const workspaceState = () => workspace()?.path === workspacePath() ? workspace()?.status : opts.getFolderStatus();
  const workspaceBlocked = () => workspaceState() === "missing" || workspaceState() === "unavailable";
  let workspaceRequest = "";
  function checkWorkspace() {
    if (!opts.isOpen() || !workspacePath()) return;
    workspaceRequest = crypto.randomUUID();
    opts.send({ type: "check_workspace", requestId: workspaceRequest, sessionId: opts.getSessionId(), projectId: opts.getProjectId() });
  }
  function noteWorkspaceStatus(msg: WorkspaceStatusEvent) {
    if (msg.requestId === workspaceRequest && msg.workspace?.path === workspacePath()) setWorkspace(msg.workspace);
  }
  createEffect(() => {
    workspacePath(); opts.getHostId(); opts.isConnected();
    setWorkspace(null);
    untrack(checkWorkspace);
    const timer = setInterval(checkWorkspace, 15000);
    const focus = () => checkWorkspace();
    window.addEventListener("focus", focus);
    onCleanup(() => { clearInterval(timer); window.removeEventListener("focus", focus); });
  });

  return { workspace, setWorkspace, workspacePath, workspaceState, workspaceBlocked, checkWorkspace, noteWorkspaceStatus };
}

export type Workspace = ReturnType<typeof createWorkspace>;
