/**
 * Lightweight token highlighter on top of highlight.js (already a runtime
 * dep — no new libs). `languageForPath` maps a file extension to an hljs
 * language id; `highlightCode` returns HTML for <CodeBlock> (auto-detect
 * for diffs and extension-less files). Theme-agnostic: keep classes
 * structural (`tok-…`) and map them to CSS vars in the stylesheet so
 * white/dark flip for free.
 */
export function languageForPath(name?: string): string | undefined {
  if (!name) return undefined;
  const base = String(name).replace(/\\/g, "/").split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
    case "jsonc":
      return "json";
    case "py":
    case "pyi":
      return "python";
    case "rs":
      return "rust";
    case "go":
      return "go";
    case "rb":
      return "ruby";
    case "java":
    case "kt":
    case "kts":
      return "java";
    case "c":
    case "h":
    case "cc":
    case "cpp":
    case "hpp":
    case "cxx":
      return "cpp";
    case "cs":
      return "csharp";
    case "php":
      return "php";
    case "swift":
      return "swift";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "html":
    case "htm":
    case "vue":
    case "svelte":
      return "xml";
    case "md":
    case "mdx":
    case "markdown":
      return "markdown";
    case "yml":
    case "yaml":
      return "yaml";
    case "toml":
    case "ini":
    case "cfg":
    case "env":
      return "ini";
    case "sh":
    case "bash":
    case "zsh":
      return "bash";
    case "sql":
      return "sql";
    case "xml":
    case "svg":
    case "plist":
      return "xml";
    case "diff":
    case "patch":
      return "diff";
    case "dockerfile":
      return "dockerfile";
    case "graphql":
    case "gql":
      return "graphql";
    case "lua":
      return "lua";
    case "r":
      return "r";
    case "scala":
      return "scala";
    case "dart":
      return "dart";
    case "ex":
    case "exs":
      return "elixir";
    case "hs":
      return "haskell";
    // "tf" → hcl: highlight.js has no hcl in the loaded bundle, so it
    // falls through to auto-detect.
    default:
      return undefined;
  }
}

/** hljs → our structural classes (mapped to theme vars in the stylesheet). */
const HLJS_CLASS_MAP: Array<[RegExp, string]> = [
  [/^hljs-keyword$/, "tok-kw"],
  [/^hljs-built_in$/, "tok-builtin"],
  [/^hljs-type$/, "tok-type"],
  [/^hljs-literal$/, "tok-lit"],
  [/^hljs-number$/, "tok-num"],
  [/^hljs-string$/, "tok-str"],
  [/^hljs-regexp$/, "tok-regex"],
  [/^hljs-comment$/, "tok-com"],
  [/^hljs-doctag$/, "tok-doc"],
  [/^hljs-title function_$/, "tok-fn"],
  [/^hljs-title class_$/, "tok-class"],
  [/^hljs-title$/, "tok-title"],
  [/^hljs-params$/, "tok-params"],
  [/^hljs-variable$/, "tok-var"],
  [/^hljs-name$/, "tok-name"],
  [/^hljs-attr$/, "tok-attr"],
  [/^hljs-attribute$/, "tok-attr"],
  [/^hljs-selector-/, "tok-sel"],
  [/^hljs-operator$/, "tok-op"],
  [/^hljs-punctuation$/, "tok-punct"],
  [/^hljs-meta/, "tok-meta"],
  [/^hljs-addition$/, "tok-add"],
  [/^hljs-deletion$/, "tok-del"],
];

let hljsPromise: Promise<any> | null = null;
async function getHljs(): Promise<any> {
  hljsPromise ??= import("highlight.js/lib/common").then((mod) => mod.default);
  return hljsPromise;
}

function mapHljsClasses(html: string): string {
  return html.replace(/class="([^"]*)"/g, (_m, cls: string) => {
    const mapped = cls
      .split(/\s+/)
      .map((c) => {
        if (c === "hljs") return "tok";
        for (const [re, out] of HLJS_CLASS_MAP) {
          if (re.test(cls) && c !== "hljs") {
            if (re.source === "^hljs-title function_$" && c === "title") return "tok-fn";
            if (re.source === "^hljs-title class_$" && c === "title") return "tok-class";
            if (re.source === "^hljs-meta" && c === "meta") return "tok-meta";
            if (re.source === "^hljs-title$" && c === "title") return out;
            if (re.test(c)) return out;
          }
        }
        return c;
      })
      .join(" ");
    return `class="${mapped}"`;
  });
}

export async function highlightCode(text: string, language?: string): Promise<string> {
  const src = text || "";
  const hljs = await getHljs();
  let html: string;
  if (language && typeof hljs.getLanguage === "function" && hljs.getLanguage(language)) {
    html = hljs.highlight(src, { language, ignoreIllegals: true }).value;
  } else if (typeof hljs.highlightAuto === "function") {
    html = hljs.highlightAuto(src).value;
  } else {
    html = src
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  return mapHljsClasses(html);
}

/**
 * Escapes raw text to HTML. Used as a stopgap identity "highlight" so raw
 * tool/file output renders identically until the async highlighter resolves.
 */
export function escapeHtml(src: string): string {
  return (src || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
