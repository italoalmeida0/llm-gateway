import { createMemo } from "solid-js";
import { tryParseArgs } from "../../utils/tools";
import { toolSummary, terminalPresentation } from "../../transcript";
import { toolRowKey } from "../../utils/titles";
import type { ToolUnit } from "../../types";
import type { TranscriptRenderCtx } from "../TranscriptBlocks";

/** Reactive model of a tool row: memos derived from ToolUnit.
 * Called synchronously within the component (same Solid owner),
 * so createMemo instances belong to the row and dispose with it. */
export function useToolUnitModel(ctx: TranscriptRenderCtx, msgId: string, u: ToolUnit, ui: number, running: boolean) {
const key = () => toolRowKey(msgId, u, ui);
const open = () => ctx.toolOpen()[key()] ?? (running && !u.result);
const sum = createMemo(() => toolSummary(u));
const prog = () => (u.call?.toolId ? ctx.toolProgress()[u.call.toolId] : undefined);
const args = createMemo(() => tryParseArgs(u.call?.toolArgs));
const name = () => u.call?.toolName || "tool";
// Full shell command for the highlighted header: commands[] joined with
// the effective joiner (&& or ;), else the single command. Python rows
// show script + args or the first code line (same as the summary).
const bashHeaderCmd = () => {
  if (name() === "python") return sum().target || "";
  const a: any = args();
  if (Array.isArray(a.commands) && a.commands.length > 0) {
    return a.commands.map(String).join(a.stopOnError === false ? " ; " : " && ");
  }
  return String(a.command || sum().target || "");
};
const terminal = createMemo(() => terminalPresentation(u.result?.toolResult || ""));
const webDetails = () => {
  const d: any = u.result?.toolDetails;
  if (!d || !Array.isArray(d.results)) return undefined;
  return d as { query?: string; cached?: boolean; results: { title?: string; url?: string; snippet?: string }[] };
};
const fetchDetails = () => {
  const d: any = u.result?.toolDetails;
  if (!d || typeof d.url !== "string") return undefined;
  return d as { url: string; host?: string; title?: string; content?: string; truncated?: boolean };
};
const elapsed = () => {
  if (name() !== "bash" && name() !== "python") return "";
  const duration = u.result?.toolDurationMs ?? terminal().durationMs;
  if (duration !== undefined) return ctx.elapsedLabel(duration);
  const start = ctx.toolStarts()[u.call?.toolId || ""];
  return start ? ctx.elapsedLabel(ctx.turnClock() - start) : "";
};
  return { key, open, sum, prog, args, name, bashHeaderCmd, terminal, webDetails, fetchDetails, elapsed };
}

export type ToolModel = ReturnType<typeof useToolUnitModel>;

/** Props shared across sections of a tool row (header + bodies). Defined
 * once here; imported by ToolUnitHeader/ToolEditBodies/ToolSearchBodies. */
export interface ToolPartProps {
  ctx: TranscriptRenderCtx;
  msgId: string;
  u: ToolUnit;
  m: ToolModel;
  running: boolean;
}
