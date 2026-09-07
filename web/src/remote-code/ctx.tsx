import { createContext, useContext, type JSX } from "solid-js";
import type { ChatMessage, Project, SessionSummary } from "./types";
import type { WorkspaceStatus } from "./viewTypes";
import type { Hosts } from "./hooks/useHosts";
import type { Relay } from "./hooks/useRelay";
import type { Mirror } from "./hooks/useMirror";
import type { Transcript } from "./hooks/useTranscript";
import type { SessionOptions } from "./hooks/useSessionOptions";
import type { Composer } from "./hooks/useComposer";
import type { Projects } from "./hooks/useProjects";
import type { Workspace } from "./hooks/useWorkspace";
import type { Modals } from "./hooks/useModals";
import type { ReviewDomain } from "./hooks/useReview";
import type { Settings } from "./hooks/useSettings";
import type { Notice } from "./hooks/useNotice";
import { contextDisplay, type GatewayModel } from "./context";

/** Solid contexts for Remote Code — replace the god-object
 * RemoteCodeViewCtx (260 fields) with 6 cohesive slices. Each component
 * consumes only what it needs; the page assembles values from hooks. */

export interface HostCtxValue extends Hosts {
  connectionState: Relay["connectionState"];
  wsOpen: () => boolean;
}

export interface SessionCtxValue extends Projects {
  sessions: Mirror["sessions"];
  projects: Mirror["projects"];
  activeSession: () => SessionSummary | null;
  currentProject: () => Project | null | undefined;
  activeSessionId: () => string;
  draftMode: () => boolean;
  creatingSession: () => boolean;
  selectSession: (id: string) => void;
  startNewConversation: (projectId?: string) => void;
  deleteSession: (id: string, e?: MouseEvent) => void;
  newestSessionProjectId: () => string;
  workspace: Workspace["workspace"];
  workspaceBlocked: Workspace["workspaceBlocked"];
  workspacePath: Workspace["workspacePath"];
  workspaceState: Workspace["workspaceState"];
  checkWorkspace: Workspace["checkWorkspace"];
  newProjBtn: HTMLButtonElement | undefined;
  projBtn: HTMLButtonElement | undefined;
}

export interface TranscriptCtxValue
  extends Omit<Transcript, "saveEditMsg" | "regenerateMsg"> {
  saveEditMsg: (idx: number, m: ChatMessage) => Promise<void>;
  regenerateMsg: (idx: number) => Promise<void>;
}

export interface ComposerCtxValue extends Composer {
  activeModel: SessionOptions["activeModel"];
  effort: SessionOptions["effort"];
  agentMode: SessionOptions["agentMode"];
  setAgentMode: SessionOptions["setAgentMode"];
  selectedSkills: SessionOptions["selectedSkills"];
  setSelectedSkills: SessionOptions["setSelectedSkills"];
  yoloMode: SessionOptions["yoloMode"];
  setYoloMode: SessionOptions["setYoloMode"];
  modeMenuOpen: SessionOptions["modeMenuOpen"];
  setModeMenuOpen: SessionOptions["setModeMenuOpen"];
  accessMenuOpen: SessionOptions["accessMenuOpen"];
  setAccessMenuOpen: SessionOptions["setAccessMenuOpen"];
  modeBtn: SessionOptions["modeBtn"];
  accessBtn: SessionOptions["accessBtn"];
  configureSession: SessionOptions["configureSession"];
  modelPickerBody: () => JSX.Element;
  activeContext: () => ReturnType<typeof contextDisplay>;
  addBtn: HTMLButtonElement | undefined;
  filesBtn: HTMLButtonElement | undefined;
  modelBtn: HTMLButtonElement | undefined;
}

export interface ModalCtxValue extends Modals, ReviewDomain, Settings {}

export interface UICtxValue extends Notice {
  sidebarOpen: () => boolean;
  setSidebarOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  isMobile: () => boolean;
  historyView: () => boolean;
  setHistoryView: (v: boolean | ((p: boolean) => boolean)) => void;
  closeSidebarOnMobile: () => void;
  closeMenus: () => void;
  verboseChat: () => boolean;
  setVerboseChat: (v: boolean) => void;
  convWidth: () => "narrow" | "default" | "wide";
  setConvWidth: (v: "narrow" | "default" | "wide") => void;
  convWidthClass: () => string;
  modelMenuOpen: () => boolean;
  setModelMenuOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  usageOpen: () => boolean;
  setUsageOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  contextBtn: HTMLButtonElement | undefined;
}

function defineCtx<T>() {
  const Ctx = createContext<T>();
  const use = (): T => {
    const v = useContext(Ctx);
    if (!v) throw new Error("RemoteCode context used outside provider");
    return v;
  };
  return [Ctx, use] as const;
}

export const [HostCtx, useHost] = defineCtx<HostCtxValue>();
export const [SessionCtx, useSession] = defineCtx<SessionCtxValue>();
export const [TranscriptCtx, useTranscriptCtx] = defineCtx<TranscriptCtxValue>();
export const [ComposerCtx, useComposerCtx] = defineCtx<ComposerCtxValue>();
export const [ModalCtx, useModal] = defineCtx<ModalCtxValue>();
export const [UICtx, useUI] = defineCtx<UICtxValue>();

export interface RemoteCodeProviderValue {
  host: HostCtxValue;
  session: SessionCtxValue;
  transcript: TranscriptCtxValue;
  composer: ComposerCtxValue;
  modal: ModalCtxValue;
  ui: UICtxValue;
}

/** Single provider mounted by the page (values come from domain hooks). */
export function RemoteCodeProvider(props: RemoteCodeProviderValue & { children: JSX.Element }) {
  return (
    <HostCtx.Provider value={props.host}>
      <SessionCtx.Provider value={props.session}>
        <TranscriptCtx.Provider value={props.transcript}>
          <ComposerCtx.Provider value={props.composer}>
            <ModalCtx.Provider value={props.modal}>
              <UICtx.Provider value={props.ui}>{props.children}</UICtx.Provider>
            </ModalCtx.Provider>
          </ComposerCtx.Provider>
        </TranscriptCtx.Provider>
      </SessionCtx.Provider>
    </HostCtx.Provider>
  );
}

// Re-export of types used in signatures above (avoids scattered imports).
export type { GatewayModel, SessionSummary, Project, WorkspaceStatus };
