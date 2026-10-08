import type { ChatMessage, ContentBlock, RenderBlock, ToolUnit, TurnBalloon, TurnEntry } from "./types";
import { formatDurationSecs } from "./utils/format";
import { displayToolArgs, withoutContinueNudges, withoutTodoActivity } from "./live";

/** bg_cancel/bg_check kind: python vs terminal. The daemon includes the
 * kind in the result header ("Background Task (python) — …"); fall back
 * to the job registry via toolDetails when present. */
function bgTaskKind(args: any, res: string, env?: Record<string, string>): string {
  const k = String(env?.kind || "").toLowerCase();
  if (k === "python" || k === "bash") return k;
  const m = /Background Task \((bash|python)\)/.exec(res || "");
  if (m) return m[1];
  const ak = String((args as any)?.kind || "").toLowerCase();
  if (ak === "python") return "python";
  return "bash";
}
function bgCancelKind(args: any, res: string, env?: Record<string, string>): string {
  return bgTaskKind(args, res, env);
}
function bgCheckKind(args: any, res: string, env?: Record<string, string>): string {
  return bgTaskKind(args, res, env);
}
/** Extracts the "LX-Y" range from a bg_check result (envelope page attr,
 * legacy header "Lines X–Y of N") for the row target. */
function bgCheckRange(res: string, env?: Record<string, string>): string {
  const pm = /^(\d+)-(\d+)\//.exec(env?.page || "");
  if (pm) return `L${pm[1]}-${pm[2]}`;
  const m = /Lines (\d+)[–-](\d+) of \d+/.exec(res || "");
  if (m) return `L${m[1]}-${m[2]}`;
  return "";
}

function hasVisibleText(message: ChatMessage): boolean {
  return message.blocks.some((b) => b.type === "text" && !!b.text?.trim());
}

function hasToolActivity(message: ChatMessage): boolean {
  return message.blocks.some((b) => b.type === "tool_call" || b.type === "tool_result");
}

/** Per-row session costs with the output bucket split pro-rata between
 * plain output and reasoning (same unit price, so the split is exact).
 * Null when the daemon reported no pricing — callers then hide costs. */
export function usageCosts(usage: {
  outTok: number; reasoningTok: number; costUsd: number;
  costInUsd?: number; costCacheUsd?: number; costOutUsd?: number;
}): { total: number; input: number; cache: number; output: number; reasoning: number } | null {
  const ci = usage.costInUsd || 0;
  const cc = usage.costCacheUsd || 0;
  const co = usage.costOutUsd || 0;
  if (ci + cc + co <= 0 && !(usage.costUsd > 0)) return null;
  const out = Math.max(0, usage.outTok || 0);
  const reason = Math.min(Math.max(0, usage.reasoningTok || 0), out);
  const reasoningShare = out > 0 ? (co * reason) / out : 0;
  return {
    total: usage.costUsd || 0,
    input: ci,
    cache: cc,
    output: co - reasoningShare,
    reasoning: reasoningShare,
  };
}

/** USD with 2 decimals, truncated (never rounded up): $0.001 shows
 * as $0.00. */
export function fmtUsd(v: number): string {
  const n = Number(v) || 0;
  return (Math.floor(n * 100) / 100).toFixed(2);
}

/** Share of input tokens served from cache: cache / (fresh + cache).
 * Null when nothing was read yet — the caller then shows bare "Cache". */
export function cacheHitPct(usage: { inTok: number; cacheTok: number }): number | null {
  const total = (usage.inTok || 0) + (usage.cacheTok || 0);
  if (total <= 0) return null;
  return Math.round((100 * (usage.cacheTok || 0)) / total);
}

/** Max chars for the live turn hint shown next to "Working · <time>". */
const TURN_HINT_MAX_CHARS = 100;

/** Single-line text of an assistant message (whitespace collapsed). */
function assistantSingleLine(message: ChatMessage): string {
  return message.blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text as string)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Latest short (<100 chars) assistant text of the current turn: the turn
 * is the max stamped turnIndex, or — when nothing is stamped yet (live
 * streaming) — the tail after the last user turn-start message. Walks
 * back so a long/streaming bubble falls through to an earlier short one. */
export function latestShortTurnMessage(messages: ChatMessage[]): string {
  if (!messages || messages.length === 0) return "";
  let maxStamped = 0;
  for (const m of messages) {
    if (typeof m.turnIndex === "number" && m.turnIndex > maxStamped) maxStamped = m.turnIndex;
  }
  let turnMsgs: ChatMessage[];
  if (maxStamped > 0) {
    let start = messages.findIndex((m) => m.turnIndex === maxStamped);
    for (let i = messages.length - 1; i > start; i--) {
      if (isTurnStartMessage(messages[i]) && messages[i].turnIndex !== maxStamped) { start = i + 1; break; }
    }
    turnMsgs = messages.slice(start);
  } else {
    let start = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isTurnStartMessage(messages[i])) { start = i + 1; break; }
    }
    turnMsgs = messages.slice(start);
  }
  // Use the same successful-signal projection as the transcript. Pending or
  // rejected summary arguments must not leak through the Working hint.
  const visible = withoutTodoActivity(turnMsgs);
  for (let i = visible.length - 1; i >= 0; i--) {
    if (!visible[i].hasSummary) continue;
    const text = assistantSingleLine(visible[i]);
    if (text) return text.length > TURN_HINT_MAX_CHARS ? text.slice(0, TURN_HINT_MAX_CHARS - 1) + "…" : text;
  }

  // In tool turns without an explicit summary tool call, suppress conversational chatter hints.
  if (turnMsgs.some(hasToolActivity)) {
    return "";
  }

  for (let i = turnMsgs.length - 1; i >= 0; i--) {
    const m = turnMsgs[i];
    if (m.role !== "assistant") continue;
    const text = assistantSingleLine(m);
    if (text && text.length < TURN_HINT_MAX_CHARS) return text;
  }
  return "";
}

/** Pair tool calls with results across a turn, in display order.
 * Duplicate calls with the same id (pre-created card + finalized call)
 * merge into one unit so no result-less orphan lingers mid-list. */
function pushCallUnit(units: ToolUnit[], byId: Map<string, ToolUnit>, block: ContentBlock): void {
  const existing = block.toolId ? byId.get(block.toolId) : undefined;
  if (existing) {
    existing.call = block;
    return;
  }
  const unit: ToolUnit = { id: block.toolId, call: block };
  units.push(unit);
  if (block.toolId) byId.set(block.toolId, unit);
}

function pairTurnUnits(turnMsgs: ChatMessage[]): ToolUnit[] {
  const units: ToolUnit[] = [];
  const byId = new Map<string, ToolUnit>();
  for (const message of turnMsgs) {
    for (const block of message.blocks) {
      if (block.type === "tool_call") {
        pushCallUnit(units, byId, block);
      } else if (block.type === "tool_result") {
        const unit = block.toolId ? byId.get(block.toolId) : undefined;
        if (unit) unit.result = block;
        else {
          const orphan = { id: block.toolId, result: block };
          units.push(orphan);
          if (block.toolId) byId.set(block.toolId, orphan);
        }
      }
    }
  }
  return units;
}

/** Ordered aggregate rows for a tool/thinking block, in stored (daemon) block order.
 * Tool runs stay merged across messages until a thinking/image entry breaks them. */
function buildTurnEntries(turnMsgs: ChatMessage[]): TurnEntry[] {
  const entries: TurnEntry[] = [];
  let run: ToolUnit[] = [];
  let runMsg: ChatMessage | null = null;
  const byId = new Map<string, ToolUnit>();
  const flushRun = () => {
    if (run.length && runMsg) entries.push({ kind: "tools", msg: runMsg, units: run });
    run = [];
    runMsg = null;
  };
  for (const message of turnMsgs) {
    const reasoning = message.blocks.filter((b) => b.type === "reasoning" && !!b.reasoning?.trim());
    // Stored (daemon) order, newest first; stored[0] is the live one.
    for (let r = 0; r < reasoning.length; r++) {
      flushRun();
      entries.push({ kind: "thinking", msg: message, block: reasoning[r], nth: r, isNewest: r === 0 });
    }
    for (const block of message.blocks) {
      if (block.type === "tool_call") {
        if (!runMsg) runMsg = message;
        pushCallUnit(run, byId, block);
      } else if (block.type === "tool_result") {
        const unit = block.toolId ? byId.get(block.toolId) : undefined;
        if (unit) {
          unit.result = block;
        } else {
          if (!runMsg) runMsg = message;
          const orphan = { id: block.toolId, result: block };
          run.push(orphan);
          if (block.toolId) byId.set(block.toolId, orphan);
        }
      } else if (block.type === "image") {
        flushRun();
        entries.push({ kind: "image", msg: message, block });
      }
    }
  }
  flushRun();
  return entries.map((entry, index) => ({
    ...entry,
    id: entry.kind === "tools"
      ? `${entry.msg.id}:tools:${entry.units[0]?.id || index}`
      : `${entry.msg.id}:${entry.kind}:${"nth" in entry ? entry.nth : index}`,
  }));
}

function buildTurnBlocks(turnMsgs: ChatMessage[]): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  let currentGroup: ChatMessage[] = [];

  const flushGroup = (textMsg?: ChatMessage) => {
    if (currentGroup.length === 0 && !textMsg) return;
    const groupMsgs = textMsg && !currentGroup.includes(textMsg)
      ? [...currentGroup, textMsg]
      : [...currentGroup];
    const entries = buildTurnEntries(groupMsgs);
    const leadMsg = groupMsgs[0] || textMsg!;
    const blockId = textMsg ? textMsg.id : leadMsg.id;

    if (entries.length > 0) {
      blocks.push({
        kind: "series",
        id: blockId,
        msg: leadMsg,
        extras: groupMsgs.slice(1),
        units: pairTurnUnits(groupMsgs),
        entries,
        textMsg,
      });
    } else {
      blocks.push({ kind: "single", msg: textMsg || leadMsg });
    }
    currentGroup = [];
  };

  for (const m of turnMsgs) {
    if (hasVisibleText(m)) {
      currentGroup.push(m);
      flushGroup(m);
    } else {
      currentGroup.push(m);
    }
  }
  flushGroup(undefined);
  return blocks;
}

type RenderCache = Map<string, { messages: ChatMessage[]; blocks: RenderBlock[] }>;

/** Per-view cache: immutable message identities invalidate only changed turns.
 * Keeping only the latest turn set bounds retention across session switches. */
export function createRenderBlockBuilder() {
  const cache: RenderCache = new Map();
  return (messages: ChatMessage[]) => buildRenderBlocks(messages, cache);
}

/** One aggregate per contiguous tool execution/thinking run; visible text
 * messages (summaries, completions, direct answers) separate as individual
 * bubbles. Source indices remain attached to the original daemon messages. */
export function buildRenderBlocks(
  messages: ChatMessage[], cache?: RenderCache,
): RenderBlock[] {
  const list = withoutContinueNudges(withoutTodoActivity(messages));
  const result: RenderBlock[] = [];
  const nextCache: RenderCache = new Map();

  for (let i = 0; i < list.length; i++) {
    const head = list[i];
    if (head.role === "user") { result.push({ kind: "single", msg: head }); continue; }

    let turnEnd = i;
    while (turnEnd + 1 < list.length && list[turnEnd + 1].role !== "user" &&
      !(head.turnIndex && list[turnEnd + 1].turnIndex && head.turnIndex !== list[turnEnd + 1].turnIndex)) turnEnd++;
    const turnMsgs = list.slice(i, turnEnd + 1);
    const cached = cache?.get(head.id);
    if (cached && cached.messages.length === turnMsgs.length && cached.messages.every((m, index) => m === turnMsgs[index])) {
      result.push(...cached.blocks); nextCache.set(head.id, cached); i = turnEnd; continue;
    }
    const blocks = buildTurnBlocks(turnMsgs);
    result.push(...blocks);
    nextCache.set(head.id, { messages: turnMsgs, blocks });
    i = turnEnd;
  }
  if (cache) { cache.clear(); for (const [key, value] of nextCache) cache.set(key, value); }
  return result;
}

/** Wall-clock duration belongs to the turn, regardless of its presentation. */
export function blockTurnDuration(block: RenderBlock): number | undefined {
  const messages = block.kind === "series"
    ? (block.textMsg ? [block.textMsg, block.msg, ...block.extras] : [block.msg, ...block.extras])
    : [block.msg];
  return messages.find((m) => Number.isFinite(m.turnDurationMs) && (m.turnDurationMs ?? 0) > 0)?.turnDurationMs;
}

/** Strip only the daemon's terminal footer. Preserve actual command output. */
export function terminalPresentation(text: string): {output:string; durationMs?:number} {
  const match = /\n\[exit -?\d+\](?: \(full output: ([^\n]+)\))? {2}Took ((?:\d+h ?)?(?:\d+m ?)?(?:[\d.]+s)?)\s*$/.exec(text);
  if (!match) return {output:text};
  return {output:text.slice(0, match.index).trimEnd() + (match[1] ? `\n\nFull output: ${match[1]}` : ""),
    durationMs:Array.from(match[2].matchAll(/([\d.]+)([hms])/g)).reduce((sum, part) => sum + Number(part[1])*({h:3600000,m:60000,s:1000}[part[2]] || 0), 0)};
}

export function baseNameOf(p?: string): string {
  if (!p) return "";
  const t = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const i = t.lastIndexOf("/");
  return i >= 0 ? t.slice(i + 1) : t;
}

export function diffStat(text: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const ln of (text || "").split("\n")) {
    const clean = ln.replace(/^\d+:/, "");
    if (clean.startsWith("+") && !clean.startsWith("+++")) add++;
    else if (clean.startsWith("-") && !clean.startsWith("---")) del++;
  }
  return { add, del };
}

export interface ToolSummary {
  icon: string;
  verb: string;
  target: string;
  stat?: string;
  statAdd?: number;
  statDel?: number;
}

function isCleanQuestionLabel(text: any): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith("[") || t.startsWith("{") || t.includes('"header"') || t.includes('"options"') || t.includes('{"')) {
    return false;
  }
  return true;
}

function extractQuestionItems(args: any): any[] {
  if (!args) return [];
  if (Array.isArray(args)) return args;

  const raw = args.questions ?? args.question;
  if (!raw) return [];

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === "object") {
          return Array.isArray(parsed.questions)
            ? parsed.questions
            : Array.isArray(parsed.question)
              ? parsed.question
              : [parsed];
        }
      } catch {
        return [];
      }
    }
    if (isCleanQuestionLabel(trimmed)) {
      return [{ question: trimmed }];
    }
    return [];
  }

  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") {
    if (Array.isArray(raw.questions)) return raw.questions;
    if (Array.isArray(raw.question)) return raw.question;
    return [raw];
  }

  return [];
}


export function toolSummary(u: ToolUnit): ToolSummary {
  const name = u.call?.toolName || "tool";
  const args = displayToolArgs(u.call?.toolArgs);
  const res = u.result?.toolResult || "";
  if (name.startsWith("mcp__")) {
    return { icon: "lucide:plug", verb: "MCP", target: name.slice(5).replace(/_[a-f0-9]{12}$/, "").replaceAll("__", " / "), stat: u.result ? (u.result.isError ? "Failed" : "Complete") : undefined };
  }
  switch (name) {
    case "question": {
      const qList = extractQuestionItems(args);
      const targets = qList
        .map((q: any) => {
          if (typeof q === "string") return isCleanQuestionLabel(q) ? q.trim() : "";
          const label = q?.header || q?.question || "";
          return isCleanQuestionLabel(label) ? label.trim() : "";
        })
        .filter(Boolean);
      return {
        icon: "lucide:message-circle",
        verb: u.result ? "Asked" : "Asking",
        target: targets.join(" · ") || "Questions",
      };
    }
    case "read": {
      // Daemon offset is 1-indexed (schema: "Line number to start reading
      // from (1-indexed)"); the display block numbers lines with startLine+i+1,
      // so the label must use off directly, not off+1.
      const off = Math.max(1, Number(args.offset || 1));
      const lines = res ? res.split("\n").length : 0;
      const lim = Number(args.limit || 0);
      const end = lim > 0 ? off + lim - 1 : off + lines - 1;
      return {
        icon: "lucide:file-text",
        verb: "Analyzed",
        target: `${baseNameOf(args.path) || args.path || "file"}#L${off}-${Math.max(end, off)}`,
      };
    }
    case "glob": {
      const n = res ? res.split("\n").filter((l) => l.trim()).length : 0;
      return {
        icon: "lucide:search",
        verb: "Searched",
        target: String(args.pattern || ""),
        stat: n > 0 ? `${n} match${n === 1 ? "" : "es"}` : undefined,
      };
    }
    case "bash": {
      const cmd = String(args.command || "").replace(/\s+/g, " ").trim();
      const bg = (u.result?.toolDetails as any)?.background_job_id;
      // Detached runs (placeholder or folded result) read as background
      // work in the turn and the card, never as a plain synchronous run.
      const verb = typeof bg === "string" && bg ? "Background" : "Ran";
      return {
        icon: "lucide:terminal",
        verb,
        target: cmd.length > 90 ? cmd.slice(0, 90) + "…" : cmd,
      };
    }
    case "sleep": {
      const s = Number(args.seconds);
      return {
        icon: "lucide:timer",
        verb: u.result ? "Slept" : "Sleeping",
        target: Number.isFinite(s) ? formatDurationSecs(s) : "",
      };
    }
    case "bg_cancel": {
      // Clean UI: never show the id. "Canceled <kind> Background Task".
      const env = (u.result?.toolDetails as any)?.env;
      const kind = bgCancelKind(args, res, env);
      return {
        icon: kind === "python" ? "mdi:language-python" : "lucide:terminal",
        verb: u.result ? "Canceled" : "Canceling",
        target: `${kind === "python" ? "Python" : "Terminal"} Background Task`,
      };
    }
    case "bg_check": {
      // Reads like a file: "Background Task#Lfrom-to", kind icon.
      const env = (u.result?.toolDetails as any)?.env;
      const kind = bgCheckKind(args, res, env);
      const range = bgCheckRange(res, env);
      return {
        icon: kind === "python" ? "mdi:language-python" : "lucide:terminal",
        verb: "Read",
        target: range ? `Background Task#${range}` : "Background Task",
      };
    }
    case "search": {
      const pat = String(args.pattern || "").replace(/\s+/g, " ").trim();
      const scope = args.path && String(args.path) !== "." ? ` in ${baseNameOf(args.path) || args.path}` : "";
      const target = `${pat.length > 80 ? pat.slice(0, 80) + "…" : pat}${scope}`;
      return {
        icon: "lucide:search",
        verb: "Search",
        target: target || "pattern",
      };
    }
    case "inspect": {
      const target = args.path && String(args.path) !== "." ? String(args.path) : "workspace";
      return { icon: "lucide:folder-tree", verb: "Inspect", target };
    }
    case "patch":
    case "edit": {
      const edits = Array.isArray(args.edits) ? args.edits : [];
      const files = [...new Set([
        args.path ? (baseNameOf(args.path) || args.path) : null,
        args.file ? (baseNameOf(args.file) || args.file) : null,
        ...edits.map((e: any) => baseNameOf(e?.file || e?.path) || e?.file || e?.path),
      ].filter(Boolean))];
      const shown = files.slice(0, 3).join(", ") + (files.length > 3 ? ` +${files.length - 3}` : "");
      const isPreview = args.dryRun === true;
      const verb = isPreview ? (name === "patch" ? "Preview patch" : "Preview edit") : (name === "patch" ? "Patch" : "Edited");
      // Prefer the frontend-only display rendering (details.display); the
      // AI-visible text is a one-line confirmation with no diff.
      const st = diffStat(u.result?.toolDetails?.display ?? res);
      return {
        icon: "lucide:file-diff",
        verb,
        target: shown || (baseNameOf(args.path) || args.path || `${edits.length} edit${edits.length === 1 ? "" : "s"}`),
        ...(st.add > 0 || st.del > 0 ? { statAdd: st.add, statDel: st.del } : {}),
      };
    }
    case "search_web": {
      const q = String(args.query || "").replace(/\s+/g, " ").trim();
      return {
        icon: "lucide:globe",
        verb: "Web search",
        target: q.length > 90 ? q.slice(0, 90) + "…" : q || "query",
      };
    }
    case "fetch_url": {
      let host = String(args.url || "");
      try {
        host = new URL(String(args.url || "")).hostname.replace(/^www\./, "");
      } catch {
        // keep raw url string
      }
      return {
        icon: "lucide:link",
        verb: "Fetch",
        target: host.length > 90 ? host.slice(0, 90) + "…" : host || "url",
      };
    }
    case "python": {
      // Script mode shows the file; code mode shows the first meaningful line.
      if (args.script) {
        const a = Array.isArray(args.args) ? args.args : [];
        const suffix = a.length > 0 ? ` ${a.map(String).join(" ")}` : "";
        const target = `${baseNameOf(args.script) || args.script}${suffix}`;
        return {
          icon: "mdi:language-python",
          verb: "Ran",
          target: target.length > 90 ? target.slice(0, 90) + "…" : target,
        };
      }
      const first = String(args.code || "")
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("#"));
      const one = (first || "snippet").replace(/\s+/g, " ").trim();
      const bg = (u.result?.toolDetails as any)?.background_job_id;
      const verb = typeof bg === "string" && bg ? "Background" : "Ran";
      return {
        icon: "mdi:language-python",
        verb,
        target: one.length > 90 ? one.slice(0, 90) + "…" : one,
      };
    }
    case "write": {
      const content = String(args.content || "");
      const n = content ? content.split("\n").length : 0;
      return {
        icon: "lucide:file-text",
        verb: "Created",
        target: baseNameOf(args.path) || args.path || "file",
        stat: n > 0 ? `${n} lines` : undefined,
      };
    }
    default: {
      // Result without its call (a late or replayed tool_result): label it as
      // a result and let the body carry the text. The target repeats the
      // daemon's command label when it knows one; never echo body lines.
      if (!u.call?.toolName) {
        const env = (u.result?.toolDetails as any)?.env || {};
        return { icon: "lucide:file-text", verb: "Result", target: String(env.command || "") };
      }
      // Session meta tools: friendly labels instead of the raw tool name.
      switch (name) {
        case "summary":
        case "mark_task_as_complete":
          return { icon: "lucide:check-circle-2", verb: "Summary", target: "" };
        case "todo":
          return { icon: "lucide:list-checks", verb: "Tasks", target: "" };
        default:
          return { icon: "lucide:wrench", verb: name, target: "" };
      }
    }
  }
}

/** Sleep rows are header-only in every state: while the timer runs the
 * live remaining counter renders in the label, and once the result lands
 * ("Slept …" / "Woken early …") the header summary carries the outcome.
 * No body and no chevron, ever. Single source of truth for the row model
 * and the body gate — they must agree, or expanding a sleep shows an
 * empty body. */
export function isHeaderOnlySleep(toolName: string, _hasResult: boolean): boolean {
  return toolName === "sleep";
}

/** Determines if a chat message marks the beginning of an agent turn.
 * User messages initiate a turn by default, unless explicitly marked
 * as a mid-turn follow-up (midTurn: true or isTurnStart: false). */
export function isTurnStartMessage(msg: ChatMessage): boolean {
  if (msg.role !== "user") return false;
  if (typeof msg.isTurnStart === "boolean") return msg.isTurnStart;
  if (msg.midTurn) return false;
  return true;
}

/** Anchors per-turn file change balloons (both live changes of the current
 * turn and persistent changes of finished turns) to the final block of
 * their corresponding turn. If subsequent turns exist, the balloon sits
 * right above the next turn's initiating message; for the latest turn,
 * it sits at the bottom of the active conversation. */
export function mapBalloonsToBlocks(
  blocks: (RenderBlock & { id?: string })[],
  balloons: TurnBalloon[],
  oldestLoadedTurn = 0,
): Map<string, TurnBalloon[]> {
  const result = new Map<string, TurnBalloon[]>();
  if (!blocks || blocks.length === 0) return result;

  // Pagination frontier: committed balloons of turns below the oldest
  // loaded turn are not rendered yet — hide them instead of pinning
  // them onto the nearest visible block (that fallback stays for
  // pruned/compacted turns AT or ABOVE the frontier). Live balloons
  // always show (current turn). 0/undefined = everything loaded.
  const validBalloons = (balloons || []).filter((b) => {
    if ((b.files?.length || 0) === 0) return false;
    if (b.live) return true;
    const tIdx = typeof b.turnIndex === "number" ? b.turnIndex : 0;
    if (oldestLoadedTurn > 0 && tIdx > 0 && tIdx < oldestLoadedTurn) return false;
    return true;
  });
  if (validBalloons.length === 0) return result;

  // Deduplicate by turnIndex: finished balloon (live === false) supersedes live balloon
  const byTurn = new Map<number, TurnBalloon>();
  for (const b of validBalloons) {
    const existing = byTurn.get(b.turnIndex);
    if (!existing || (existing.live && !b.live)) {
      byTurn.set(b.turnIndex, b);
    }
  }
  const turnBalloons = Array.from(byTurn.values());

  let currentTurn = 0;
  const lastBlockOfTurn = new Map<number, string>();
  // Highest daemon-stamped turn seen: separates "turn not rendered yet"
  // (attach at the end) from "turn gone" (attach at nearest older turn).
  let maxStampedTurn = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockId = (block as any).id || block.msg.id;
    // Prefer the daemon-stamped session turn sequence carried on every
    // message; fall back to counting visible user bubbles only for
    // unstamped (legacy) messages.
    const stamped = typeof block.msg.turnIndex === "number" && block.msg.turnIndex > 0 ? block.msg.turnIndex : 0;
    if (stamped > 0) {
      currentTurn = stamped;
      if (stamped > maxStampedTurn) maxStampedTurn = stamped;
      lastBlockOfTurn.set(stamped, blockId);
    } else {
      if (isTurnStartMessage(block.msg)) {
        currentTurn++;
      }
      const tIdx = currentTurn > 0 ? currentTurn : 1;
      lastBlockOfTurn.set(tIdx, blockId);
    }
  }

  const lastBlockId = (blocks[blocks.length - 1] as any).id || blocks[blocks.length - 1].msg.id;
  const firstBlockId = (blocks[0] as any).id || blocks[0].msg.id;

  for (const b of turnBalloons) {
    const tIdx = typeof b.turnIndex === "number" && b.turnIndex > 0 ? b.turnIndex : 1;
    let targetId = lastBlockOfTurn.get(tIdx);

    if (!targetId) {
      if (tIdx > maxStampedTurn) {
        // Turn not rendered yet (live/current): pin to the end.
        targetId = lastBlockId;
      } else {
        // Turn gone (pruned/compacted): walk back to the nearest older
        // rendered turn instead of piling onto the first block.
        for (let t = tIdx - 1; t >= 1 && !targetId; t--) {
          targetId = lastBlockOfTurn.get(t);
        }
        targetId = targetId || firstBlockId;
      }
    }

    if (targetId) {
      const existing = result.get(targetId);
      if (existing) {
        existing.push(b);
        existing.sort((x, y) => x.turnIndex - y.turnIndex);
      } else {
        result.set(targetId, [b]);
      }
    }
  }

  return result;
}
