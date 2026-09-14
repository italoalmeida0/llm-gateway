import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { FileIcon } from "../presentation";
import { MsgIconBtn } from "./MsgActions";
import { useModal, useQueue, useSession, useUI } from "../ctx";

/**
 * Queued messages card.
 *
 * Lives at the bottom of the transcript (below the question panel),
 * never in the composer. While a turn runs, composer sends land here;
 * when a turn completes normally the head auto-starts. Each row offers
 * send-now (cancels the turn and sends immediately), edit (text +
 * attachments) and delete.
 */
export function QueueCard() {
  const q = useQueue();
  const m = useModal();
  const s = useSession();
  const ui = useUI();

  const sid = () => s.activeSessionId();
  const items = () => q.queueOf(sid());
  const collapsed = () => q.queueCollapsed()[sid()] ?? false;

  return (
    <Show when={items().length > 0}>
      <div class={`${ui.convWidthClass()} mx-auto`}>
        <div class="bg-ink-900 border border-line/70 rounded-xl px-3 py-2">
          <div class="flex items-center gap-2">
            <span class="text-xs font-semibold text-ink-200">Queued Messages</span>
            <span class="text-[11px] font-mono bg-ink-800 border border-line/60 rounded px-1.5 py-0.5 text-ink-300">
              {items().length}
            </span>
            <span class="text-[11px] text-ink-500">Sends after agent finishes working</span>
            <span class="flex-1" />
            <button
              onClick={() => q.toggleCollapsed(sid())}
              class="p-1 rounded-md text-ink-500 hover:text-ink-200 hover:bg-ink-800 transition-colors cursor-pointer"
              aria-label={collapsed() ? "Expand queue" : "Collapse queue"}
            >
              <Iconify icon={collapsed() ? "lucide:chevron-up" : "lucide:chevron-down"} size={14} />
            </button>
          </div>
          <Show when={!collapsed()}>
            <div class="mt-1 flex flex-col">
              <For each={items()}>
                {(item) => (
                  <div class="py-1 border-t border-line/40 first:border-t-0">
                    <Show
                      when={q.editingQueueId() === item.id}
                      fallback={
                        <div class="flex items-center gap-1 min-w-0">
                          <span class="flex-1 truncate text-sm text-ink-200">{item.text}</span>
                          <Show when={item.attachmentIds.length > 0}>
                            <span class="text-[10px] font-mono text-ink-500 shrink-0">
                              📎{item.attachmentIds.length}
                            </span>
                          </Show>
                          <MsgIconBtn tip="Send now (cancels current turn)" icon="lucide:arrow-right" compact onClick={() => q.sendNow(item.id)} />
                          <MsgIconBtn tip="Edit queued message" icon="lucide:pencil" compact onClick={() => q.beginEdit(item, m.sessionFiles()[sid()] || [])} />
                          <MsgIconBtn tip="Remove from queue" icon="lucide:trash-2" compact danger onClick={() => q.removeQueued(item.id)} />
                        </div>
                      }
                    >
                      <QueueEditRow queueId={item.id} />
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}

function QueueEditRow(props: { queueId: string }) {
  const q = useQueue();
  const m = useModal();
  const s = useSession();
  let fileRef: HTMLInputElement | undefined;

  return (
    <div class="flex flex-col gap-1.5">
      <textarea
        value={q.editingQueueText()}
        onInput={(e) => q.setEditingQueueText(e.currentTarget.value)}
        rows={2}
        class="w-full bg-ink-950 border border-line/70 rounded-lg px-2 py-1.5 text-sm text-ink-100 resize-y focus:outline-none focus:border-accent-500"
      />
      <Show when={q.editDraft.pendingAttachments().length > 0}>
        <div class="flex flex-wrap gap-1.5">
          <For each={q.editDraft.pendingAttachments()}>
            {(a) => (
              <span class="flex items-center gap-1 text-[11px] bg-ink-950 border border-line/70 px-2 py-1 rounded-lg text-ink-300">
                <FileIcon path={a.name} size={13} />
                <button
                  onClick={() => m.openStoredPreview(s.activeSessionId(), a.serverId || "")}
                  class="hover:underline truncate max-w-40"
                >
                  {a.name}
                </button>
                <button
                  aria-label={`Remove ${a.name}`}
                  onClick={() => q.editDraft.removePendingAttachment(a.key)}
                  class="cursor-pointer px-0.5 hover:text-rose-400"
                >
                  ×
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <div class="flex items-center gap-1">
        <input
          ref={fileRef}
          type="file"
          multiple
          class="hidden"
          onChange={(e) => {
            if (e.currentTarget.files) q.editDraft.handleFiles(e.currentTarget.files);
            e.currentTarget.value = "";
          }}
        />
        <MsgIconBtn tip="Add attachments" icon="lucide:paperclip" compact onClick={() => fileRef?.click()} />
        <span class="flex-1" />
        <button
          onClick={() => {
            q.setEditingQueueId(null);
            q.editDraft.clearAttachments();
          }}
          class="px-2 py-1 rounded-md text-xs text-ink-400 hover:text-ink-200 hover:bg-ink-800 transition-colors cursor-pointer"
        >
          Cancel
        </button>
        <button
          onClick={() => void q.saveEdit(props.queueId)}
          class="px-2 py-1 rounded-md text-xs bg-accent-600 hover:bg-accent-500 text-white transition-colors cursor-pointer"
        >
          Save
        </button>
      </div>
    </div>
  );
}
