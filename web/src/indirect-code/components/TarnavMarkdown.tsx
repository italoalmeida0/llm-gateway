/** TarnavMarkdown from tmp/md-bench/src/tarnav/TarnavMarkdown.tsx, used by
 * parity.html. Preserve its DOM/CSS, live block highlighting, icons, KaTeX,
 * gutters, copy controls, ragged-table and loose-code-span repairs.
 * Production additions: visibility/disclosure suspension, bounded feeding,
 * final flush, safe URLs and compact controls. */
import { createEffect, on, onCleanup, onMount, untrack } from "solid-js";
import { Attr, Token, parser, parser_end, parser_write, type Any_Renderer, type Parser } from "streaming-markdown";
import katex from "katex";
import { registry } from "virtual:icons";
import { commandIcon, fileIcon, hasFileIcon } from "../files";
import { escapeHtml, highlightCodeSync, languageForPath, preloadCodeHighlight } from "../utils/lang";
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
const validCodeSpans = new WeakSet<Element>();
const tableAlignments = new WeakMap<Element, string[]>();
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
  parser?: Parser;
  nodes: Element[];
  index: number;
  dirty: Set<Element>;
  cleanup: (() => void)[];
}

/** Copy-button SVG (Lucide copy). */
const COPY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

const CHECK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';

function makeCopyButton(copyText: () => string, label: string, cleanup: (() => void)[]): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "rc-markdown-control";
  btn.setAttribute("data-rc-tip", label);
  btn.setAttribute("aria-label", label);
  btn.setAttribute("type", "button");
  const icon = btn.appendChild(document.createElement("span"));
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = COPY_SVG;
  const status = btn.appendChild(document.createElement("span"));
  status.className = "sr-only";
  status.setAttribute("role", "status");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let attempt = 0;
  cleanup.push(() => { disposed = true; clearTimeout(timer); });
  btn.addEventListener("click", async (event) => {
    event.stopPropagation();
    const current = ++attempt;
    let success = false;
    try { await navigator.clipboard.writeText(copyText()); success = true; } catch { /* Show feedback below. */ }
    if (disposed || current !== attempt) return;
    clearTimeout(timer);
    btn.dataset.copyState = success ? "copied" : "error";
    icon.innerHTML = success ? CHECK_SVG : COPY_SVG;
    status.textContent = success ? "Copied to clipboard" : "Copy failed. Try again.";
    btn.setAttribute("data-rc-tip", success ? "Copied" : "Copy failed. Try again.");
    timer = setTimeout(() => {
      delete btn.dataset.copyState; icon.innerHTML = COPY_SVG;
      status.textContent = ""; btn.setAttribute("data-rc-tip", label);
    }, 1800);
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
      // Copy and the language label stay in a compact header. The app's
      // wrapper owns the border/background so scroll clipping keeps rounded
      // corners; CodeBlock max-h-56 keeps big blocks inside the balloon.
      // The fence language arrives later via set_attr(LANG) into
      // data-language (used by the highlight pass).
      if (token === Token.Code_Fence || token === Token.Code_Block) {
        const parent = current();
        // Outer wrapper keeps the header outside the scrolling code body.
        const wrap = parent.appendChild(document.createElement("div"));
        wrap.className = "tarnav-codeblock";
        wrap.style.position = "relative";
        const header = wrap.appendChild(document.createElement("div"));
        header.className = "tarnav-code-header";
        const language = header.appendChild(document.createElement("span"));
        language.className = "tarnav-code-language";
        language.textContent = "code";
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
        // The copy control is anchored outside both scroll axes.
        const copy = header.appendChild(makeCopyButton(() => copyCode(code), "Copy code", data.cleanup));
        copy.classList.add("tarnav-copy");
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
        const table = current().closest("table");
        const align = table && tableAlignments.get(table)?.[current().children.length];
        if (align) cell.setAttribute("align", align);
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
        wrap.className = "rc-table-wrap";
        wrap.setAttribute("data-streamdown", "table-wrapper");
        const scroller = wrap.appendChild(document.createElement("div"));
        scroller.className = "rc-table-scroll overflow-x-auto";
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
        const state = data.parser;
        if (current().matches('code[data-streamdown="inline-code"]') && state &&
            state.pending.trim().length === state.fence_start && /^ *`+$/.test(state.pending)) validCodeSpans.add(current());
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
          if (pre && pre.tagName === "PRE") pre.setAttribute("data-language", value.trim());
          const label = code.closest(".tarnav-codeblock")?.querySelector(".tarnav-code-language");
          if (label) label.textContent = value.trim() || "code";
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
  const table = row.closest("table");
  const cols = table?.querySelector("thead tr")?.children.length ?? 0;
  if (!cols) return;
  while (row.children.length < cols) {
    const td = document.createElement("td");
    td.setAttribute("data-streamdown", "table-cell");
    td.className = CLS["table-cell"];
    const align = table && tableAlignments.get(table)?.[row.children.length];
    if (align) td.setAttribute("align", align);
    row.appendChild(td);
  }
  while (row.children.length > cols) row.removeChild(row.lastElementChild!);
}

/**
 * Fix leaked inline-code spans: thetarnav opens a code span on ANY backtick
 * run (``` mid-sentence included) and never backtracks when it doesn't
 * close, so the whole tail lands inside one giant chip. Properly closed
 * spans can contain shorter/longer backtick runs and must remain untouched.
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
    if (!closedNodes.has(code) || validCodeSpans.has(code)) continue;
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

/** GitHub-style callouts: only rewrite the marker, retaining streamed body nodes. */
function decorateCallout(paragraph: Element) {
  const quote = paragraph.parentElement;
  if (quote?.tagName !== "BLOCKQUOTE" || quote.dataset.callout || quote.firstElementChild !== paragraph) return;
  const first = paragraph.firstChild;
  // The parser represents unresolved [labels] as anchors without href.
  // Wait for the following line so the marker cannot still become a link.
  const anchor = first instanceof HTMLAnchorElement && !first.hasAttribute("href") && first.nextSibling?.nodeName === "BR";
  const marker = anchor
    ? first.textContent?.match(/^!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)$/)
    : first?.nodeType === Node.TEXT_NODE ? first.textContent?.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s|$)/) : null;
  if (!marker) return;
  if (anchor) { first.nextSibling?.remove(); first.remove(); }
  else (first as Text).deleteData(0, marker[0].length);
  quote.dataset.callout = marker[1].toLowerCase();
  const label = document.createElement("div");
  label.className = "rc-callout-label";
  label.textContent = marker[1];
  quote.prepend(label);
}

/** Same live block strategy as parity.html, using the renderer's dirty set
 * instead of querying every previous code fence after each chunk. */
function postPassSync(host: HTMLElement, opts: TarnavRendererOptions, data: NodeStack) {
  const dirties = [...data.dirty];
  let retryIn = Infinity;
  data.dirty.clear();
  for (const el of dirties) {
    if (!host.contains(el)) continue;
    if (el.tagName === "P") decorateCallout(el);
    else if (el.tagName === "EQUATION-INLINE" || el.tagName === "EQUATION-BLOCK") katexOne(el as HTMLElement);
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
  let previousCR = false;
  let sourceLine = "";
  let ended = false;
  let frame = 0;
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;
  let mounted = false;
  const opts: TarnavRendererOptions = { highlight: true, fileIcons: true };
  const visible = () => !document.hidden && disclosureActive() && props.active !== false;
  function disposeView() { for (const dispose of view?.data.cleanup ?? []) dispose(); }
  function reset() {
    disposeView(); host.replaceChildren();
    view = makeRenderer(host, opts); p = parser(view); view.data.parser = p; fed = ""; previousCR = false; sourceLine = ""; ended = false;
  }
  function update() {
    frame = 0;
    clearTimeout(highlightTimer); highlightTimer = undefined;
    if (!mounted || !visible()) return;
    const full = props.children || "";
    if (!p || !full.startsWith(fed) || (ended && full !== fed)) reset();
    const end = Math.min(full.length, fed.length + 8192);
    if (end > fed.length) {
      const appended = full.slice(fed.length, end);
      // Normalize only the new slice; a CRLF pair can cross chunk boundaries.
      const chunk = previousCR && appended.startsWith("\n") ? appended.slice(1) : appended;
      previousCR = appended.endsWith("\r");
      const normalized = chunk.replace(/\r\n?/g, "\n");
      let start = 0;
      for (let newline = normalized.indexOf("\n"); newline >= 0; newline = normalized.indexOf("\n", start)) {
        sourceLine += normalized.slice(start, newline);
        parser_write(p!, normalized.slice(start, newline + 1));
        const table = view!.data.nodes[view!.data.index]?.closest("table");
        if (table && /^ {0,3}\|? *:?-{3,}:? *(?:\| *:?-{3,}:? *)+\|? *$/.test(sourceLine)) {
          const cells = sourceLine.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
          const alignment = cells.map((cell) => cell.endsWith(":") ? cell.startsWith(":") ? "center" : "right" : "left");
          tableAlignments.set(table, alignment);
          table.querySelectorAll("thead th").forEach((cell, i) => cell.setAttribute("align", alignment[i] || "left"));
        }
        sourceLine = ""; start = newline + 1;
      }
      sourceLine += normalized.slice(start);
      parser_write(p!, normalized.slice(start));
    }
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
