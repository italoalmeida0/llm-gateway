import { toolCatOf } from "./tools";
import type { ToolUnit } from "../types";

/** A segment inside the aggregated tools card: either a collapsible group
 * (≥2 consecutive explore/command calls in the same category) or an
 * isolated unit. Pure extraction from `renderToolSegs` (TranscriptBlocks) —
 * no Solid dependency, covered by tests. */
export type ToolSeg =
  | { kind: "group"; cat: "explore" | "command"; units: ToolUnit[] }
  | { kind: "unit"; unit: ToolUnit; idx: number };

export const MAX_TOOL_GROUP_SIZE = 5;

export function partitionToolSegs(units: ToolUnit[], groupSingles = false): ToolSeg[] {
  const segs: ToolSeg[] = [];
  let run: ToolUnit[] = [];
  let runIdx: number[] = [];
  let runCat: "explore" | "command" | null = null;
  const flush = () => {
    if ((run.length >= 2 || (groupSingles && run.length > 0)) && runCat) segs.push({ kind: "group", cat: runCat, units: run });
    else run.forEach((unit, k) => segs.push({ kind: "unit", unit, idx: runIdx[k] }));
    run = [];
    runIdx = [];
    runCat = null;
  };
  units.forEach((unit, i) => {
    if (run.length === MAX_TOOL_GROUP_SIZE) flush();
    const cat = toolCatOf(unit.call?.toolName);
    if ((cat === "explore" || cat === "command") && (runCat === null || runCat === cat)) {
      runCat = cat;
      run.push(unit);
      runIdx.push(i);
    } else {
      flush();
      if (cat === "explore" || cat === "command") {
        runCat = cat;
        run.push(unit);
        runIdx.push(i);
      } else {
        segs.push({ kind: "unit", unit, idx: i });
      }
    }
  });
  flush();
  return segs;
}
