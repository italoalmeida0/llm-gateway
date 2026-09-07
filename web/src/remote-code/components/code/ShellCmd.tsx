import { For } from "solid-js";

/**
 * Inline shell syntax highlight for tool headers (bash/run rows):
 * `$ command` with flags, strings, vars, pipes and comments tinted.
 * Sync + regex-based (no async hljs): headers render instantly and update
 * for free on every keystroke/signal change. Long commands clamp with
 * ellipsis (title attr keeps the full text).
 */
export function ShellCmd(props: { text: string; max?: number }) {
  const max = () => props.max ?? 90;
  const short = () => {
    const t = props.text || "";
    return t.length > max() ? t.slice(0, max()) + "…" : t;
  };
  // Tokenize: comments | strings | vars | operators | flags | numbers.
  const parts = () => {
    const src = short();
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
      else if (vr) out.push({ t: full, c: "text-amber-300" });
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
    <code title={props.text || ""} class="font-mono truncate min-w-0">
      <span class="text-ink-600 select-none">$ </span>
      <For each={parts()}>{(p) =>
        p.c ? <span class={p.c}>{p.t}</span> : <span>{p.t}</span>
      }</For>
    </code>
  );
}
