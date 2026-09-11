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
export function projectForDirectory<T extends { id: string; path: string; protected?:boolean }>(cwd: string, projects: T[]): T | undefined {
  const home = projects.find((p) => p.protected);
  const directory = comparable(cwd === "" || cwd === "~" ? home?.path || "" : home && cwd.startsWith("~/") ? home.path + cwd.slice(1) : cwd);
  if (!directory) return home;
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
  return match || home;
}

/** Compact display: replace the session working directory with "." so
 * headers show `cd ./sub && build` instead of the full remote path.
 * A leading `cd . &&` left over by the collapse is redundant noise, so it
 * is stripped (`cd . && build` -> `build`). */
export function collapseCwd(cmd: string, cwd: string): string {
  if (!cmd || !cwd) return cmd;
  const base = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!base || base === "/") return cmd;
  const variants = [base];
  const back = base.replace(/\//g, "\\");
  if (back !== base) variants.push(back);
  let out = cmd;
  for (const v of variants) {
    if (v) out = out.split(v).join(".");
  }
  return out.replace(/^\s*cd\s+\.\s*&&\s*/, "").trimStart() || out.trimStart();
}

export function absoluteRemotePath(path: string, cwd: string, home = ""): string {
  if (home && (path === "~" || path.startsWith("~/"))) path = home + path.slice(1);
  const value = normalized(/^(?:[a-z]:[\\/]|[\\/])/i.test(path) ? path : `${cwd}/${path}`);
  return /^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith("\\\\") ? value.replace(/\//g, "\\") : value;
}

export function projectsByActivity<T extends {id:string; path:string; createdAt:number}>(projects:T[], sessions:{cwd:string; updatedAt:number}[]): T[] {
  const activity = new Map(projects.map((p) => [p.id, p.createdAt]));
  for (const session of sessions) {
    const project = projectForDirectory(session.cwd, projects);
    if (project) activity.set(project.id, Math.max(activity.get(project.id) || 0, session.updatedAt));
  }
  return [...projects].sort((a,b) => (activity.get(b.id) || 0) - (activity.get(a.id) || 0) || a.id.localeCompare(b.id));
}
