/**
 * Shared parsing for unified-style diffs rendered by <DiffView>. Two source
 * formats feed the same renderer:
 *  - edit tool results: "<number>:[ +-]<code>" rows (numbers embedded by the
 *    daemon, e.g. "12:+const x = 1")
 *  - turn-change balloons: standard unified diff text (---/+++/@@ hunks,
 *    "+"/-"/ " markers) — numbers are derived from the @@ headers.
 */

export type DiffKind = "add" | "del" | "context" | "header" | "ellipsis";

export interface ParsedDiffLine {
  lineNum: string;
  marker: string;
  code: string;
  kind: DiffKind;
}

/** Parse one raw diff line into marker/kind, keeping any embedded number. */
export function parseDiffLine(line: string): ParsedDiffLine {
  if (line.startsWith("---") || line.startsWith("+++")) {
    return { lineNum: "", marker: "", code: line, kind: "header" };
  }
  if (line === "..." || line.startsWith("@@")) {
    return { lineNum: "", marker: "", code: line, kind: "ellipsis" };
  }
  const numMatch = line.match(/^(\d+):([ +-])?(.*)$/);
  if (numMatch) {
    const marker = numMatch[2] || "";
    const kind: DiffKind = marker === "+" ? "add" : marker === "-" ? "del" : "context";
    // Without an explicit marker the row is plain numbered context (read/write).
    return { lineNum: numMatch[1], marker, code: numMatch[3], kind: numMatch[2] ? kind : "context" };
  }
  const standardMatch = line.match(/^([ +-])(.*)$/);
  if (standardMatch) {
    const marker = standardMatch[1];
    const kind: DiffKind = marker === "+" ? "add" : marker === "-" ? "del" : "context";
    return { lineNum: "", marker, code: standardMatch[2], kind };
  }
  return { lineNum: "", marker: "", code: line, kind: "context" };
}

/** Split a diff into renderable rows, deriving @@-based numbers when absent. */
export function diffRows(text: string): ParsedDiffLine[] {
  const clean = cleanNotice(text);
  const lines = clean
    .split("\n")
    .filter((l) => !l.startsWith("---") && !l.startsWith("+++"));
  const derived = deriveLineNumbers(clean);
  const parsed = lines.map(parseDiffLine);
  if (!derived) return parsed;
  return parsed.map((p, i) => (p.lineNum ? p : { ...p, lineNum: derived[i] || "" }));
}

/** Strip the daemon's line-prefix identification notice. */
export function cleanNotice(text: string): string {
  return (text || "").replace(
    /^\[Note: The line prefix "[^"]+" is for line identification only and is not part of the file content\.\]\n?/,
    "",
  );
}

/**
 * Derive per-line numbers for a plain unified diff by walking the @@ hunk
 * headers. Returns null when the text carries no @@ headers (edit-tool
 * format with embedded numbers, or hunkless snippets) — callers keep their
 * parsed numbers in that case.
 */
export function deriveLineNumbers(text: string): string[] | null {
  const lines = (text || "").split("\n").filter((l) => !l.startsWith("---") && !l.startsWith("+++"));
  if (!lines.some((l) => l.startsWith("@@"))) return null;

  const nums: string[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of lines) {
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = parseInt(hunk[1], 10);
      newLine = parseInt(hunk[3], 10);
      nums.push("");
      continue;
    }
    if (line.startsWith("+")) {
      nums.push(String(newLine));
      newLine++;
    } else if (line.startsWith("-")) {
      nums.push(String(oldLine));
      oldLine++;
    } else {
      // Context row: prefer the old-file number, falling back to the new
      // file for diffs that only count the new side (@@ -0,0 +1,N @@).
      nums.push(String(oldLine > 0 ? oldLine : newLine));
      oldLine++;
      newLine++;
    }
  }
  return nums;
}
