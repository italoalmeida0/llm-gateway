/** Normalize host paths without relying on the browser's operating system. */
function normalized(path: string): string {
  const slash = path.replace(/\\/g, "/");
  const prefix = /^[a-z]:\//i.test(slash) ? slash.slice(0, 3) : slash.startsWith("//") ? "//" : slash.startsWith("/") ? "/" : "";
  const parts: string[] = [];
  for (const part of slash.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length > (prefix === "//" ? 2 : 0) && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !prefix) parts.push(part);
  }
  return prefix + parts.join("/");
}

function comparable(path: string): string {
  const value = normalized(path);
  return /^[a-z]:/i.test(value) || value.startsWith("//") ? value.toLowerCase() : value;
}

/** Each conversation belongs to exactly one project: the deepest ancestor. */
export function projectForDirectory<T extends { id: string; path: string }>(cwd: string, projects: T[]): T | undefined {
  const directory = comparable(cwd);
  if (!directory) return undefined;
  let match: T | undefined;
  let length = -1;
  for (const project of projects) {
    const path = comparable(project.path);
    if (!path) continue;
    const prefix = path.endsWith("/") ? path : path + "/";
    if ((directory === path || directory.startsWith(prefix)) && path.length > length) {
      match = project;
      length = path.length;
    }
  }
  return match;
}

export function absoluteRemotePath(path: string, cwd: string, home = ""): string {
  if (home && (path === "~" || path.startsWith("~/"))) path = home + path.slice(1);
  const value = normalized(/^(?:[a-z]:[\\/]|[\\/])/i.test(path) ? path : `${cwd}/${path}`);
  return /^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith("\\\\") ? value.replace(/\//g, "\\") : value;
}
