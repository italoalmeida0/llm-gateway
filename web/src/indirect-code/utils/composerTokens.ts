/** Only explicit command tokens route away from the model; absolute paths do not. */
export function slashCommand(text: string) {
  const match =
    /^\/(clear|model|reasoning|compact|jail|unjail|help|skills|mcp)(?:\s|$)/i.exec(
      text.trim(),
    );
  return match ? `/${match[1].toLowerCase()}` : undefined;
}

/** A mention is a standalone token at the caret, never an email address. */
export function activeMention(text: string, caret: number) {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@([^\s@"`]*|"[^"\n]*)$/.exec(before);
  if (!match) return null;
  const query = match[1].replace(/^"/, "");
  const tail = text.slice(caret);
  const remainder = match[1].startsWith('"')
    ? /^[^"\n]*(?:"|$)/.exec(tail)?.[0]
    : /^[^\s@"`]*/.exec(tail)?.[0];
  return {
    start: before.length - match[1].length - 1,
    end: caret + (remainder?.length || 0),
    query,
  };
}

export function insertMention(
  text: string,
  token: { start: number; end: number },
  path: string,
) {
  const tail = text.slice(token.end);
  const reference = `@${/[\s"\\]/.test(path) ? JSON.stringify(path) : path}${/^\s/.test(tail) ? "" : " "}`;
  return {
    text: text.slice(0, token.start) + reference + text.slice(token.end),
    caret: token.start + reference.length,
  };
}
