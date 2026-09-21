import { Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";

/** Shared transcript action button with mouse, keyboard and touch targets. */
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
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      class={
        props.compact
          ? `rc-msg-action p-1 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-900 transition-colors cursor-pointer ${props.danger ? "hover:text-rose-400" : ""}`
          : `rc-msg-action p-1.5 rounded-md text-ink-500 hover:text-ink-200 ${props.danger ? "hover:text-rose-400 hover:bg-ink-900" : "hover:bg-elev"} transition-colors cursor-pointer disabled:opacity-40`
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

/** Hover actions for user bubbles (fork/copy/edit). */
export function UserMsgActions(props: MsgActionState & { onEdit: () => void }) {
  return (
    <div class="rc-message-actions flex items-center gap-0.5 mt-1 transition-opacity">
      <MsgIconBtn tip="Fork conversation from here" icon="lucide:git-branch" disabled={props.forking || !props.canFork} onClick={props.onFork} />
      <Show when={props.showCopy}>
        <MsgIconBtn tip="Copy" icon="lucide:copy" compact copied={props.copied} onClick={props.onCopy} />
      </Show>
      <MsgIconBtn tip="Edit and resend" icon="lucide:pencil" compact onClick={props.onEdit} />
    </div>
  );
}

/** Hover actions for assistant bubbles (fork/copy/regenerate). */
export function AssistantMsgActions(props: MsgActionState & { onRegenerate: () => void; duration?: string }) {
  return (
    <div class="rc-message-actions flex items-center gap-0.5 mt-1.5 transition-opacity">
      <MsgIconBtn tip="Fork conversation from here" icon="lucide:git-branch" disabled={props.forking || !props.canFork} onClick={props.onFork} />
      <Show when={props.showCopy}>
        <MsgIconBtn tip="Copy" icon="lucide:copy" copied={props.copied} onClick={props.onCopy} />
      </Show>
      <MsgIconBtn tip="Regenerate response" icon="lucide:rotate-cw" onClick={props.onRegenerate} />
      <Show when={props.duration}>
        <span data-turn-duration class="ml-1.5 text-[11px] text-ink-500 tabular-nums" aria-label={`Turn duration: ${props.duration}`}>{props.duration}</span>
      </Show>
    </div>
  );
}
