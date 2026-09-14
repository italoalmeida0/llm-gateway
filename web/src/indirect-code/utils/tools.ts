import { displayToolArgs } from "../live";
import type { ToolCat } from "../types";

export function tryParseArgs(a?: string): any {
  return displayToolArgs(a);
}

export function toolCatOf(name?: string): ToolCat {
  if (name === "read" || name === "glob") return "explore";
  if (name === "bash") return "command";
  if (name === "edit" || name === "write") return "edit";
  return "other";
}

/**
 * Pairs the tool units of one assistant message, then attaches any orphan
 * tool_result blocks found in the following user/tool envelopes to the SAME
 * series (the daemon persists results separately; rendering must not
 * pretend they belong to a later turn). `tail` is the slice of following
 * raw messages considered part of the still-open turn; indices of consumed
 * envelopes are reported so the renderer can skip them.
 */


