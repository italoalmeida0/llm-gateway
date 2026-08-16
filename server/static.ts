import { existsSync, statSync } from "fs";
import path from "path";

import { baseHeaders } from "./http";

/**
 * Static file serving for the built dashboard (dist/). Hardened against path
 * traversal: the URL path is percent-decoded, normalized, and must stay inside
 * the static root; dotfiles and directories are never served directly.
 */

const STATIC_ROOT = path.resolve(process.env.STATIC_DIR || path.join(import.meta.dir, "..", "dist"));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const IMMUTABLE_EXT = new Set([".js", ".css", ".woff", ".woff2", ".png", ".jpg", ".webp", ".svg", ".ico"]);

/** Resolve a URL path to a file inside STATIC_ROOT, or null when unsafe/missing. */
export function resolveStaticFile(urlPath: string): { filePath: string; isHtml: boolean } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  // Strip leading slashes BEFORE normalizing so the path is always relative;
  // then it must remain confined to the static root.
  const stripped = decoded.replace(/^\/+/, "");
  const normalized = path.normalize(stripped);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) return null;
  const fullPath = path.join(STATIC_ROOT, normalized);
  if (!fullPath.startsWith(STATIC_ROOT + path.sep) && fullPath !== STATIC_ROOT) return null;

  const segments = normalized.split(path.sep);
  if (segments.some((s) => s.startsWith("."))) return null; // no dotfiles
  // Source maps are build artifacts, never dashboard assets — they would
  // publish the entire frontend source. Refuse to serve them even if they
  // end up in the static root.
  if (normalized.endsWith(".map")) return null;

  let finalPath = fullPath;
  if (!existsSync(finalPath) || statSync(finalPath).isDirectory()) {
    // SPA fallback: extension-less GET paths render the dashboard shell.
    if (path.extname(normalized) === "") {
      const indexPath = path.join(STATIC_ROOT, "index.html");
      if (!existsSync(indexPath)) return null;
      finalPath = indexPath;
    } else {
      return null;
    }
  }

  return { filePath: finalPath, isHtml: finalPath.endsWith(".html") };
}

export function serveStatic(req: Request, urlPath: string): Response | null {
  if (!existsSync(STATIC_ROOT)) return null;
  const resolved = resolveStaticFile(urlPath === "/" ? "/index.html" : urlPath);
  if (!resolved) return null;

  const file = Bun.file(resolved.filePath);
  if (file.size === 0 && !resolved.isHtml) return null;

  const headers = baseHeaders(req, resolved.isHtml);
  headers.set("Content-Type", MIME[path.extname(resolved.filePath).toLowerCase()] ?? "application/octet-stream");
  // Hashed build artifacts can be cached forever; HTML always revalidates.
  headers.set(
    "Cache-Control",
    resolved.isHtml ? "no-cache" : IMMUTABLE_EXT.has(path.extname(resolved.filePath)) ? "public, max-age=31536000, immutable" : "public, max-age=300",
  );

  return new Response(file, { status: 200, headers });
}
