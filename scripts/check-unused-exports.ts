import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { join } from "path";

// Entry points / public module boundaries where exports are expected to be available
const IGNORED_EXPORT_FILES = new Set([
  "server/index.ts",
  "web/src/index.tsx",
]);

function getAllFiles(dir: string, ext = [".ts", ".tsx"]): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === "data" ||
      entry === ".git" ||
      entry === "indirect-code-daemon"
    ) {
      continue;
    }
    const st = statSync(full);
    if (st.isDirectory()) {
      files.push(...getAllFiles(full, ext));
    } else if (ext.some((e) => full.endsWith(e))) {
      files.push(full);
    }
  }
  return files;
}

const prodFiles = [...getAllFiles("server"), ...getAllFiles("web/src")];
const testAndScriptFiles = [...getAllFiles("test"), ...getAllFiles("scripts")];
const allFiles = [...prodFiles, ...testAndScriptFiles];

interface ExportItem {
  file: string;
  name: string;
  kind: string;
  line: number;
}

// Regex to capture top-level named exports:
// export (async) function foo / export const foo / export let foo / export type foo / export interface foo / export class foo
const exportRegex = /^export\s+(?:async\s+)?(function|const|let|var|type|interface|class)\s+([A-Za-z0-9_$]+)/gm;

const allExports: ExportItem[] = [];

for (const file of prodFiles) {
  if (IGNORED_EXPORT_FILES.has(file)) continue;
  const content = readFileSync(file, "utf8");
  let match;
  while ((match = exportRegex.exec(content)) !== null) {
    const kind = match[1];
    const name = match[2];
    const line = content.slice(0, match.index).split("\n").length;
    allExports.push({ file, name, kind, line });
  }
}

// Pre-read all file contents into memory once for speed
const fileContents = allFiles.map((file) => ({
  file,
  content: readFileSync(file, "utf8"),
}));

const deadExports: ExportItem[] = [];

for (const exp of allExports) {
  const wordRegex = new RegExp(`\\b${exp.name}\\b`, "g");
  let usesOutsideOwnDeclaration = 0;

  for (const { file, content } of fileContents) {
    const count = (content.match(wordRegex) || []).length;
    if (file === exp.file) {
      // 1 occurrence is the declaration itself. Any additional occurrence is a local use.
      if (count > 1) {
        usesOutsideOwnDeclaration += count - 1;
      }
    } else {
      usesOutsideOwnDeclaration += count;
    }
    if (usesOutsideOwnDeclaration > 0) break; // early exit
  }

  if (usesOutsideOwnDeclaration === 0) {
    deadExports.push(exp);
  }
}

if (deadExports.length > 0) {
  console.error(`\n❌ Found ${deadExports.length} dead export(s) with zero usages in the repository:`);
  for (const d of deadExports) {
    console.error(`  - ${d.file}:${d.line} (${d.kind} ${d.name})`);
  }
  console.error("\nPlease remove or use these exports before committing.\n");
  process.exit(1);
} else {
  console.log(`✓ No dead exports found across ${allExports.length} production exports.`);
}
