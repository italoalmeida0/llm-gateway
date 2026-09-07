import { Show } from "solid-js";
import { copyWithToast } from "../../../ui";
import { Icon as Iconify } from "../../../components/icon";
import { CodeBlock, DiffView } from "../CodeBlock";
import { FileIcon } from "../../presentation";
import { languageForPath } from "../../utils/lang";
import type { ToolPartProps } from "./toolUnitModel";

export function ToolEditBodies(props: ToolPartProps) {
  return (
<>
        {/* Context body per tool kind (scrollable, always inline — the
            collapsible rows already are the "open file/diff" view). */}
        <Show when={(props.m.name() === "edit" || props.m.name() === "patch") && props.u.result?.toolResult}>
          <Show when={props.m.args().dryRun === true}>
            <div class="mx-3 mt-2 mb-1 inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
              <Iconify icon="lucide:eye" size={12} /> Dry run — no files written
            </div>
          </Show>
          <DiffView
            text={props.u.result?.toolResult || ""}
            max={60}
            name={String(props.m.args().path || props.m.args().file || "")}
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
        <Show when={(props.m.name() === "edit" || props.m.name() === "patch") && !props.u.result}>
          <Show when={props.m.args().dryRun === true}>
            <div class="mx-3 mt-2 mb-1 inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
              <Iconify icon="lucide:eye" size={12} /> Dry run — no files written
            </div>
          </Show>
          <div class="px-3 py-2 text-[11px] text-ink-600">
            {props.m.args().dryRun === true ? "Previewing edit…" : "Applying edit…"}
          </div>
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
