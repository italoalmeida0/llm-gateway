import type { ChatMessage, RenderBlock, ToolUnit } from "./pages/RemoteCode";
import { displayToolArgs, withoutTodoActivity } from "./rcLive";

export function hasVisibleText(message: ChatMessage): boolean {
  return message.blocks.some((b) => b.type === "text" && !!b.text?.trim());
}

/** Only visible assistant text starts a new response group. Keep the raw
 * transcript and source indices intact, including while a new step streams. */
export function buildRenderBlocks(messages: ChatMessage[]): RenderBlock[] {
  const list = withoutTodoActivity(messages);
  const result: RenderBlock[] = [];
  for (let i = 0; i < list.length; i++) {
    const head = list[i];
    if (head.role === "user" || head.system) { result.push({kind:"single", msg:head}); continue; }
    const extras: ChatMessage[] = [];
    while (i+1 < list.length && list[i+1].role !== "user" && !list[i+1].system && !hasVisibleText(list[i+1])) extras.push(list[++i]);
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
    if (ln.startsWith("+") && !ln.startsWith("+++")) add++;
    else if (ln.startsWith("-") && !ln.startsWith("---")) del++;
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

/** One-line Antigravity-style summary for a tool unit. */
export function toolSummary(u: ToolUnit): ToolSummary {
  const name = u.call?.toolName || "tool";
  const args = displayToolArgs(u.call?.toolArgs);
  const res = u.result?.toolResult || "";
  switch (name) {
    case "question": {
      let qList: any[] = [];
      if (Array.isArray(args?.questions)) {
        qList = args.questions;
      } else if (Array.isArray(args?.question)) {
        qList = args.question;
      } else if (args?.questions && typeof args.questions === "object") {
        qList = [args.questions];
      } else if (args?.question && typeof args.question === "object") {
        qList = [args.question];
      } else if (typeof args?.questions === "string" && args.questions.trim()) {
        qList = [{ question: args.questions.trim() }];
      } else if (typeof args?.question === "string" && args.question.trim()) {
        qList = [{ question: args.question.trim() }];
      }
      const targets = qList
        .map((q: any) => (typeof q === "string" ? q.trim() : (q?.header || q?.question || "")).toString().trim())
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
        verb: "Ran",
        target: cmd.length > 90 ? cmd.slice(0, 90) + "…" : cmd,
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
    case "edit": {
      const st = diffStat(res);
      return {
        icon: "lucide:pencil",
        verb: "Edited",
        target: baseNameOf(args.path) || args.path || "file",
        statAdd: st.add,
        statDel: st.del,
      };
    }
    default:
      return { icon: "lucide:wrench", verb: name, target: "" };
  }
}
