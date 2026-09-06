import { createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { anchorFloat } from "./floating";
import { Icon } from "./components/icon";

export function fileIcon(path: string): { icon: string; class: string } {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() || "";
  const ext = name.split(".").pop();
  if (ext === "py" || ext === "pyi") return { icon: "mdi:language-python", class: "text-[var(--code-builtin)]" };
  if (ext === "ts" || ext === "tsx") return { icon: "mdi:language-typescript", class: "text-[var(--code-type)]" };
  if (ext === "js" || ext === "jsx" || ext === "mjs" || ext === "cjs") return { icon: "mdi:language-javascript", class: "text-[var(--code-num)]" };
  if (ext === "go") return { icon: "mdi:language-go", class: "text-[var(--code-type)]" };
  if (ext === "rs") return { icon: "mdi:language-rust", class: "text-[var(--code-meta)]" };
  if (ext === "java") return { icon: "mdi:language-java", class: "text-[var(--code-meta)]" };
  if (ext === "json" || ext === "yaml" || ext === "yml" || ext === "toml") return { icon: "lucide:braces", class: "text-[var(--code-num)]" };
  if (ext === "md" || ext === "mdx") return { icon: "mdi:language-markdown", class: "text-[var(--code-type)]" };
  if (ext === "html" || ext === "vue" || ext === "svelte") return { icon: "lucide:file-code", class: "text-[var(--code-meta)]" };
  if (ext === "css" || ext === "scss") return { icon: "mdi:language-css3", class: "text-[var(--code-kw)]" };
  if (ext === "sh" || name === "dockerfile" || name === "makefile") return { icon: "lucide:terminal", class: "text-[var(--code-str)]" };
  if (/\.(png|jpe?g|gif|webp|svg|ico)$/.test(name)) return { icon: "lucide:image", class: "text-[var(--code-kw)]" };
  return { icon: "lucide:file-text", class: "text-ink-400" };
}

export function FileIcon(props: { path: string; size?: number }) {
  return <Icon icon={fileIcon(props.path).icon} class={fileIcon(props.path).class} size={props.size ?? 15} />;
}

/** Delegated hints preserve row layout and work inside portaled dialogs too. */
export function RemoteHints() {
  const [target, setTarget] = createSignal<HTMLElement | null>(null);
  const id = createUniqueId();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let described: HTMLElement | null = null;
  const close = () => {
    clearTimeout(timer);
    if (described?.getAttribute("aria-describedby") === id) described.removeAttribute("aria-describedby");
    described = null;
    setTarget(null);
  };
  const open = (el: HTMLElement) => {
    if (!el.isConnected) return;
    if (!el.hasAttribute("aria-describedby")) { el.setAttribute("aria-describedby", id); described = el; }
    setTarget(el);
  };
  onMount(() => {
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch" || !matchMedia("(hover: hover)").matches) return;
      const el = (e.target as Element)?.closest<HTMLElement>("[data-rc-tip]");
      if (!el || el.contains(e.relatedTarget as Node)) return;
      close(); timer = setTimeout(() => open(el), 150);
    };
    const out = (e: PointerEvent) => {
      const el = (e.target as Element)?.closest<HTMLElement>("[data-rc-tip]");
      if (el && !el.contains(e.relatedTarget as Node)) close();
    };
    const focus = (e: FocusEvent) => {
      const el = (e.target as Element)?.closest<HTMLElement>("[data-rc-tip]");
      if (el?.matches(":focus-visible")) { close(); open(el); }
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", close);
    document.addEventListener("keydown", key);
    document.addEventListener("scroll", close, true);
    onCleanup(() => {
      close();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", close);
      document.removeEventListener("keydown", key);
      document.removeEventListener("scroll", close, true);
    });
  });
  return <Show when={target()} keyed>{(el) => <Portal>
    <div id={id} role="tooltip" ref={(node) => onCleanup(anchorFloat(el, node, { placement: "top", gap: 8 }))}
      class="anim-float-in pointer-events-none max-w-60 break-words rounded-lg border border-line bg-elev px-2.5 py-1.5 text-xs font-medium text-ink-100 shadow-xl shadow-black/10">
      {el.getAttribute("data-rc-tip")}
    </div>
  </Portal>}</Show>;
}
