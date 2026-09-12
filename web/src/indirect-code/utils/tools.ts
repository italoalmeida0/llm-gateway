import { displayToolArgs } from "../live";
import type { ContentBlock, ToolCat, ToolUnit } from "../types";

export function tryParseArgs(a?: string): any {
  return displayToolArgs(a);
}

/** Pairs each tool_call with its tool_result by call id. */
export function pairToolUnits(blocks: ContentBlock[]): ToolUnit[] {
  const units: ToolUnit[] = [];
  const byId = new Map<string, ToolUnit>();
  for (const b of blocks) {
    if (b.type === "tool_call") {
      const u: ToolUnit = { call: b };
      units.push(u);
      if (b.toolId) byId.set(b.toolId, u);
    } else if (b.type === "tool_result") {
      const u = (b.toolId && byId.get(b.toolId)) || null;
      if (u && !u.result) u.result = b;
      else units.push({ result: b });
    }
  }
  return units;
}

export function toolCatOf(name?: string): ToolCat {
  if (name === "read" || name === "glob") return "explore";
  if (name === "bash") return "command";
  if (name === "edit" || name === "write") return "edit";
  return "other";
}

/** A message with no visible content (loading dots only) never forms part of a series. */
export function msgIsEmpty(m: { blocks: ContentBlock[] }): boolean {
  return (m.blocks || []).every(
    (b) =>
      (b.type === "text" && !(b.text || "").trim()) ||
      (b.type === "reasoning" && !(b.reasoning || "").trim()) ||
      b.type === "image",
  );
}

/** A message carries tool activity when it has a call, a result, or (after
 * normalization) anything only a tool run leaves behind. Display helpers
 * treat image-only leftovers as tool residue, never as new thought. */
export function msgHasTools(m: { blocks: ContentBlock[] }): boolean {
  return (m.blocks || []).some((b) => b.type === "tool_call" || b.type === "tool_result");
}

/**
 * Pairs the tool units of one assistant message, then attaches any orphan
 * tool_result blocks found in the following user/tool envelopes to the SAME
 * series (the daemon persists results separately; rendering must not
 * pretend they belong to a later turn). `tail` is the slice of following
 * raw messages considered part of the still-open turn; indices of consumed
 * envelopes are reported so the renderer can skip them.
 */


