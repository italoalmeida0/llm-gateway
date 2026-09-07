import { toolCatOf } from "./tools";
import type { ToolUnit } from "../types";

/** Um segmento dentro do cartão agregado de tools: ou um grupo colapsável
 * (≥2 calls consecutivas de explore/command da mesma categoria) ou uma
 * unit isolada. Extração pura de `renderToolSegs` (TranscriptBlocks) —
 * sem dependência Solid, coberta por testes. */
export type ToolSeg =
  | { kind: "group"; cat: "explore" | "command"; units: ToolUnit[] }
  | { kind: "unit"; unit: ToolUnit; idx: number };

export function partitionToolSegs(units: ToolUnit[]): ToolSeg[] {
  const segs: ToolSeg[] = [];
  let run: ToolUnit[] = [];
  let runIdx: number[] = [];
  let runCat: "explore" | "command" | null = null;
  const flush = () => {
    if (run.length >= 2 && runCat) segs.push({ kind: "group", cat: runCat, units: run });
    else run.forEach((unit, k) => segs.push({ kind: "unit", unit, idx: runIdx[k] }));
    run = [];
    runIdx = [];
    runCat = null;
  };
  units.forEach((unit, i) => {
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
