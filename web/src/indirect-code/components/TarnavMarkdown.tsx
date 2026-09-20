/** TarnavMarkdown from tmp/md-bench/src/tarnav/TarnavMarkdown.tsx, used by
 * parity.html. Preserve its DOM/CSS, live block highlighting, icons, KaTeX,
 * gutters, copy controls, ragged-table and loose-code-span repairs.
 * Production additions: visibility/disclosure suspension, bounded feeding,
 * final flush, safe URLs and lifecycle cleanup for floating controls. */
import { createEffect, on, onCleanup, onMount, untrack } from "solid-js";
import { Portal, render } from "solid-js/web";
import { Attr, Token, parser, parser_end, parser_write, type Any_Renderer, type Parser } from "streaming-markdown";
import katex from "katex";
import { registry } from "virtual:icons";
import { commandIcon, fileIcon, hasFileIcon } from "../files";
import { escapeHtml, highlightCodeSync, languageForPath, preloadCodeHighlight } from "../utils/lang";
import { anchorFloat } from "../../floating";
import { useDisclosureActive } from "./Disclosure";

// Only trusted, build-time icon data is interpolated into SVG markup.
function iconSvg(name: string, size = 12): string {
  const d = registry[name];
  if (!d) return "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${d.width} ${d.height}" class="inline-block shrink-0" style="width:${size}px;height:${size}px" aria-hidden="true">${d.body}</svg>`;
}

function safeUrl(value: string, image: boolean): string | null {
  try {
    const url = new URL(value, location.href);
    return (image ? ["http:", "https:"] : ["http:", "https:", "mailto:", "tel:"]).includes(url.protocol) ? value : null;
  } catch { return null; }
}

// Rendered gutter/highlight markup must never become parser input or copy text.
const codeSource = new WeakMap<Element, string>();
const closedNodes = new WeakSet<Element>();
const highlightedAt = new WeakMap<Element, number>();
const sourceCode = (code: Element) => codeSource.get(code) ?? code.textContent ?? "";
const copyCode = (code: Element) => sourceCode(code).split("\n").map((line) => line.replace(/^\d+:/, "")).join("\n");

/* ------------------------------------------------------------------ */
/* Small classnames helper.      */
/* ------------------------------------------------------------------ */

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ */
/* Markdown theme class/attribute map.                                   */
/* ------------------------------------------------------------------ */

/**
 * Keep the parity renderer's class strings visible to Tailwind.
 * The legacy data-streamdown attributes remain CSS hooks only.
 */
const CLS: Record<string, string> = {
  "ordered-list": "ml-4 list-outside list-decimal whitespace-normal",
  "unordered-list": "ml-4 list-outside list-disc whitespace-normal",
  "list-item": "py-1",
  "horizontal-rule": "my-6 border-border",
  strong: "font-semibold",
  link: "wrap-anywhere font-medium text-primary underline",
  "heading-1": "mt-6 mb-2 font-semibold text-3xl",
  "heading-2": "mt-6 mb-2 font-semibold text-2xl",
  "heading-3": "mt-6 mb-2 font-semibold text-xl",
  "heading-4": "mt-6 mb-2 font-semibold text-lg",
  "heading-5": "mt-6 mb-2 font-semibold text-base",
  "heading-6": "mt-6 mb-2 font-semibold text-sm",
  table: "w-full border-collapse border border-border",
  "table-header": "bg-muted/80",
  "table-body": "divide-y divide-border bg-muted/40",
  "table-row": "border-border border-b",
  "table-header-cell": "whitespace-nowrap px-4 py-2 text-left font-semibold text-sm",
  "table-cell": "px-4 py-2 text-sm",
  blockquote: "my-4 border-muted-foreground/30 border-l-4 pl-4 text-muted-foreground italic",
  superscript: "text-sm",
  subscript: "text-sm",
  "inline-code": "rounded bg-muted px-1.5 py-0.5 font-mono text-sm",
  image: "max-w-full rounded-lg",
};

/** Token -> { tag, sd (data-streamdown value), cls (extra classes) }. */
function tagFor(token: number): { tag: string; sd?: string; cls?: string } | null {
  switch (token) {
    case Token.Blockquote: return { tag: "blockquote", sd: "blockquote", cls: CLS.blockquote };
    case Token.Paragraph: return { tag: "p" };
    case Token.Line_Break: return { tag: "br" };
    case Token.Rule: return { tag: "hr", sd: "horizontal-rule", cls: CLS["horizontal-rule"] };
    case Token.Heading_1: return { tag: "h1", sd: "heading-1", cls: CLS["heading-1"] };
    case Token.Heading_2: return { tag: "h2", sd: "heading-2", cls: CLS["heading-2"] };
    case Token.Heading_3: return { tag: "h3", sd: "heading-3", cls: CLS["heading-3"] };
    case Token.Heading_4: return { tag: "h4", sd: "heading-4", cls: CLS["heading-4"] };
    case Token.Heading_5: return { tag: "h5", sd: "heading-5", cls: CLS["heading-5"] };
    case Token.Heading_6: return { tag: "h6", sd: "heading-6", cls: CLS["heading-6"] };
    case Token.Italic_Ast:
    case Token.Italic_Und: return { tag: "em" };
    case Token.Strong_Ast:
    case Token.Strong_Und: return { tag: "span", sd: "strong", cls: CLS.strong };
    case Token.Strike: return { tag: "s" };
    case Token.Code_Inline: return { tag: "code", sd: "inline-code", cls: CLS["inline-code"] };
    case Token.Raw_URL:
    case Token.Link: return { tag: "a", sd: "link", cls: CLS.link };
    case Token.Image: return { tag: "img", sd: "image", cls: CLS.image };
    case Token.List_Unordered: return { tag: "ul", sd: "unordered-list", cls: CLS["unordered-list"] };
    case Token.List_Ordered: return { tag: "ol", sd: "ordered-list", cls: CLS["ordered-list"] };
    case Token.List_Item: return { tag: "li", sd: "list-item", cls: CLS["list-item"] };
    case Token.Checkbox: return { tag: "input" };
    case Token.Table: return { tag: "table", sd: "table", cls: CLS.table };
    case Token.Table_Row: return { tag: "tr", sd: "table-row", cls: CLS["table-row"] };
    case Token.Table_Cell: return { tag: "__cell" };
    case Token.Equation_Block: return { tag: "equation-block" };
    case Token.Equation_Inline: return { tag: "equation-inline" };
    case Token.Document: return null;
    default: return null;
  }
}

/* ------------------------------------------------------------------ */
/* DOM renderer over thetarnav tokens.               */
/* ------------------------------------------------------------------ */

interface TarnavRendererOptions {
  highlight?: boolean;
  fileIcons?: boolean;
}

interface NodeStack {
  nodes: Element[];
  index: number;
  dirty: Set<Element>;
  cleanup: (() => void)[];
}

/** Copy-button SVG (Lucide copy). */
const COPY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

function makeCopyButton(copyText: () => string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className =
    "flex size-7 items-center justify-center rounded-md border bg-background p-1 transition-colors hover:bg-muted";
  btn.setAttribute("data-rc-tip", "Copy table");
  btn.setAttribute("aria-label", "Copy table");
  btn.setAttribute("type", "button");
  btn.innerHTML = COPY_SVG;
  btn.addEventListener("click", () => {
    if (navigator.clipboard) navigator.clipboard.writeText(copyText()).catch(() => {});
  });
  return btn;
}

function makeRenderer(root: HTMLElement, opts: TarnavRendererOptions) {
  const data: NodeStack = { nodes: [root], index: 0, dirty: new Set(), cleanup: [] };

  function current(): Element {
    return data.nodes[data.index];
  }

  function push(el: Element) {
    // NOTE: capture parent BEFORE bumping the index — `current()` reads
    // data.nodes[data.index], so incrementing first would resolve the
    // (still empty) new slot and throw (same pattern as smd's renderer).
    const parent = current();
    data.nodes[++data.index] = parent.appendChild(el);
  }

  return {
    data,
    add_token(_data: unknown, token: number) {
      if (token === Token.Document) return;
      // Code fences use the parity page's CodeBlock DOM:
      // div.font-mono.text-[11px] > pre.whitespace-pre-wrap > code.tok —
      // Copy stays outside the scroller; there is no language header. The app's
      // .rc-markdown pre CSS provides padding/background/border, and the
      // CodeBlock max-h-56 keeps big blocks inside the balloon.
      // The fence language arrives later via set_attr(LANG) into
      // data-language (used by the highlight pass).
      if (token === Token.Code_Fence || token === Token.Code_Block) {
        const parent = current();
        // Outer wrapper: NOT scrollable, only anchors the absolute copy
        // button (a positioned child of a scrolling box would scroll away
        // and stretch the scroll area).
        const wrap = parent.appendChild(document.createElement("div"));
        wrap.className = "tarnav-codeblock";
        wrap.style.position = "relative";
        const container = wrap.appendChild(document.createElement("div"));
        container.className =
          "font-mono text-[11px] text-ink-300 overflow-x-auto overflow-y-auto select-text [scrollbar-gutter:stable] max-h-56";
        const pre = container.appendChild(document.createElement("pre"));
        pre.setAttribute("data-streamdown", "code-block");
        pre.className = "px-3 py-2 whitespace-pre-wrap";
        const code = pre.appendChild(document.createElement("code"));
        code.className = "tok";
        codeSource.set(code, "");
        if (opts.highlight !== false) code.setAttribute("data-hl", "");
        // Copy button: absolute in the wrapper (top-right, hover-revealed),
        // never inside the scroller and never inside the <pre> (copy text).
        // Inline styles (not Tailwind classes): the parity page reuses the
        // app's compiled CSS, which only contains classes the app itself
        // uses — arbitrary utility classes may not exist there.
        const copy = wrap.appendChild(document.createElement("button"));
        copy.className = "tarnav-copy";
        copy.style.position = "absolute";
        copy.style.top = "6px";
        copy.style.right = "6px";
        copy.style.zIndex = "10";
        copy.style.padding = "4px";
        copy.style.borderRadius = "6px";
        copy.style.color = "var(--ink-500)";
        copy.style.opacity = "0";
        copy.style.transition = "opacity .15s, color .15s, background-color .15s";
        copy.style.cursor = "pointer";
        copy.style.background = "transparent";
        copy.style.border = "none";
        copy.setAttribute("data-rc-tip", "Copy code");
        copy.setAttribute("aria-label", "Copy code");
        copy.setAttribute("type", "button");
        copy.setAttribute("tabindex", "0");
        copy.innerHTML = COPY_SVG;
        copy.addEventListener("mouseenter", () => {
          copy.style.color = "var(--ink-100)";
          copy.style.background = "color-mix(in srgb, var(--ink-700) 60%, transparent)";
        });
        copy.addEventListener("mouseleave", () => {
          copy.style.color = "var(--ink-500)";
          copy.style.background = "transparent";
        });
        // Hover-reveal owned by JS (no CSS dependency on the app's build).
        wrap.addEventListener("mouseenter", () => (copy.style.opacity = "1"));
        wrap.addEventListener("mouseleave", () => (copy.style.opacity = "0"));
        copy.addEventListener("focus", () => (copy.style.opacity = "1"));
        copy.addEventListener("blur", () => (copy.style.opacity = "0"));
        copy.addEventListener("click", (e) => {
          e.stopPropagation();
          if (navigator.clipboard)
            navigator.clipboard.writeText(copyCode(code)).catch(() => {});
        });
        data.nodes[++data.index] = code;
        return;
      }
      const spec = tagFor(token);
      if (!spec) return;
      // Table cells depend on the section (thead -> th, else td).
      if (spec.tag === "__cell") {
        const inHead = current().closest("thead") != null;
        const cell = document.createElement(inHead ? "th" : "td");
        cell.setAttribute("data-streamdown", inHead ? "table-header-cell" : "table-cell");
        cell.className = inHead ? CLS["table-header-cell"] : CLS["table-cell"];
        push(cell);
        return;
      }
      // Table rows need thead/tbody sections like the default renderer.
      if (token === Token.Table_Row) {
        const parent = current();
        let section: Element;
        if (parent.children.length === 0) {
          section = parent.appendChild(document.createElement("thead"));
          section.setAttribute("data-streamdown", "table-header");
          section.className = CLS["table-header"];
        } else if (parent.children.length === 1) {
          section = parent.appendChild(document.createElement("tbody"));
          section.setAttribute("data-streamdown", "table-body");
          section.className = CLS["table-body"];
        } else {
          section = parent.children[1];
        }
        const tr = document.createElement("tr");
        tr.setAttribute("data-streamdown", "table-row");
        tr.className = CLS["table-row"];
        data.nodes[++data.index] = section.appendChild(tr);
        return;
      }
      // Tables get a wrapper and controls row for copying and downloading.
      if (token === Token.Table) {
        const wrap = document.createElement("div");
        wrap.className = "my-4 flex flex-col space-y-2";
        wrap.setAttribute("data-streamdown", "table-wrapper");
        const controls = wrap.appendChild(document.createElement("div"));
        controls.className = "flex items-center justify-end gap-1";
        const copyBtn = controls.appendChild(
          makeCopyButton(() => {
            const tbl = wrap.querySelector("table");
            if (!tbl) return "";
            return [...tbl.querySelectorAll("tr")]
              .map((tr) =>
                [...tr.querySelectorAll("th,td")]
                  .map((c) => (c as HTMLElement).innerText.trim())
                  .join("\t")
              )
              .join("\n");
          })
        );
        copyBtn.setAttribute("data-table-copy", "");
        // Download dropdown (CSV/Markdown), like TableDownloadDropdown.
        const dlWrap = controls.appendChild(document.createElement("div"));
        dlWrap.style.position = "relative";
        const dlBtn = dlWrap.appendChild(document.createElement("button"));
        dlBtn.className =
          "flex size-7 items-center justify-center rounded-md border bg-background p-1 transition-colors hover:bg-muted";
        dlBtn.setAttribute("data-rc-tip", "Download table");
        dlBtn.setAttribute("aria-label", "Download table");
        dlBtn.setAttribute("type", "button");
        dlBtn.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>';
        const menu = document.createElement("div");
        menu.style.display = "none";
        menu.style.position = "absolute";

        menu.style.minWidth = "130px";
        menu.style.border = "1px solid var(--line)";
        menu.style.borderRadius = "8px";
        menu.style.background = "var(--elev)";
        menu.style.padding = "4px";
        let closeMenu: (() => void) | undefined;
        const hideMenu = () => { closeMenu?.(); closeMenu = undefined; menu.style.display = "none"; };
        data.cleanup.push(hideMenu);
        const tableData = (): string[][] => {
          const tbl = wrap.querySelector("table");
          if (!tbl) return [];
          return [...tbl.querySelectorAll("tr")].map((tr) =>
            [...tr.querySelectorAll("th,td")].map((c) =>
              (c as HTMLElement).innerText.trim()
            )
          );
        };
        const download = (format: "csv" | "md") => {
          const rows = tableData();
          if (!rows.length) return;
          let content: string;
          let mime: string;
          let ext: string;
          if (format === "md") {
            content =
              rows.map((r) => `| ${r.join(" | ")} |`).join("\n") +
              (rows.length > 1
                ? `\n| ${rows[0].map(() => "---").join(" | ")} |`
                : "");
            // header separator goes after the first row
            if (rows.length > 1) {
              const [h, ...rest] = rows;
              content = `| ${h.join(" | ")} |\n| ${h.map(() => "---").join(" | ")} |\n${rest.map((r) => `| ${r.join(" | ")} |`).join("\n")}`;
            }
            mime = "text/markdown";
            ext = "md";
          } else {
            content = rows
              .map((r) =>
                r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")
              )
              .join("\n");
            mime = "text/csv";
            ext = "csv";
          }
          const blob = new Blob([content], { type: mime });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `table.${ext}`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        };
        for (const [label, fmt] of [["CSV", "csv"], ["Markdown", "md"]] as const) {
          const item = menu.appendChild(document.createElement("button"));
          item.textContent = label;
          item.setAttribute("type", "button");
          item.style.display = "block";
          item.style.width = "100%";
          item.style.textAlign = "left";
          item.style.padding = "6px 8px";
          item.style.borderRadius = "6px";
          item.style.fontSize = "12px";
          item.addEventListener("click", () => {
            download(fmt);
            hideMenu();
          });
        }
        dlBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (closeMenu) { hideMenu(); return; }
          const portalHost = document.createElement("div");
          const disposePortal = render(() => <Portal>{menu}</Portal>, portalHost);
          menu.style.display = "block";
          const disposeFloat = anchorFloat(dlBtn, menu, { placement: "bottom-end", maxHeight: 300 });
          const outside = (event: MouseEvent) => { if (!menu.contains(event.target as Node)) hideMenu(); };
          const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { hideMenu(); dlBtn.focus(); } };
          document.addEventListener("click", outside);
          document.addEventListener("keydown", escape);
          closeMenu = () => {
            disposeFloat(); disposePortal();
            document.removeEventListener("click", outside);
            document.removeEventListener("keydown", escape);
          };
        });
        const scroller = wrap.appendChild(document.createElement("div"));
        scroller.className = "overflow-x-auto";
        const table = scroller.appendChild(document.createElement("table"));
        table.setAttribute("data-streamdown", "table");
        table.className = CLS.table;
        current().appendChild(wrap);
        data.nodes[++data.index] = table;
        return;
      }
      const el = document.createElement(spec.tag);
      if (spec.sd) el.setAttribute("data-streamdown", spec.sd);
      if (spec.cls) el.className = spec.cls;
      if (spec.tag === "a") {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
      if (spec.tag === "img") {
        el.setAttribute("loading", "lazy");
        el.setAttribute("decoding", "async");
      }
      if (spec.tag === "input") {
        (el as HTMLInputElement).type = "checkbox";
        (el as HTMLInputElement).disabled = true;
      }
      push(el);
    },
    end_token() {
      // Pop one level, but never above the root (mirrors default renderer
      // semantics; guards against unbalanced streams mid-chunk).
      if (data.index > 0) {
        closedNodes.add(current()); data.dirty.add(current());
        data.index -= 1;
      }
    },
    add_text(_data: unknown, text: string) {
      const el = current();
      if (el.tagName === "CODE" && el.hasAttribute("data-hl")) codeSource.set(el, sourceCode(el) + text);
      if (el.tagName === "IMG") { (el as HTMLImageElement).alt += text; return; }
      const last = el.lastChild;
      if (last?.nodeType === Node.TEXT_NODE) (last as Text).appendData(text);
      else el.appendChild(document.createTextNode(text));
      data.dirty.add(el);
      // Tag code nodes touched by this push so the "block" strategy can
      // highlight/icons ONLY what changed (instead of the whole document).
      if (el.tagName === "CODE") el.setAttribute("data-dirty", "1");
    },
    set_attr(_data: unknown, type: number, value: string) {
      const el = current();
      // set_attr also mutates content (latex, href, lang) — tag dirty so the
      // "block" strategy picks it up (equations never see add_text).
      el.setAttribute("data-dirty", "1");
      data.dirty.add(el);
      if ((type === Attr.Href || type === Attr.Src) && safeUrl(value, type === Attr.Src) === null) return;
      if (type === Attr.Href && el.tagName === "A") el.setAttribute("href", value);
      else if (type === Attr.Src && el.tagName === "IMG") el.setAttribute("src", value);
      else if (type === Attr.Lang) {
        // thetarnav reports the fence language as `class`; keep it as
        // data-language on the pre (highlight pass reads it). The `tok`
        // class on code must survive (hljs structural classes).
        const code = el.tagName === "CODE" ? el : null;
        if (code) {
          if (value) code.setAttribute("data-lang", value);
          const pre = code.parentElement;
          if (pre && pre.tagName === "PRE") pre.setAttribute("data-language", value);
        } else el.setAttribute("class", value);
      } else if (type === Attr.Checked && el.tagName === "INPUT") {
        (el as HTMLInputElement).checked = true;
        el.setAttribute("checked", "");
      } else if (type === (Attr as unknown as Record<string, number>).Start) {
        el.setAttribute("start", value);
      }
    },
  } satisfies Any_Renderer;
}

/* ------------------------------------------------------------------ */
/* Post-pass: KaTeX equations + code highlight + file/command icons.    */
/* Runs once per render frame, only on nodes changed by that frame.    */
/* ------------------------------------------------------------------ */

function katexOne(host: HTMLElement) {
  // Input/output separation: thetarnav streams latex as raw text nodes;
  // after the first render the output <span> lives in the same element, so
  // textContent is NOT a stable input (it includes rendered KaTeX text and
  // would re-trigger every push). Instead seed data-latex once and only
  // append NEW raw text nodes arrived since the last render.
  let seed = host.getAttribute("data-latex");
  if (seed == null) {
    seed = host.textContent ?? "";
    if (!seed.trim()) return;
    host.setAttribute("data-latex", seed);
  } else {
    let extra = "";
    for (const n of host.childNodes) {
      if (n.nodeType === 3) extra += n.textContent ?? "";
    }
    if (extra) seed = seed + extra;
  }
  const tex = seed;
  if (!tex.trim()) return;
  if (host.getAttribute("data-katex-tex") === tex) return;
  host.setAttribute("data-latex", tex);
  host.setAttribute("data-katex-tex", tex);
  // Drop consumed raw text nodes (keep only the rendered span + future input).
  for (const n of [...host.childNodes]) {
    if (n.nodeType === 3) host.removeChild(n);
  }
  // NOTE: no data-katex-done flag — data-katex-tex IS the guard.
  const span = document.createElement("span");
  span.className = "katex-holder";
  host.replaceChildren(span);
  try {
    katex.render(tex, span, {
      throwOnError: false,
      displayMode: host.tagName === "EQUATION-BLOCK",
    });
  } catch {
    span.textContent = tex;
  }
}

/** Map a fence language to an hljs id (same rules as the app's CodeBlock). */
function hljsLang(fenceLang: string): string | undefined {
  const l = fenceLang.toLowerCase();
  if (!l) return undefined;
  return (
    languageForPath(`file.${l}`) ??
    (l === "ts" ? "typescript"
    : l === "js" ? "javascript"
    : l === "yml" ? "yaml"
    : l === "shell" || l === "sh" ? "bash"
    : l === "c++" ? "cpp"
    : l === "c#" ? "csharp"
    : l)
  );
}

/**
 * Put highlighted HTML into the fence <code>, adding the gutter when lines
 * carry `<number>:` prefixes (same split as the app's CodeBlock).
 */
function applyCodeHtml(code: HTMLElement, text: string, html: string) {
  const lines = text.split("\n");
  const hasGutter = lines.some((l) => /^\d+:/.test(l));
  if (!hasGutter) {
    code.innerHTML = html;
    return;
  }
  const htmlLines = html.split("\n");
  const rows = lines.map((line, i) => {
    const m = line.match(/^(\d+):(.*)$/);
    const num = m ? m[1] : "";
    const cell = htmlLines[i] || escapeHtml(m ? m[2] : line);
    return `<div class="flex items-start px-2 py-0.5 leading-relaxed whitespace-pre hover:bg-surface/30"><span class="select-none text-right font-mono text-[10px] text-ink-600/50 min-w-[2.25rem] shrink-0 pr-2 border-r border-line/25 mr-2">${num}</span><code class="tok flex-1">${cell || " "}</code></div>`;
  });
  code.innerHTML = rows.join("");
}

/**
 * File/command icon for one inline <code>.
 * The <svg> is injected as a DIRECT child so the app CSS
 * `[data-streamdown="inline-code"] > svg` (baseline align + margin) applies.
 */
function iconOne(code: HTMLElement) {
  const text = code.textContent ?? "";
  if (code.getAttribute("data-icon-text") === text) return;
  code.setAttribute("data-icon-text", text);
  // Strip a previously injected icon (re-run on changed text).
  const old = code.querySelector(":scope > svg[data-file-icon]");
  if (old) old.remove();
  code.removeAttribute("data-cmd");
  code.removeAttribute("data-file");
  const cmd = commandIcon(text);
  if (cmd) {
    code.setAttribute("data-cmd", text.trim().split(/\s+/)[0]);
    code.insertAdjacentHTML("afterbegin", iconSvg(cmd.icon));
    code.firstElementChild?.setAttribute("data-file-icon", "");
    return;
  }
  if (!hasFileIcon(text)) return;
  const name = text.trim().split(/[\\/]/).pop() || text.trim();
  const spec = fileIcon(name);
  code.setAttribute("data-file", name);
  code.insertAdjacentHTML("afterbegin", iconSvg(spec.icon));
  // Tone class on the svg (iconSvg emits inline-block shrink-0).
  const svg = code.querySelector(":scope > svg");
  if (svg) { svg.setAttribute("class", `inline-block shrink-0 ${spec.class}`); svg.setAttribute("data-file-icon", ""); }
}

/** Match the header width once a row closes; never rescan old table rows. */
function normalizeTableRow(row: Element) {
  if (row.parentElement?.tagName === "THEAD") return;
  const cols = row.closest("table")?.querySelector("thead tr")?.children.length ?? 0;
  if (!cols) return;
  while (row.children.length < cols) {
    const td = document.createElement("td");
    td.setAttribute("data-streamdown", "table-cell");
    td.className = CLS["table-cell"];
    row.appendChild(td);
  }
  while (row.children.length > cols) row.removeChild(row.lastElementChild!);
}

/**
 * Fix leaked inline-code spans: thetarnav opens a code span on ANY backtick
 * run (``` mid-sentence included) and never backtracks when it doesn't
 * close, so the whole tail lands inside one giant chip. A well-formed
 * single-backtick span can never contain its own delimiter, so a chip
 * containing a backtick is a leak.
 *
 * Instead of blindly unwrapping, RE-PARSE the leaked text: split on
 * backticks and rebuild — odd segments become real inline-code chips
 * (`inline code` stays a chip), even segments become plain text. Chips
 * without any backtick (e.g. a leaked multi-line span) unwrap to text.
 *
 * Known cost: the opening ``` run itself was consumed by the parser and is
 * not recoverable, so it is not re-emitted.
 */
function unwrapBogusInlineCode(root: ParentNode) {
  const codes =
    root instanceof Element && root.matches('code[data-streamdown="inline-code"]')
      ? [root as HTMLElement]
      : [...(root as HTMLElement).querySelectorAll('code[data-streamdown="inline-code"]')];
  for (const code of codes) {
    if (!closedNodes.has(code)) continue;
    const text = code.textContent ?? "";
    if (!text.includes("`") && !text.includes("\n")) continue;
    const parent = code.parentElement;
    if (!parent) continue;
    const frag = document.createDocumentFragment();
    const parts = text.split("`");
    if (parts.length >= 3) {
      parts.forEach((part, i) => {
        if (i % 2 === 1) {
          if (!part) return;
          const chip = document.createElement("code");
          chip.setAttribute("data-streamdown", "inline-code");
          chip.setAttribute("data-dirty", "1");
          chip.className = CLS["inline-code"];
          chip.textContent = part;
          iconOne(chip);
          frag.appendChild(chip);
        } else if (part) {
          frag.appendChild(document.createTextNode(part));
        }
      });
    } else if (text) {
      frag.appendChild(document.createTextNode(text));
    }
    parent.replaceChild(frag, code);
  }
}

/** Same live block strategy as parity.html, using the renderer's dirty set
 * instead of querying every previous code fence after each chunk. */
function postPassSync(host: HTMLElement, opts: TarnavRendererOptions, data: NodeStack) {
  const dirties = [...data.dirty];
  let retryIn = Infinity;
  data.dirty.clear();
  for (const el of dirties) {
    if (!host.contains(el)) continue;
    if (el.tagName === "EQUATION-INLINE" || el.tagName === "EQUATION-BLOCK") katexOne(el as HTMLElement);
    else if (el.matches("code[data-hl]") && opts.highlight !== false) {
      const code = el as HTMLElement;
      const text = sourceCode(code);
      // Keep large fences live without repeatedly highlighting their entire
      // growing source at display refresh rate. Completion always flushes.
      const remaining = 120 - (performance.now() - (highlightedAt.get(code) ?? -Infinity));
      if (text.length > 16384 && !closedNodes.has(code) && remaining > 0) {
        data.dirty.add(code); retryIn = Math.min(retryIn, remaining); continue;
      }
      const html = highlightCodeSync(copyCode(code), hljsLang(code.parentElement?.getAttribute("data-language") ?? ""));
      if (html != null) { applyCodeHtml(code, text, html); highlightedAt.set(code, performance.now()); }
      else data.dirty.add(el); // The initial async language load retries this set.
    } else if (el.matches('code[data-streamdown="inline-code"]')) {
      unwrapBogusInlineCode(el);
      if (opts.fileIcons !== false && host.contains(el)) iconOne(el as HTMLElement);
    } else if (el.tagName === "TR" && closedNodes.has(el)) {
      normalizeTableRow(el);
    }
    el.removeAttribute("data-dirty");
  }
  return retryIn;
}

/* ------------------------------------------------------------------ */
/* Component.                                                          */
/* ------------------------------------------------------------------ */

export interface TarnavMarkdownProps {
  children?: string;
  class?: string;
  /** The transcript already owns the rc-markdown typography container. */
  embedded?: boolean;
  mode?: "full" | "mini" | "toolsearch" | "compact";
  streaming?: boolean;
  active?: boolean;
}

export function TarnavMarkdown(props: TarnavMarkdownProps) {
  const disclosureActive = useDisclosureActive();
  let host!: HTMLDivElement;
  let view: ReturnType<typeof makeRenderer> | undefined;
  let p: Parser | undefined;
  let fed = "";
  let ended = false;
  let frame = 0;
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;
  let mounted = false;
  const opts: TarnavRendererOptions = { highlight: true, fileIcons: true };
  const visible = () => !document.hidden && disclosureActive() && props.active !== false;
  function disposeView() { for (const dispose of view?.data.cleanup ?? []) dispose(); }
  function reset() {
    disposeView(); host.replaceChildren();
    view = makeRenderer(host, opts); p = parser(view); fed = ""; ended = false;
  }
  function update() {
    frame = 0;
    clearTimeout(highlightTimer); highlightTimer = undefined;
    if (!mounted || !visible()) return;
    const full = props.children || "";
    if (!p || !full.startsWith(fed) || (ended && full !== fed)) reset();
    const end = Math.min(full.length, fed.length + 8192);
    if (end > fed.length) parser_write(p!, full.slice(fed.length, end));
    fed = full.slice(0, end);
    if (end === full.length && !props.streaming && !ended) {
      parser_end(p!);
      for (const el of view!.data.nodes.slice(1, view!.data.index + 1)) {
        closedNodes.add(el); view!.data.dirty.add(el);
      }
      ended = true;
    }
    const retryIn = postPassSync(host, opts, view!.data);
    if (end < full.length) schedule();
    else if (Number.isFinite(retryIn)) highlightTimer = setTimeout(schedule, retryIn);
  }
  function schedule() { if (!frame && visible()) frame = requestAnimationFrame(() => untrack(update)); }
  createEffect(on(() => [props.children, props.streaming, props.active, disclosureActive()], () => {
    if (mounted) schedule();
  }));
  onMount(() => {
    mounted = true; schedule();
    void preloadCodeHighlight().then(() => { if (mounted) schedule(); });
    document.addEventListener("visibilitychange", schedule);
  });
  onCleanup(() => {
    mounted = false; cancelAnimationFrame(frame); clearTimeout(highlightTimer); disposeView();
    document.removeEventListener("visibilitychange", schedule);
  });
  return <div ref={(el) => (host = el)} class={cn(!props.embedded && "rc-markdown", props.class)}
    data-tarnav-markdown={props.mode ?? "full"} data-streaming-markdown />;
}
