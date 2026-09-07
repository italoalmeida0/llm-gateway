import type { ChatMessage, RenderBlock, ToolUnit } from "./types";
import { displayToolArgs, withoutTodoActivity } from "./live";

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

/** One-line Antigravity-style summary for a tool unit. */
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
        verb: args.isRegex ? "Regex search" : "Search",
        target: target || "pattern",
      };
    }
    case "inspect": {
      const target = args.path && String(args.path) !== "." ? String(args.path) : "workspace";
      return { icon: "lucide:folder-tree", verb: "Inspect", target };
    }
    case "patch": {
      const edits = Array.isArray(args.edits) ? args.edits : [];
      const files = [...new Set(edits.map((e: any) => baseNameOf(e?.file) || e?.file).filter(Boolean))];
      const shown = files.slice(0, 3).join(", ") + (files.length > 3 ? ` +${files.length - 3}` : "");
      return {
        icon: "lucide:file-diff",
        verb: args.dryRun === false ? "Patch" : "Preview patch",
        target: shown || `${edits.length} edit${edits.length === 1 ? "" : "s"}`,
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
