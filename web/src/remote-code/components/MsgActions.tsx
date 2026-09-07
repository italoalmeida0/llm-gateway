import { Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";

/** Botão de ação hover do transcript (classes byte-idênticas às inline
 * que estavam duplicadas em TranscriptView para user/assistant). */
export function MsgIconBtn(props: {
  tip: string;
  icon: string;
  size?: number;
  compact?: boolean;
  danger?: boolean;
  disabled?: boolean;
  copied?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      class={
        props.compact
          ? `p-1 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-900 transition-colors cursor-pointer ${props.danger ? "hover:text-rose-400" : ""}`
          : `p-1.5 rounded-md text-ink-500 hover:text-ink-200 ${props.danger ? "hover:text-rose-400 hover:bg-ink-900" : "hover:bg-elev"} transition-colors cursor-pointer disabled:opacity-40`
      }
      data-rc-tip={props.tip}
      aria-label={props.tip}
    >
      <Iconify icon={props.copied ? "lucide:check" : props.icon} size={props.size ?? (props.compact ? 13 : 14)} />
    </button>
  );
}

export interface MsgActionState {
  forking: boolean;
  canFork: boolean;
  showCopy: boolean;
  copied: boolean;
  onFork: () => void;
  onCopy: () => void;
}

/** Ações hover das bolhas de user (fork/copy/edit/delete). */
export function UserMsgActions(props: MsgActionState & { onEdit: () => void; onDelete: () => void }) {
  return (
    <div class="flex items-center gap-0.5 mt-1 opacity-0 group-hover/msg:opacity-100 transition-opacity">
      <MsgIconBtn tip="Fork conversation from here" icon="lucide:git-branch" disabled={props.forking || !props.canFork} onClick={props.onFork} />
      <Show when={props.showCopy}>
        <MsgIconBtn tip="Copy" icon="lucide:copy" compact copied={props.copied} onClick={props.onCopy} />
      </Show>
      <MsgIconBtn tip="Edit and resend" icon="lucide:pencil" compact onClick={props.onEdit} />
      <MsgIconBtn tip="Delete" icon="lucide:trash-2" compact danger onClick={props.onDelete} />
    </div>
  );
}

/** Ações hover das bolhas de assistant (fork/copy/regenerate). */
export function AssistantMsgActions(props: MsgActionState & { onRegenerate: () => void }) {
  return (
    <div class="flex items-center gap-0.5 mt-1.5 opacity-0 group-hover/msg:opacity-100 transition-opacity">
      <MsgIconBtn tip="Fork conversation from here" icon="lucide:git-branch" disabled={props.forking || !props.canFork} onClick={props.onFork} />
      <Show when={props.showCopy}>
        <MsgIconBtn tip="Copy" icon="lucide:copy" copied={props.copied} onClick={props.onCopy} />
      </Show>
      <MsgIconBtn tip="Regenerate response" icon="lucide:rotate-cw" onClick={props.onRegenerate} />
    </div>
  );
}
