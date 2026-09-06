// Read complete characters from a streamed JSON string without guessing a
// missing escape or displaying the raw JSON around the tool's file content.
function partialString(raw: string, field: string): string | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*"`).exec(raw);
  if (!match) return undefined;
  const start = match.index + match[0].length - 1;
  let i = start + 1;
  for (; i < raw.length; i++) {
    if (raw[i] === '"') { try { return JSON.parse(raw.slice(start, i + 1)); } catch { return undefined; } }
    if (raw[i] === "\\") {
      if (i + 1 >= raw.length) break;
      if (raw[i + 1] === "u") { if (!/^[0-9a-f]{4}$/i.test(raw.slice(i + 2, i + 6))) break; i += 5; }
      else i++;
    }
  }
  try { return JSON.parse(raw.slice(start, i) + '"'); } catch { return undefined; }
}

export function displayToolArgs(raw?: string): Record<string, any> {
  if (!raw) return {};
  try { const parsed = JSON.parse(raw); return parsed && typeof parsed === "object" ? parsed : {}; } catch { /* incomplete argument stream */ }
  const values: Record<string, any> = { _raw: raw };
  for (const field of ["path", "command", "content", "pattern", "oldText", "newText"]) {
    const text = partialString(raw, field);
    if (text !== undefined) values[field] = text;
  }
  if (values.oldText !== undefined || values.newText !== undefined) values.edits = [{oldText:values.oldText || "", newText:values.newText || ""}];
  return values;
}
