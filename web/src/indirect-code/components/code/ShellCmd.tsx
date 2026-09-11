import { For } from "solid-js";

/**
 * Inline shell syntax highlight for tool headers (bash/run rows):
 * `$ command` with flags, strings, vars, pipes and comments tinted.
 * Sync + regex-based (no async hljs): headers render instantly and update
 * for free on every keystroke/signal change. No manual truncation: the
 * parent uses CSS `truncate`, so the ellipsis follows the space actually
 * available; `title` keeps the full command for hover.
 */
export function ShellCmd(props: { text: string }) {
  // Tokenize: comments | strings | vars | operators | flags | numbers.
  const parts = () => {
    const src = props.text || "";
    const re = /(#[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\$[A-Za-z_][A-Za-z0-9_]*|\$\{|\$\(|\$\d+)|(&&|\|\||\||;|>|>>|<|2>|&)|(^|\s)(-[A-Za-z][A-Za-z0-9-]*|--[A-Za-z0-9][A-Za-z0-9-]*)(?=\s|$)|\b(\d+(?:\.\d+)?)\b/g;
    const out: { t: string; c: string }[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    // Safety: bail to plain text on pathological input.
    let guard = 0;
    while ((m = re.exec(src)) !== null && guard++ < 500) {
      if (m.index > last) out.push({ t: src.slice(last, m.index), c: "" });
      const [full, comment, str, vr, op, _pre, flag, num] = m;
      if (comment) out.push({ t: full, c: "text-ink-600 italic" });
      else if (str) out.push({ t: full, c: "text-emerald-300" });
      else if (vr) out.push({ t: full, c: "text-amber-800 dark:text-amber-200" });
      else if (op) out.push({ t: full, c: "text-rose-300" });
      else if (flag) out.push({ t: full, c: "text-sky-300" });
      else if (num) out.push({ t: full, c: "text-violet-300" });
      else out.push({ t: full, c: "" });
      last = m.index + full.length;
      if (full.length === 0) re.lastIndex++;
    }
    if (last < src.length) out.push({ t: src.slice(last), c: "" });
    return out;
  };
  return (
    <code class="font-mono truncate min-w-0" title={props.text || ""}>
      <span class="text-ink-600 select-none">$ </span>
      <For each={parts()}>{(p) =>
        p.c ? <span class={p.c}>{p.t}</span> : <span>{p.t}</span>
      }</For>
    </code>
  );
}
