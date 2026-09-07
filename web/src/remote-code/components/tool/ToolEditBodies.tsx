import { For, Show } from "solid-js";
import { copyWithToast } from "../../../ui";
import type { ToolUnit } from "../../types";
import type { TranscriptRenderCtx } from "../TranscriptBlocks";
import { CodeBlock, DiffView } from "../CodeBlock";
import { FileIcon } from "../../presentation";
import { languageForPath } from "../../utils/lang";
import type { useToolUnitModel } from "./toolUnitModel";

type ToolModel = ReturnType<typeof useToolUnitModel>;

export interface ToolPartProps {
  ctx: TranscriptRenderCtx;
  msgId: string;
  u: ToolUnit;
  m: ToolModel;
  running: boolean;
}

export function ToolEditBodies(props: ToolPartProps) {
  return (
<>
        {/* Context body per tool kind (scrollable, always inline — the
            collapsible rows already are the "open file/diff" view). */}
        <Show when={props.m.name() === "edit" && props.u.result?.toolResult}>
          <DiffView
            text={props.u.result?.toolResult || ""}
            max={40}
            name={String(props.m.args().path || "")}
          />
          <div class="flex items-center gap-2 px-3 py-1.5 border-t border-line/50">
            <button
              onClick={() => copyWithToast(props.u.result?.toolResult || "")}
              class="text-[11px] text-ink-600 hover:text-ink-300 cursor-pointer"
            >
              Copy
            </button>
          </div>
        </Show>
        <Show when={props.m.name() === "edit" && !props.u.result}>
          <For each={props.m.args().edits || []}>{(edit) => <DiffView text={`${String(edit.oldText || "").split("\n").map((s) => "-" + s).join("\n")}\n${String(edit.newText || "").split("\n").map((s) => "+" + s).join("\n")}`} name={String(props.m.args().path || "")} />}</For>
        </Show>
        <Show when={props.m.name() === "read"}>
          <Show
            when={props.u.result?.toolResult || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-ink-600">Reading file…</div>}
          >
            <CodeBlock
              text={props.u.result?.toolResult || props.m.prog() || ""}
              language={languageForPath(String(props.m.args().path || ""))}
            />
          </Show>
        </Show>
        <Show when={props.m.name() === "write"}>
          <CodeBlock
            text={String(props.m.args().content || props.u.result?.toolResult || "")}
            language={languageForPath(String(props.m.args().path || ""))}
          />
        </Show>
        <Show when={props.m.name() === "python"}>
          <Show
            when={props.u.result?.toolResult || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-ink-600">Running Python…</div>}
          >
            <Show when={props.m.args().script}>
              <div class="flex items-center gap-1.5 px-3 pt-2 text-[11px] text-ink-500">
                <FileIcon path={String(props.m.args().script || "")} />
                <span class="font-mono truncate">{String(props.m.args().script || "")}{Array.isArray(props.m.args().args) && props.m.args().args.length > 0 ? ` ${props.m.args().args.map(String).join(" ")}` : ""}</span>
              </div>
            </Show>
            <Show when={props.m.args().code}>
              <CodeBlock text={String(props.m.args().code || "")} language="python" />
            </Show>
            <div class="border-t border-line/50">
              <CodeBlock text={props.m.terminal().output || "No output"} language={undefined} />
            </div>
          </Show>
        </Show>
</>
  );
}
