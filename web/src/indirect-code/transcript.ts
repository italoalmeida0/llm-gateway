import type { ChatMessage, RenderBlock, ToolUnit, TurnBalloon } from "./types";
import { displayToolArgs, withoutContinueNudges, withoutTodoActivity } from "./live";

export function hasVisibleText(message: ChatMessage): boolean {
  return message.blocks.some((b) => b.type === "text" && !!b.text?.trim());
}

export function hasToolActivity(message: ChatMessage): boolean {
  return message.blocks.some((b) => b.type === "tool_call" || b.type === "tool_result");
}

/** Only visible assistant text starts a new response group. Keep the raw
 * transcript and source indices intact, including while a new step streams.
 * When hideToolMessages is true, messages sent alongside tool calls in a turn
 * are grouped into the series so intermediate actions and thoughts can form
 * a single mega group during the turn. */
export function buildRenderBlocks(
  messages: ChatMessage[],
  options?: { hideToolMessages?: boolean },
): RenderBlock[] {
  const list = withoutContinueNudges(withoutTodoActivity(messages));
  const result: RenderBlock[] = [];
  const hideTools = !!options?.hideToolMessages;

  for (let i = 0; i < list.length; i++) {
    const head = list[i];
    if (head.role === "user") { result.push({kind:"single", msg:head}); continue; }

    if (!hideTools) {
      const extras: ChatMessage[] = [];
      while (i+1 < list.length && list[i+1].role !== "user" && !hasVisibleText(list[i+1])) extras.push(list[++i]);
      const units: ToolUnit[] = [];
      const byId = new Map<string, ToolUnit>();
      for (const message of [head, ...extras]) for (const block of message.blocks) {
        if (block.type === "tool_call") {
          const unit = {call:block}; units.push(unit);
          if (block.toolId) byId.set(block.toolId, unit);
        } else if (block.type === "tool_result") {
          const unit = block.toolId ? byId.get(block.toolId) : undefined;
          if (unit && !unit.result) unit.result = block;
          else units.push({result:block});
        }
      }
      result.push(units.length || extras.length ? {kind:"series", msg:head, extras, units} : {kind:"single", msg:head});
      continue;
    }

    // When hideToolMessages is enabled:
    // Look ahead to find all consecutive assistant messages in this turn
    let turnEnd = i;
    while (turnEnd + 1 < list.length && list[turnEnd + 1].role !== "user") {
      turnEnd++;
    }
    const turnMsgs = list.slice(i, turnEnd + 1);

    // Find the last assistant message in this turn with tool activity
    let lastToolRelIdx = -1;
    for (let k = turnMsgs.length - 1; k >= 0; k--) {
      if (hasToolActivity(turnMsgs[k])) {
        lastToolRelIdx = k;
        break;
      }
    }

    if (lastToolRelIdx >= 0) {
      // Fuse messages up to lastToolRelIdx into one mega tool series
      const seriesMsgs = turnMsgs.slice(0, lastToolRelIdx + 1);
      const units: ToolUnit[] = [];
      const byId = new Map<string, ToolUnit>();
      for (const message of seriesMsgs) {
        for (const block of message.blocks) {
          if (block.type === "tool_call") {
            const unit = { call: block };
            units.push(unit);
            if (block.toolId) byId.set(block.toolId, unit);
          } else if (block.type === "tool_result") {
            const unit = block.toolId ? byId.get(block.toolId) : undefined;
            if (unit && !unit.result) unit.result = block;
            else units.push({ result: block });
          }
        }
      }

      result.push({
        kind: "series",
        msg: seriesMsgs[0],
        extras: seriesMsgs.slice(1),
        units,
      });

      i += lastToolRelIdx;
    } else {
      // No tools in this turn; group by visible text as normal
      const extras: ChatMessage[] = [];
      while (i + 1 < list.length && list[i + 1].role !== "user" && !hasVisibleText(list[i + 1])) {
        extras.push(list[++i]);
      }
      result.push(
        extras.length
          ? { kind: "series", msg: head, extras, units: [] }
          : { kind: "single", msg: head }
      );
    }
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
      const off = Number(args.offset || 0);
      const lines = res ? res.split("\n").length : 0;
      const lim = Number(args.limit || 0);
      const end = lim > 0 ? off + lim : off + lines;
      return {
        icon: "lucide:file-text",
        verb: "Analyzed",
        target: `${baseNameOf(args.path) || args.path || "file"}#L${off + 1}-${Math.max(end, off + 1)}`,
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

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockId = (block as any).id || block.msg.id;
    if (isTurnStartMessage(block.msg)) {
      currentTurn++;
    }
    const tIdx = currentTurn > 0 ? currentTurn : 1;
    lastBlockOfTurn.set(tIdx, blockId);
  }

  const lastBlockId = (blocks[blocks.length - 1] as any).id || blocks[blocks.length - 1].msg.id;
  const firstBlockId = (blocks[0] as any).id || blocks[0].msg.id;

  for (const b of turnBalloons) {
    const tIdx = typeof b.turnIndex === "number" && b.turnIndex > 0 ? b.turnIndex : 1;
    let targetId = lastBlockOfTurn.get(tIdx);

    if (!targetId) {
      if (tIdx >= currentTurn) {
        targetId = lastBlockId;
      } else {
        targetId = firstBlockId;
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

