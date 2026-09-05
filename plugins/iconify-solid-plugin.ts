import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { BunPlugin } from "bun";

const VIRTUAL_MODULE_ID = "virtual:icons";
const REGISTRY_FILE = ".cache/iconify/registry.js";

interface IconData {
  body: string;
  height: number;
  width: number;
}

interface IconifyIcon {
  body: string;
  height?: number;
  hidden?: boolean;
  width?: number;
}

interface IconifyAlias {
  parent: string;
}

interface IconifyJSON {
  aliases?: Record<string, IconifyAlias>;
  height?: number;
  icons: Record<string, IconifyIcon>;
  info?: {
    height?: number;
    palette?: boolean;
    width?: number;
  };
  prefix: string;
  width?: number;
}

const collectionCache = new Map<string, IconifyJSON>();
const collectedIcons = new Map<string, IconData>();
const failedCollections = new Set<string>();

function loadCollection(collection: string): IconifyJSON | null {
  if (collectionCache.has(collection)) return collectionCache.get(collection)!;
  if (failedCollections.has(collection)) return null;

  const paths = [
    `@iconify-json/${collection}/icons.json`,
    `@iconify/json/json/${collection}.json`,
  ];

  for (const p of paths) {
    try {
      const resolvedPath = require.resolve(p);
      const data = JSON.parse(readFileSync(resolvedPath, "utf-8")) as IconifyJSON;
      collectionCache.set(collection, data);
      return data;
    } catch {}
  }

  failedCollections.add(collection);
  return null;
}

function resolveIcon(
  data: IconifyJSON,
  iconName: string,
  visited = new Set<string>(),
): IconifyIcon | null {
  if (visited.has(iconName)) return null;
  visited.add(iconName);

  const direct = data.icons[iconName];
  if (direct) {
    return direct.hidden ? null : direct;
  }

  const alias = data.aliases?.[iconName];
  if (alias?.parent) {
    return resolveIcon(data, alias.parent, visited);
  }

  return null;
}

function getIconData(name: string): IconData | null {
  const parts = name.split(":");
  if (parts.length !== 2) return null;
  const [collection, iconName] = parts;

  const data = loadCollection(collection);
  if (!data) return null;

  const icon = resolveIcon(data, iconName);
  if (!icon) return null;

  return {
    body: icon.body,
    height: icon.height ?? data.height ?? data.info?.height ?? 24,
    width: icon.width ?? data.width ?? data.info?.width ?? 24,
  };
}

const ALL_ICONS_REGEX = /["']([a-z][a-z0-9-]*:[a-z0-9][a-z0-9-]*)["']/gi;

function collectIconsFromCode(code: string): boolean {
  let foundNew = false;
  const matches = code.matchAll(ALL_ICONS_REGEX);
  for (const match of matches) {
    const name = match[1] || "";
    if (!collectedIcons.has(name)) {
      const data = getIconData(name);
      if (data) {
        collectedIcons.set(name, data);
        foundNew = true;
      }
    }
  }
  return foundNew;
}

function collectIconsFromDir(dir: string): void {
  if (!existsSync(dir)) return;

  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      if (/^(node_modules|dist|\.git|\.cache)$/.test(entry)) continue;
      collectIconsFromDir(fullPath);
    } else if (/\.[jt]sx?$/.test(entry)) {
      try {
        const content = readFileSync(fullPath, "utf-8");
        if (content.includes(":")) {
          collectIconsFromCode(content);
        }
      } catch {}
    }
  }
}

function generateRegistryModule(): string {
  const entries = Array.from(collectedIcons.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, data]) => `  "${name}": ${JSON.stringify(data)}`)
    .join(",\n");

  return `export const registry = {
${entries}
};
export default registry;
`;
}

function writeRegistryFile(cwd: string): void {
  const filePath = join(cwd, REGISTRY_FILE);
  const content = generateRegistryModule();

  mkdirSync(dirname(filePath), { recursive: true });
  try {
    const existing = readFileSync(filePath, "utf-8");
    if (existing === content) return;
  } catch {}

  writeFileSync(filePath, content);
  console.log(`[iconify-solid] Inlined ${collectedIcons.size} icons into registry`);
}

/**
 * SolidJS-compatible Iconify Bun Plugin.
 * Scans directories, extracts icons from @iconify-json/* packages at build-time,
 * and resolves `virtual:icons` WITHOUT hijacking JSX/TSX loaders.
 * This guarantees Babel 7 + babel-preset-solid runs cleanly on all SolidJS components!
 */
export function iconifySolidPlugin(options: { dirs?: string[] } = {}): BunPlugin {
  const cwd = process.cwd();
  const dirs = options.dirs && options.dirs.length > 0
    ? options.dirs.map((d) => resolve(cwd, d))
    : [resolve(cwd, "web/src")];

  collectedIcons.clear();
  collectionCache.clear();
  failedCollections.clear();

  for (const dir of dirs) {
    collectIconsFromDir(dir);
  }

  writeRegistryFile(cwd);

  return {
    name: "iconify-solid",
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${VIRTUAL_MODULE_ID}$`) }, () => {
        return {
          path: resolve(cwd, REGISTRY_FILE),
        };
      });
    },
  };
}

export default iconifySolidPlugin();
