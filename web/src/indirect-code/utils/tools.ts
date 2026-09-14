import { displayToolArgs } from "../live";
import type { ToolCat } from "../types";

export function tryParseArgs(a?: string): any {
  return displayToolArgs(a);
}

export function toolCatOf(name?: string): ToolCat {
  if (name === "read" || name === "glob" || name === "search" || name === "inspect") return "explore";
  if (name === "bash" || name === "python") return "command";
  if (name === "edit" || name === "write" || name === "patch") return "edit";
  return "other";
}
