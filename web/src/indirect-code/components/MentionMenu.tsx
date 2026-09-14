import { For, Show, createEffect } from "solid-js";
import type { createMentions } from "../hooks/useMentions";
import { FloatMenu } from "./FloatMenu";
import { FileIcon } from "../presentation";

export function MentionMenu(props: {
  mentions: ReturnType<typeof createMentions>;
  inputId: string;
}) {
  let list: HTMLDivElement | undefined;
  createEffect(() => {
    const index = props.mentions.index();
    const options = list?.querySelectorAll("[role=option]");
    options?.[index]?.scrollIntoView({ block: "nearest" });
  });
  return (
    <FloatMenu
      anchor={() => document.getElementById(props.inputId)}
      open={props.mentions.open()}
      placement="top-start"
      width="30rem"
    >
      <div class="px-2 py-1 text-ink-500">Workspace files</div>
      <div
        ref={list}
        role="listbox"
        aria-label="File mentions"
        class="max-h-60 overflow-y-auto"
      >
        <For each={props.mentions.files()}>
          {(path, i) => (
            <button
              role="option"
              aria-selected={i() === props.mentions.index()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => props.mentions.pick(path)}
              class={`w-full flex items-center gap-2 text-left p-2 rounded-lg cursor-pointer ${i() === props.mentions.index() ? "bg-ink-100 text-ink-950" : "hover:bg-elev text-ink-200"}`}
            >
              <FileIcon path={path} size={14} />
              <span class="truncate">{path}</span>
            </button>
          )}
        </For>
        <Show when={!props.mentions.files().length}>
          <p class="p-2 text-ink-500">
            {props.mentions.loading()
              ? "Searching files..."
              : props.mentions.error() || "No matching files"}
          </p>
        </Show>
      </div>
    </FloatMenu>
  );
}
