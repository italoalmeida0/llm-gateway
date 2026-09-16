/** Parser for the edit/patch result rendering (extracted from
 * ToolEditBodies — framework-free so bun:test can cover it directly). */

export interface FileEditSection {
  file: string;
  status: "applied" | "dry_run" | "error";
  matches?: number;
  error?: string;
  diff: string;
}

export function parseEditResults(raw: string, defaultPath?: string): FileEditSection[] {
  let text = (raw || "").trim();
  if (!text) return [];

  text = text
    .replace(
      /^\[Note: The line prefix "[^"]+" is for line identification only and is not part of the file content\.\]\n?/,
      "",
    )
    .trim();

  const lines = text.split("\n");
  const sections: FileEditSection[] = [];
  let current: FileEditSection | null = null;
  const diffLines: string[] = [];

  const flush = () => {
    if (current) {
      current.diff = diffLines.join("\n").trim();
      sections.push(current);
      diffLines.length = 0;
      current = null;
    }
  };

  // A Windows drive letter (`C:\…`) also contains a colon — it must not
  // be mistaken for the `path: message` error separator (which is always
  // `colon + space`; the drive colon is followed by `\` or `/`).
  const headerRegex = /^([✓○✗])\s+(.+?)(?:\s+\((\d+)\s+match(?:es)?\)|:\s+(.*))?$/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed === "APPLIED." ||
      trimmed.startsWith("DRY RUN —") ||
      trimmed.startsWith("---") ||
      trimmed.startsWith("+++")
    ) {
      continue;
    }
    const m = line.match(headerRegex);
    if (m) {
      flush();
      const mark = m[1];
      const file = m[2].trim();
      const matchesStr = m[3];
      const errStr = m[4];
      const status: "applied" | "dry_run" | "error" =
        mark === "✗" ? "error" : mark === "○" ? "dry_run" : "applied";
      current = {
        file,
        status,
        matches: matchesStr ? parseInt(matchesStr, 10) : undefined,
        error: errStr?.trim() || undefined,
        diff: "",
      };
    } else if (current) {
      diffLines.push(line);
    } else if (trimmed) {
      diffLines.push(line);
    }
  }
  flush();

  if (sections.length === 0 && diffLines.length > 0) {
    const rawDiff = diffLines.join("\n").trim();
    if (rawDiff) {
      const isErr = /^(?:edit \d+:|error:|failed)/i.test(rawDiff);
      sections.push({
        file: defaultPath || "",
        status: isErr ? "error" : "applied",
        error: isErr ? rawDiff : undefined,
        diff: isErr ? "" : rawDiff,
      });
    }
  }

  return sections;
}
