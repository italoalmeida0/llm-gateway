import type { ToolUnit } from "../types";

export function groupTitle(cat: "explore" | "command", units: ToolUnit[]): string {
  if (cat === "command") {
    return `Run ${units.length} command${units.length === 1 ? "" : "s"}`;
  }
  const files = units.filter((u) => u.call?.toolName === "read").length;
  const searches = units.filter((u) => u.call?.toolName === "glob").length;
  let t = `Explored ${files} file${files === 1 ? "" : "s"}`;
  if (searches > 0) t += `, ${searches} search${searches === 1 ? "" : "es"}`;
  return t;
}

  /**
   * One-line card title for the special aggregate balloon: tool verbs
   * compressed (first 3 distinct, then "+N more") so a 20-call series
   * stays one readable line instead of a paragraph.
   */
export function specialTitle(units: ToolUnit[]): string {
  if (units.length === 0) return "Tools";
  const parts = units.map((u) => {
    const names: Record<string,string> = {bash:"run", write:"create", edit:"edit", read:"read", glob:"search", todo:"plan"};
    return names[u.call?.toolName || ""] || u.call?.toolName || "tool";
  });
  const seen: string[] = [];
  for (const p of parts) {
    if (!seen.includes(p)) seen.push(p);
  }
  if (units.length === 1) return `1 tool call · ${seen[0] || "tool"}`;
  if (seen.length <= 3) return `${units.length} tool calls · ${seen.join(" · ")}`;
  return `${units.length} tool calls · ${seen.slice(0, 3).join(" · ")} +${seen.length - 3} more`;
}
export function toolRowKey(msgId: string, u: ToolUnit, fallback: number) {
  return `${msgId}:${u.call?.toolId || u.result?.toolId || "u" + fallback}`;
}
