import type { ChatMessage, RenderBlock, ToolUnit, TurnBalloon, TurnEntry } from "./types";
import { displayToolArgs, withoutContinueNudges, withoutTodoActivity } from "./live";

export function hasVisibleText(message: ChatMessage): boolean {
  return message.blocks.some((b) => b.type === "text" && !!b.text?.trim());
}

export function hasToolActivity(message: ChatMessage): boolean {
  return message.blocks.some((b) => b.type === "tool_call" || b.type === "tool_result");
}

/** Rough token estimate for hide-tool-messages: chars / 4. Messages with
 * >= LONG_MESSAGE_TOKENS always show even when hiding is enabled, so
 * genuinely useful agent output is never swallowed by the tool group. */
export const LONG_MESSAGE_TOKENS = 50;

export function assistantTextTokens(message: ChatMessage): number {
  const text = message.blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text as string)
    .join("\n")
    .trim();
  return text.length / 4;
}

export function isLongAssistantMessage(message: ChatMessage): boolean {
  return assistantTextTokens(message) >= LONG_MESSAGE_TOKENS;
}

/** Max chars for the live turn hint shown next to "Working · <time>". */
export const TURN_HINT_MAX_CHARS = 100;

/** Single-line text of an assistant message (whitespace collapsed). */
export function assistantSingleLine(message: ChatMessage): string {
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
    turnMsgs = messages.filter((m) => m.turnIndex === maxStamped);
  } else {
    let start = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isTurnStartMessage(messages[i])) { start = i + 1; break; }
    }
    turnMsgs = messages.slice(start);
  }
  for (let i = turnMsgs.length - 1; i >= 0; i--) {
    const m = turnMsgs[i];
    if (m.role !== "assistant") continue;
    const text = assistantSingleLine(m);
    if (text && text.length < TURN_HINT_MAX_CHARS) return text;
  }
  return "";
}

/** Fuzzy text similarity for turn dedup: normalized containment either way
 * or high word-overlap. Keeps only the last of near-duplicate progress
 * notes (the agent restating itself while tools run). Pure — covered by tests. */
export function fuzzySame(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (short.length >= 24 && long.includes(short)) return true;
  const words = (s: string) => new Set(s.split(" ").filter(Boolean));
  const wa = words(na);
  const wb = words(nb);
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return union > 0 && inter / union >= 0.8;
}

/** Featured final message of a turn: the last message with 50+ tokens that
 * was written either without calling any tool or alongside the completion
 * signal. Rendered below the aggregate once the turn ends. */
export function finalTurnMessage(turnMsgs: ChatMessage[]): ChatMessage | null {
  for (let k = turnMsgs.length - 1; k >= 0; k--) {
    const m = turnMsgs[k];
    if (!hasVisibleText(m)) continue;
    if (hasToolActivity(m) && !m.hasCompletion) continue;
    if (!isLongAssistantMessage(m)) continue;
    return m;
  }
  return null;
}

/** Pair tool calls with results across a turn, in display order. */
function pairTurnUnits(turnMsgs: ChatMessage[]): ToolUnit[] {
  const units: ToolUnit[] = [];
  const byId = new Map<string, ToolUnit>();
  for (const message of turnMsgs) {
    for (const block of message.blocks) {
      if (block.type === "tool_call") {
        const unit: ToolUnit = { call: block };
        units.push(unit);
        if (block.toolId) byId.set(block.toolId, unit);
      } else if (block.type === "tool_result") {
        const unit = block.toolId ? byId.get(block.toolId) : undefined;
        if (unit && !unit.result) unit.result = block;
        else units.push({ result: block });
      }
    }
  }
  return units;
}

/** Ordered aggregate rows for a turn, in stored (daemon) block order.
 * Tool runs stay merged across messages until a thinking/text/image entry
 * breaks them, preserving the existing cross-message explore/command
 * sub-grouping for pure tool runs. */
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
    let textNth = 0;
    for (const block of message.blocks) {
      if (block.type === "tool_call") {
        const unit: ToolUnit = { call: block };
        if (!runMsg) runMsg = message;
        run.push(unit);
        if (block.toolId) byId.set(block.toolId, unit);
      } else if (block.type === "tool_result") {
        const unit = block.toolId ? byId.get(block.toolId) : undefined;
        if (!runMsg) runMsg = message;
        if (unit && !unit.result && run.includes(unit)) unit.result = block;
        else run.push({ result: block });
      } else if (block.type === "text" && !!block.text?.trim()) {
        flushRun();
        entries.push({ kind: "text", msg: message, block, nth: textNth++ });
      } else if (block.type === "image") {
        flushRun();
        entries.push({ kind: "image", msg: message, block });
      }
    }
  }
  flushRun();
  // Fuzzy dedup: hide near-duplicate texts, the last one wins.
  const texts = entries.filter((e) => e.kind === "text");
  for (let i = 0; i < texts.length; i++) {
    for (let j = texts.length - 1; j > i; j--) {
      if (texts[j].kind === "text" && texts[i].kind === "text" &&
        fuzzySame(texts[i].block.text || "", texts[j].block.text || "")) {
        texts[i].hidden = true;
        break;
      }
    }
  }
  return entries;
}

/** One aggregate per assistant turn: every message of a turn with tool
 * activity or thinking (texts, thinkings, tool runs) becomes ordered rows
 * of a single card. A turn with neither stays as plain single bubbles.
 * Keep the raw transcript and source indices intact, including while a new
 * step streams. */
export function buildRenderBlocks(
  messages: ChatMessage[],
  _options?: { hideToolMessages?: boolean },
): RenderBlock[] {
  const list = withoutContinueNudges(withoutTodoActivity(messages));
  const result: RenderBlock[] = [];

  for (let i = 0; i < list.length; i++) {
    const head = list[i];
    if (head.role === "user") { result.push({ kind: "single", msg: head }); continue; }

    let turnEnd = i;
    while (turnEnd + 1 < list.length && list[turnEnd + 1].role !== "user") turnEnd++;
    const turnMsgs = list.slice(i, turnEnd + 1);
    const tools = turnMsgs.some(hasToolActivity);
    const thoughts = turnMsgs.some((m) =>
      m.blocks.some((b) => b.type === "reasoning" && !!b.reasoning?.trim()));
    if (!tools && !thoughts) {
      for (const m of turnMsgs) result.push({ kind: "single", msg: m });
    } else {
      result.push({
        kind: "series",
        msg: turnMsgs[0],
        extras: turnMsgs.slice(1),
        units: pairTurnUnits(turnMsgs),
        entries: buildTurnEntries(turnMsgs),
        finalMsgId: finalTurnMessage(turnMsgs)?.id ?? null,
      });
    }
    i = turnEnd;
  }
  return result;
}

/** Strip only the daemon's terminal footer. Preserve actual command output. */
export function terminalPresentation(text: string): {output:string; durationMs?:number} {
  const match = /\n\[exit -?\d+\](?: \(full output: ([^\n]+)\))? {2}Took ((?:\d+h)?(?:\d+m)?(?:[\d.]+s)?)\s*$/.exec(text);
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
      return {
        icon: "lucide:terminal",
        verb: "Run",
        target: cmd.length > 90 ? cmd.slice(0, 90) + "…" : cmd,
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
      // AI-visible text is pi's one-line confirmation with no diff.
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
          verb: "Run",
          target: target.length > 90 ? target.slice(0, 90) + "…" : target,
        };
      }
      const first = String(args.code || "")
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("#"));
      const one = (first || "snippet").replace(/\s+/g, " ").trim();
      return {
        icon: "mdi:language-python",
        verb: "Run",
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
    default:
      return { icon: "lucide:wrench", verb: name, target: "" };
  }
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
): Map<string, TurnBalloon[]> {
  const result = new Map<string, TurnBalloon[]>();
  if (!blocks || blocks.length === 0) return result;

  const validBalloons = (balloons || []).filter((b) => (b.files?.length || 0) > 0);
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

