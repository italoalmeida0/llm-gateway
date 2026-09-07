import type { ChatMessage, RenderBlock, ToolUnit } from "./pages/RemoteCode";
import { withoutTodoActivity } from "./rcLive";

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
