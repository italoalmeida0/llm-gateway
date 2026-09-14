import type { ToolUnit } from "../types";

export function groupTitle(cat: "explore" | "command", units: ToolUnit[]): string {
  if (cat === "command") {
    return `Ran ${units.length} command${units.length === 1 ? "" : "s"}`;
  }
  const files = units.filter((u) => u.call?.toolName === "read").length;
  const searches = units.filter((u) => u.call?.toolName === "glob" || u.call?.toolName === "search").length;
  const inspections = units.filter((u) => u.call?.toolName === "inspect").length;
  const parts: string[] = [];
  if (files) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  if (searches) parts.push(`${searches} search${searches === 1 ? "" : "es"}`);
  if (inspections) parts.push(`${inspections} director${inspections === 1 ? "y" : "ies"}`);
  return `Explored ${parts.join(", ")}`;
}

  /**
   * One-line activity summary for the turn aggregate card: counts per
   * activity (explored files, searches, commands, edits…) so a 20-call
   * turn stays one readable line instead of a paragraph.
   */
export function specialTitle(units: ToolUnit[], extra?: { texts?: number; thoughts?: number }): string {
  const plural = (n: number, one: string, many?: string) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;
  const names = units.map((u) => u.call?.toolName || "");
  const count = (...ns: string[]) => names.filter((n) => ns.includes(n)).length;
  const files = count("read");
  const searches = count("glob", "search");
  const commands = count("bash", "python");
  const edits = count("edit", "write", "patch");
  const questions = count("question");
  const web = count("fetch_url", "search_web");
  const others = units.length - files - searches - commands - edits - questions - web;
  const parts: string[] = [];
  if (files > 0 || searches > 0) {
    let explored = `Explored ${plural(files, "file")}`;
    if (searches > 0) explored += `, ${plural(searches, "search", "searches")}`;
    parts.push(explored);
  }
  if (commands > 0) parts.push(`Ran ${plural(commands, "command")}`);
  if (edits > 0) parts.push(`Made ${plural(edits, "edit")}`);
  if (questions > 0) parts.push(`Asked ${plural(questions, "question")}`);
  if (web > 0) parts.push(`Checked ${plural(web, "page")}`);
  if (others > 0) parts.push(plural(others, "call"));
  if ((extra?.texts || 0) > 0) parts.push(plural(extra!.texts!, "note"));
  if (parts.length === 0) return (extra?.thoughts || 0) > 0 ? "Thinking" : "Tools";
  return parts.join(" · ");
}
export function toolRowKey(msgId: string, u: ToolUnit, fallback: number) {
  return `${msgId}:${u.call?.toolId || u.result?.toolId || "u" + fallback}`;
}
