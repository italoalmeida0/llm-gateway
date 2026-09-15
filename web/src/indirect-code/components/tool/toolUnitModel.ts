import { createDisclosure } from "../Disclosure";
import { createMemo } from "solid-js";
import { tryParseArgs } from "../../utils/tools";
import { isHeaderOnlySleep, toolSummary, terminalPresentation } from "../../transcript";
import { toolRowKey } from "../../utils/titles";
import { formatDurationSecs } from "../../utils/format";
import type { ToolUnit } from "../../types";
import type { TranscriptRenderCtx } from "../TranscriptBlocks";

/** Reactive model of a tool row: memos derived from ToolUnit.
 * Called synchronously within the component (same Solid owner),
 * so createMemo instances belong to the row and dispose with it.
 * Rows start open only while active (the turn's live tail) with
 * non-blank content, and closed otherwise — unless the user toggled
 * them explicitly. */
export function useToolUnitModel(ctx: TranscriptRenderCtx, msgId: string, u: ToolUnit, ui: number, running: () => boolean, active: () => boolean) {
const key = () => toolRowKey(msgId, u, ui);
const sum = createMemo(() => toolSummary(u));
const prog = () => (u.call?.toolId ? ctx.toolProgress()[u.call.toolId] : undefined);
const args = createMemo(() => tryParseArgs(u.call?.toolArgs));
/** Declared before hasContent: Solid memos evaluate eagerly, so a memo
 * calling name() before this const initializes throws a TDZ
 * ReferenceError and breaks every tool row on expand. */
const name = () => u.call?.toolName || "tool";
/** Anything worth showing: result output, streamed args/progress. Rows
 * with nothing (pre-created card, empty call) stay shut until content
 * lands — the chevron still opens them manually. */
const hasContent = createMemo(() => {
  // Sleep rows are header-only while running (live counter in the label,
  // see sleepRemaining); finished sleeps report content like other tools.
  if (isHeaderOnlySleep(name(), !!u.result)) return false;
  if (((u.result?.toolDetails?.display ?? u.result?.toolResult) || "").trim() !== "") return true;
  if ((prog() || "").trim() !== "") return true;
  return Object.keys(args()).length > 0;
});
const { open, toggle } = createDisclosure(() => `${running()}:${active()}`,
  () => running() && active() && !u.result && u.call?.toolName !== "question" && hasContent());
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
const terminal = createMemo(() => terminalPresentation((u.result?.toolDetails?.display ?? u.result?.toolResult) || ""));
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
/** Live remaining counter for a running sleep ("42s left" / "1m 30s left"),
 * computed from the tool start + the turn clock — no progress spam needed. */
const sleepRemaining = () => {
  if (name() !== "sleep" || u.result) return "";
  const total = Number((args() as any)?.seconds);
  if (!Number.isFinite(total) || total <= 0) return "";
  const start = ctx.toolStarts()[u.call?.toolId || ""];
  if (!start) return "";
  return `${formatDurationSecs(Math.max(0, Math.ceil(total - (ctx.turnClock() - start) / 1000)))} left`;
};
const elapsed = () => {
  if (name() !== "bash" && name() !== "python" && !name().startsWith("mcp__")) return "";
  const duration = u.result?.toolDurationMs ?? terminal().durationMs;
  if (duration !== undefined) return ctx.elapsedLabel(duration);
  // A running background job ticks off the background clock so the row
  // keeps counting after the turn ends (and across reloads).
  if (bgRunning()) {
    const job = ctx.backgroundJobs().find((j) => j.id === bgJobId());
    if (job && job.startedAt) return ctx.elapsedLabel(Math.max(0, ctx.bgClock() - job.startedAt));
  }
  const start = ctx.toolStarts()[u.call?.toolId || ""];
  return start && active() ? ctx.elapsedLabel(ctx.turnClock() - start) : "";
};
/** Background job id when this call detached (placeholder or folded). */
const bgJobId = () => {
  const id = (u.result?.toolDetails as any)?.background_job_id;
  return typeof id === "string" && id ? id : "";
};
/** True while the detached job is still running (registry-driven, so it
 * survives the turn ending — the row keeps spinning and streaming). */
const bgRunning = () => {
  const id = bgJobId();
  if (!id) return false;
  return ctx.backgroundJobs().some((j) => j.id === id && j.status === "running");
};
/** Live streamed output for the running job (bg_output + bg_tail). */
const bgStream = () => {
  const id = bgJobId();
  return id ? ctx.bgOutput()[id] || "" : "";
};
/** True once the call carries a background job — the row renders as a
 * background run (badge, spinner while running). */
const isDetachedBg = () => bgJobId() !== "";
  return { key, open, toggle, sum, prog, args, name, bashHeaderCmd, terminal, webDetails, fetchDetails, elapsed, sleepRemaining, bgJobId, bgRunning, bgStream, isDetachedBg };
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
  /** The turn's live tail (latest call, or live progress): only active
   * rows spin or auto-open. Stale result-less units stay neutral. */
  active: boolean;
}
