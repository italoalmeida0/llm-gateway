import { createMemo, createSignal, For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import { CodeBlock, DiffView } from "../CodeBlock";
import { FileIcon } from "../../presentation";
import { languageForPath } from "../../utils/lang";
import { diffStat } from "../../transcript";
import type { ToolPartProps } from "./toolUnitModel";

export interface FileEditSection {
  file: string;
  status: "applied" | "dry_run" | "error";
  matches?: number;
  error?: string;
  diff: string;
}

export function parseEditResults(raw: string, defaultPath?: string): FileEditSection[] {
  let text = (raw || "").trim();
  if (!text) return [];

  text = text
    .replace(
      /^\[Note: The line prefix "[^"]+" is for line identification only and is not part of the file content\.\]\n?/,
      "",
    )
    .trim();

  const lines = text.split("\n");
  const sections: FileEditSection[] = [];
  let current: FileEditSection | null = null;
  const diffLines: string[] = [];

  const flush = () => {
    if (current) {
      current.diff = diffLines.join("\n").trim();
      sections.push(current);
      diffLines.length = 0;
      current = null;
    }
  };

  const headerRegex = /^([✓○✗])\s+(.+?)(?:\s+\((\d+)\s+match(?:es)?\)|:\s*(.*))?$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed === "APPLIED." ||
      trimmed.startsWith("DRY RUN —") ||
      trimmed.startsWith("---") ||
      trimmed.startsWith("+++")
    ) {
      continue;
    }
    const m = line.match(headerRegex);
    if (m) {
      flush();
      const mark = m[1];
      const file = m[2].trim();
      const matchesStr = m[3];
      const errStr = m[4];
      const status: "applied" | "dry_run" | "error" =
        mark === "✗" ? "error" : mark === "○" ? "dry_run" : "applied";
      current = {
        file,
        status,
        matches: matchesStr ? parseInt(matchesStr, 10) : undefined,
        error: errStr?.trim() || undefined,
        diff: "",
      };
    } else if (current) {
      diffLines.push(line);
    } else if (trimmed) {
      diffLines.push(line);
    }
  }
  flush();

  if (sections.length === 0 && diffLines.length > 0) {
    const rawDiff = diffLines.join("\n").trim();
    if (rawDiff) {
      const isErr = /^(?:edit \d+:|error:|failed)/i.test(rawDiff);
      sections.push({
        file: defaultPath || "",
        status: isErr ? "error" : "applied",
        error: isErr ? rawDiff : undefined,
        diff: isErr ? "" : rawDiff,
      });
    }
  }

  return sections;
}

function FileEditCard(props: { sec: FileEditSection; scrollKey?: string }) {
  const [open, setOpen] = createSignal(true);
  const stat = () => diffStat(props.sec.diff);

  return (
    <div class="border-b border-line/40 last:border-b-0">
      <div
        onClick={() => setOpen(!open())}
        class="group/file flex items-center justify-between gap-2 px-3 py-1.5 bg-ink-900/40 hover:bg-ink-900/70 text-[12px] cursor-pointer transition-colors select-none"
      >
        <div class="flex items-center gap-2 min-w-0 flex-1">
          <FileIcon path={props.sec.file} size={14} />
          <span class="font-mono font-medium text-ink-200 truncate">{props.sec.file || "edit"}</span>
          <Show when={props.sec.status === "error"}>
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 font-mono">
              failed
            </span>
          </Show>
          <Show when={props.sec.status === "dry_run"}>
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-800 dark:text-amber-200 font-mono">
              preview
            </span>
          </Show>
          <Show when={stat().add > 0 || stat().del > 0}>
            <span class="font-mono text-[10.5px] shrink-0">
              <Show when={stat().add > 0}>
                <span class="text-emerald-400">+{stat().add}</span>
              </Show>
              <Show when={stat().add > 0 && stat().del > 0}>
                <span class="text-ink-600"> </span>
              </Show>
              <Show when={stat().del > 0}>
                <span class="text-rose-400">-{stat().del}</span>
              </Show>
            </span>
          </Show>
          <Show when={props.sec.matches !== undefined && stat().add === 0 && stat().del === 0}>
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-ink-800 text-ink-400 font-mono">
              {props.sec.matches} {props.sec.matches === 1 ? "match" : "matches"}
            </span>
          </Show>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <Iconify
            icon="lucide:chevron-down"
            size={12}
            class={`text-ink-500 transition-transform ${open() ? "rotate-180" : ""}`}
          />
        </div>
      </div>
      <Show when={open()}>
        <Show when={props.sec.error}>
          <div class="px-3 py-2 text-[11.5px] text-rose-400 font-mono bg-rose-500/5 border-t border-rose-500/15">
            {props.sec.error}
          </div>
        </Show>
        <Show when={props.sec.diff}>
          <div class="border-t border-line/20">
            <DiffView text={props.sec.diff} max={60} name={props.sec.file} scrollKey={props.scrollKey} />
          </div>
        </Show>
      </Show>
    </div>
  );
}

export function ToolEditBodies(props: ToolPartProps) {
  const defaultPath = () => {
    const a = props.m.args();
    if (a.path) return String(a.path);
    if (a.file) return String(a.file);
    if (Array.isArray(a.edits) && a.edits.length === 1) {
      return String(a.edits[0]?.path || a.edits[0]?.file || "");
    }
    return "";
  };

  const sections = createMemo(() => {
    // The daemon now sends the rich rendering in details.display (the
    // AI-visible text is pi's one-line confirmation); fall back to parsing
    // the result text for sessions recorded before the split.
    const res = (props.u.result?.toolDetails?.display ?? props.u.result?.toolResult) || "";
    return parseEditResults(res, defaultPath());
  });

  return (
    <>
      {/* Context body per tool kind (scrollable, always inline — the
          collapsible rows already are the "open file/diff" view). */}
      <Show when={(props.m.name() === "edit" || props.m.name() === "patch") && props.u.result}>
        <Show when={props.m.args().dryRun === true}>
          <div class="mx-3 mt-2 mb-1 inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
            <Iconify icon="lucide:eye" size={12} /> Dry run — no files written
          </div>
        </Show>
        <Show
          when={sections().length > 0}
          fallback={
            <div class="px-3 py-2 text-[11px] text-ink-600">
              No changes
            </div>
          }
        >
          <For each={sections()}>
            {(sec) => <FileEditCard sec={sec} scrollKey={`${props.m.key()}:${sec.file}`} />}
          </For>
        </Show>
      </Show>
        <Show when={(props.m.name() === "edit" || props.m.name() === "patch") && !props.u.result}>
          <Show when={props.m.args().dryRun === true}>
            <div class="mx-3 mt-2 mb-1 inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
              <Iconify icon="lucide:eye" size={12} /> Dry run — no files written
            </div>
          </Show>
          <div class="px-3 py-2 text-[11px] text-ink-600">
            {props.active ? (props.m.args().dryRun === true ? "Previewing edit…" : "Applying edit…") : null}
          </div>
        </Show>
        <Show when={props.m.name() === "read"}>
          <Show
            when={props.u.result?.toolDetails?.display || props.u.result?.toolResult || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-ink-600">{props.active ? "Reading file…" : null}</div>}
          >
            <CodeBlock
              text={(props.u.result?.toolDetails?.display ?? props.u.result?.toolResult) || props.m.prog() || ""}
              language={languageForPath(String(props.m.args().path || ""))}
              scrollKey={props.m.key()}
            />
          </Show>
        </Show>
        <Show when={props.m.name() === "write"}>
          <CodeBlock
            text={String((props.u.result?.toolDetails?.display ?? props.u.result?.toolResult) || props.m.args().content || "")}
            language={languageForPath(String(props.m.args().path || ""))}
            scrollKey={props.m.key()}
          />
        </Show>
        <Show when={props.m.name() === "python"}>
          <Show
            when={props.u.result?.toolResult || props.m.prog()}
            fallback={<div class="px-3 py-2 text-[11px] text-ink-600">{props.active ? "Running Python…" : null}</div>}
          >
            <Show when={props.m.args().script}>
              <div class="flex items-center gap-1.5 px-3 pt-2 text-[11px] text-ink-500">
                <FileIcon path={String(props.m.args().script || "")} />
                <span class="font-mono truncate">{String(props.m.args().script || "")}{Array.isArray(props.m.args().args) && props.m.args().args.length > 0 ? ` ${props.m.args().args.map(String).join(" ")}` : ""}</span>
              </div>
            </Show>
            <Show when={props.m.args().code}>
              <CodeBlock text={String(props.m.args().code || "")} language="python" scrollKey={`${props.m.key()}:code`} />
            </Show>
            <div class="border-t border-line/50">
              <CodeBlock text={props.m.terminal().output || "No output"} language={undefined} scrollKey={props.m.key()} />
            </div>
          </Show>
        </Show>
</>
  );
}
