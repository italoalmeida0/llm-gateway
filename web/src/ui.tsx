import {
  createSignal,
  createMemo,
  createEffect,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";
import type { Placement } from "@floating-ui/dom";

import { anchorFloat, Z } from "./floating";
import { usalCount } from "./motion";

/**
 * Hand-built UI kit: buttons, cards, inputs, custom select, modal, toast,
 * badges — themed through CSS vars (white/dark), monospace-red brand accents,
 * USAL friendly. No component library by design.
 */

import { registry } from "virtual:icons";

// ==========================================
// ICON SYSTEM (Powered by Iconify & @iconify-json/lucide with zero runtime overhead)
// ==========================================

// Semantic names -> Iconify Lucide identifiers
export const Icons = {
  key: "lucide:key",
  chart: "lucide:bar-chart-2",
  users: "lucide:users",
  cog: "lucide:settings",
  logout: "lucide:log-out",
  plus: "lucide:plus",
  copy: "lucide:copy",
  check: "lucide:check",
  trash: "lucide:trash-2",
  shield: "lucide:shield",
  clock: "lucide:clock",
  x: "lucide:x",
  server: "lucide:server",
  refresh: "lucide:refresh-cw",
  eye: "lucide:eye",
  bolt: "lucide:zap",
  ban: "lucide:ban",
  book: "lucide:book-open",
  gauge: "lucide:layout-dashboard",
  warning: "lucide:alert-triangle",
  search: "lucide:search",
  edit: "lucide:edit-3",
  home: "lucide:home",
  sun: "lucide:sun",
  moon: "lucide:moon",
  chevronDown: "lucide:chevron-down",
  arrowUpRight: "lucide:arrow-up-right",
  menu: "lucide:menu",
  grip: "lucide:grip-vertical",
  layers: "lucide:layers",
  terminal: "lucide:terminal",
  folder: "lucide:folder",
  play: "lucide:play",
  stop: "lucide:square",
  send: "lucide:send",
  file: "lucide:file-text",
  chevronRight: "lucide:chevron-right",
  split: "lucide:git-branch",
  git: "lucide:git-branch",
  sparkles: "lucide:sparkles",
  save: "lucide:save",
} as const;

export function Icon(props: {
  name: string;
  size?: number;
  class?: string;
  strokeWidth?: number;
}) {
  const iconData = () => registry[props.name] ?? registry[`lucide:${props.name}`];

  return (
    <span
      class={`inline-flex items-center justify-center shrink-0 ${props.class ?? ""}`}
    >
      <svg
        innerHTML={iconData()?.body || ""}
        viewBox={`0 0 ${iconData()?.width ?? 24} ${iconData()?.height ?? 24}`}
        fill="none"
        stroke="currentColor"
        stroke-width={props.strokeWidth ?? 1.8}
        stroke-linecap="round"
        stroke-linejoin="round"
        width={props.size ?? 16}
        height={props.size ?? 16}
        aria-hidden="true"
      />
    </span>
  );
}

// ==========================================
// THEME (white / dark)
// ==========================================

export type Theme = "light" | "dark";
const THEME_KEY = "llmgw-theme";

export function getTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

const [theme, setThemeSignal] = createSignal<Theme>(getTheme());
export { theme };

export function setTheme(t: Theme): void {
  const html = document.documentElement;
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {}
  html.classList.add("theme-xfade");
  html.dataset.theme = t;
  setThemeSignal(t);
  window.setTimeout(() => html.classList.remove("theme-xfade"), 380);
}

export function toggleTheme(): void {
  setTheme(getTheme() === "dark" ? "light" : "dark");
}

/** If the user never picked a theme manually, keep following the OS. */
export function watchSystemTheme(): void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(THEME_KEY);
    } catch {}
    if (stored !== "light" && stored !== "dark") {
      const t: Theme = mq.matches ? "dark" : "light";
      document.documentElement.dataset.theme = t;
      setThemeSignal(t);
    }
  };
  // Apply once on setup (covers any stale pre-mount signal value), then keep
  // following the OS while no manual choice exists.
  apply();
  mq.addEventListener?.("change", apply);
}

export function ThemeToggle(props: {
  class?: string;
  tooltipPlacement?: Placement;
}) {
  return (
    <Tooltip
      content={
        theme() === "dark" ? "Switch to light theme" : "Switch to dark theme"
      }
      placement={props.tooltipPlacement ?? "bottom"}
    >
      <button
        type="button"
        onClick={toggleTheme}
        aria-label="Toggle theme"
        class={`relative flex h-10 w-10 items-center justify-center rounded-xl text-ink-400 hover:text-ink-100 hover:bg-ink-800/60 transition-all duration-300 cursor-pointer ${props.class ?? ""}`}
      >
        <span
          class="flex items-center justify-center transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={{
            transform: theme() === "dark" ? "rotate(0deg)" : "rotate(180deg)",
          }}
        >
          <Icon name={theme() === "dark" ? Icons.sun : Icons.moon} size={18} />
        </span>
      </button>
    </Tooltip>
  );
}

// ==========================================
// COMPONENTS
// ==========================================

export function Btn(props: {
  variant?: "primary" | "ghost" | "danger" | "outline";
  size?: "sm" | "md";
  onClick?: (e: MouseEvent) => void;
  disabled?: boolean;
  type?: "button" | "submit";
  class?: string;
  title?: string;
  children: JSX.Element;
}) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-xl font-medium transition-all duration-200 active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/50 disabled:opacity-50 disabled:pointer-events-none cursor-pointer";
  const variant = {
    primary: "bg-accent-500 hover:bg-accent-600 text-accent-fg shadow-sm",
    ghost: "hover:bg-ink-800 text-ink-200",
    danger: "bg-rose-600/90 hover:bg-rose-600 text-white",
    outline:
      "border border-ink-600/80 hover:border-ink-500 hover:bg-ink-800/60 text-ink-100",
  }[props.variant ?? "primary"];
  const size =
    props.size === "sm" ? "text-xs px-2.5 py-1.5" : "text-sm px-4 py-2";
  const btn = (
    <button
      type={props.type ?? "button"}
      class={`${base} ${variant} ${size} ${props.class ?? ""}`}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      {props.children}
    </button>
  );
  // title floats as a themed Tooltip (never two competing labels).
  return props.title ? (
    <Tooltip content={props.title}>{btn}</Tooltip>
  ) : (
    btn
  );
}

export function Card(props: {
  class?: string;
  interactive?: boolean;
  children: JSX.Element;
}) {
  return (
    <div
      class={`rounded-xl border border-line bg-card overflow-hidden ${
        props.interactive
          ? "transition-all duration-300 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/5 hover:border-ink-600/50"
          : ""
      } ${props.class ?? ""}`}
    >
      {props.children}
    </div>
  );
}

export function CardHeader(props: {
  title: string;
  subtitle?: string;
  right?: JSX.Element;
}) {
  return (
    <div class="flex items-start justify-between gap-4 px-6 pt-5 pb-3">
      <div>
        <h2 class="text-sm font-semibold text-ink-100">{props.title}</h2>
        <Show when={props.subtitle}>
          <p class="text-xs text-ink-400 mt-0.5">{props.subtitle}</p>
        </Show>
      </div>
      {props.right}
    </div>
  );
}

/** Small tinted icon tile, used on stat cards and the topbar page marker. */
export function IconTile(props: { icon: string; class?: string }) {
  return (
    <div
      class={`rounded-2xl bg-brand-500/10 border border-brand-500/15 text-brand-500 flex items-center justify-center shrink-0 ${props.class ?? "w-10 h-10"}`}
    >
      <Icon name={props.icon} size={20} />
    </div>
  );
}

/** Standardized icon-only row/list action button. Neutral by default;
 *  `danger` turns rose on hover. The label lives in a floating Tooltip +
 *  aria-label (no native title, so grids/modals never clip it). */
export function IconBtn(props: {
  icon: string;
  title: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip content={props.title}>
      <button
        type="button"
        aria-label={props.title}
        disabled={props.disabled}
        onClick={props.onClick}
        class={`flex items-center justify-center rounded-lg p-2 transition-all duration-200 active:scale-[0.95] disabled:opacity-40 disabled:pointer-events-none cursor-pointer ${
          props.danger
            ? "text-ink-400 hover:text-rose-500 hover:bg-rose-500/10"
            : "text-ink-400 hover:text-ink-100 hover:bg-ink-800/60"
        }`}
      >
        <Icon name={props.icon} size={16} />
      </button>
    </Tooltip>
  );
}

/** Green/red pill showing a percent change vs the previous period (▲/▼). */
export function DeltaPill(props: { pct: number }) {
  const up = () => props.pct >= 0;
  return (
    <span
      class={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold tabular-nums ${
        up()
          ? "bg-emerald-500/10 text-emerald-500"
          : "bg-rose-500/10 text-rose-500"
      }`}
    >
      <span class="text-[7px] leading-none">{up() ? "▲" : "▼"}</span>
      {`${Math.abs(Math.round(props.pct))}%`}
    </span>
  );
}

/** Pill-shaped segmented control (elevated track, raised active segment). */
export function Segmented<T extends string>(props: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  class?: string;
}) {
  return (
    <div
      class={`inline-flex items-center gap-0.5 rounded-full border border-line bg-elev p-1 shadow-sm ${props.class ?? ""}`}
      role="tablist"
    >
      <For each={props.options}>
        {(o) => (
          <button
            role="tab"
            aria-selected={o.value === props.value}
            onClick={() => props.onChange(o.value)}
            class={`rounded-full px-3.5 py-1.5 text-xs transition-all duration-200 cursor-pointer ${
              o.value === props.value
                ? "bg-ink-100 text-ink-950 font-semibold shadow-sm"
                : "text-ink-400 hover:text-ink-100"
            }`}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  );
}

/**
 * Split an integer into an animatable numeric part + static unit suffix.
 * Thresholds/decimals mirror fmtNum so animated headers agree with the
 * static stats rendered next to them (950, 12.5K, 1.14M).
 */
export function compactParts(n: number): { count: string; suffix: string } {
  if (n >= 1_000_000_000) return { count: (n / 1_000_000_000).toFixed(2), suffix: "B" };
  if (n >= 1_000_000) return { count: (n / 1_000_000).toFixed(2), suffix: "M" };
  if (n >= 10_000) return { count: (n / 1_000).toFixed(1), suffix: "K" };
  return { count: String(n), suffix: "" };
}

/**
 * Animated number: counts up from 0 (compact — 950, 12.5K, 1.14M — never wraps).
 * Re-mounts when the displayed value changes: USAL replaces our text node with
 * its own span when it animates, so an in-place Solid update after that would
 * write into a detached node and the number would go stale (window switches).
 */
export function CountUp(props: { value: number; class?: string }) {
  const parts = () => compactParts(Math.round(Math.max(0, props.value)));
  return (
    <Show when={parts().count} keyed>
      {(count) => (
        <span
          class={`tabular-nums inline-block ${props.class ?? ""}`}
          {...usalCount(count)}
        >
          {count}
          {compactParts(Math.round(Math.max(0, props.value))).suffix}
        </span>
      )}
    </Show>
  );
}

/** Big metric card: muted label + large count-up value + delta pill. */
export function StatCard(props: {
  icon: string;
  value?: string;
  countValue?: number;
  label: JSX.Element;
  delta?: number | null;
  sub?: JSX.Element;
}) {
  return (
    <Card interactive class="p-6">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="text-xs font-medium text-ink-500 mb-2">{props.label}</div>
          <div class="text-[32px] leading-9 font-light tracking-tight truncate">
            <Show when={props.countValue !== undefined} fallback={props.value}>
              <CountUp value={props.countValue!} />
            </Show>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <Show when={props.delta !== null && props.delta !== undefined}>
            <DeltaPill pct={props.delta!} />
          </Show>
          <IconTile icon={props.icon} class="w-9 h-9 rounded-xl" />
        </div>
      </div>
      <Show when={props.sub}>
        <div class="mt-4 pt-3.5 border-t border-line text-xs text-ink-500">
          {props.sub}
        </div>
      </Show>
    </Card>
  );
}

export function Input(props: {
  label?: string;
  type?: string;
  value: string | number;
  onInput: (v: string) => void;
  placeholder?: string;
  min?: number;
  max?: number;
  autocomplete?: string;
  required?: boolean;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label class="block">
      <Show when={props.label}>
        <span class="block text-xs font-medium text-ink-300 mb-1.5">
          {props.label}
        </span>
      </Show>
      <input
        type={props.type ?? "text"}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        placeholder={props.placeholder}
        min={props.min}
        max={props.max}
        autocomplete={props.autocomplete}
        required={props.required}
        disabled={props.disabled}
        class="w-full rounded-xl border border-line bg-elev px-3.5 py-2.5 text-sm text-ink-100 placeholder:text-ink-500 focus:border-ink-500 focus:outline-none focus:ring-2 focus:ring-ink-500/10 transition-all duration-200 disabled:opacity-50 disabled:pointer-events-none"
      />
      <Show when={props.hint}>
        <span class="block text-xs text-ink-500 mt-1.5">{props.hint}</span>
      </Show>
    </label>
  );
}

/**
 * Custom dropdown select — no native <select> popup. Keyboard: ↑/↓ move,
 * Enter/Space pick, Esc close; clicks outside close. Same API as before.
 * The listbox mounts in a Portal anchored by floating-ui, so it flips above
 * the trigger near the viewport edge, shrinks to the available height, and
 * is never clipped by an ancestor's overflow (e.g. inside a Modal).
 */
export function Select(props: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  hint?: string;
}) {
  const [open, setOpen] = createSignal(false);
  const [highlight, setHighlight] = createSignal(0);
  let root: HTMLDivElement | undefined;
  let btnRef: HTMLButtonElement | undefined;
  let listRef: HTMLDivElement | undefined;

  const current = () =>
    props.options.find((o) => o.value === props.value) ?? {
      value: props.value,
      label: props.value || "Select…",
    };

  const onDocClick = (e: MouseEvent) => {
    const t = e.target as Node;
    if (root?.contains(t) || listRef?.contains(t)) return;
    setOpen(false);
  };
  const onDocKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
  };
  onMount(() => {
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onDocKey);
  });
  onCleanup(() => {
    document.removeEventListener("mousedown", onDocClick);
    document.removeEventListener("keydown", onDocKey);
  });

  const openMenu = () => {
    setHighlight(
      Math.max(
        0,
        props.options.findIndex((o) => o.value === props.value),
      ),
    );
    setOpen(true);
  };

  const pick = (v: string) => {
    props.onChange(v);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (
      !open() &&
      (e.key === "Enter" || e.key === " " || e.key === "ArrowDown")
    ) {
      e.preventDefault();
      openMenu();
      return;
    }
    if (!open()) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(props.options.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const opt = props.options[highlight()];
      if (opt) pick(opt.value);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  createEffect(() => {
    if (!open()) return;
    highlight();
    queueMicrotask(() => {
      listRef
        ?.querySelector("[data-hl='1']")
        ?.scrollIntoView({ block: "nearest" });
    });
  });

  return (
    <label class="block">
      <Show when={props.label}>
        <span class="block text-xs font-medium text-ink-300 mb-1.5">
          {props.label}
        </span>
      </Show>
      <div ref={root} class="relative" onKeyDown={onKeyDown}>
        <button
          ref={btnRef}
          type="button"
          onClick={() => (open() ? setOpen(false) : openMenu())}
          aria-haspopup="listbox"
          aria-expanded={open()}
          class={`w-full rounded-xl border bg-elev px-3.5 py-2.5 text-sm text-left text-ink-100 flex items-center justify-between gap-2 transition-all duration-200 cursor-pointer focus:outline-none focus:ring-2 focus:ring-ink-500/10 ${
            open() ? "border-ink-500" : "border-line hover:border-ink-600"
          }`}
        >
          <span class="truncate">{current().label}</span>
          <Icon
            name={Icons.chevronDown}
            size={14}
            class={`text-ink-400 transition-transform duration-300 ${open() ? "rotate-180" : ""}`}
          />
        </button>
        <Show when={open()}>
          {/* Portal + floating-ui: escapes overflow-clipping ancestors and
              the modal layer. Width tracks the trigger (matchWidth), height
              shrinks to the resolved side (maxHeight 256 = the old max-h-64).
              The anchorFloat cleanup is owned by this <Show> — autoUpdate
              stops the moment the menu closes. */}
          <Portal>
            <div
              ref={(el) => {
                listRef = el;
                onCleanup(
                  anchorFloat(btnRef!, el, {
                    placement: "bottom-start",
                    gap: 6,
                    matchWidth: true,
                    maxHeight: 256,
                  }),
                );
              }}
              role="listbox"
              class="anim-float-in overflow-y-auto rounded-xl border border-line bg-elev p-1 shadow-xl shadow-black/10"
            >
            <For each={props.options}>
              {(o, i) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === props.value}
                  data-hl={i() === highlight() ? "1" : "0"}
                  onClick={() => pick(o.value)}
                  onMouseEnter={() => setHighlight(i())}
                  class={`w-full flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm text-left transition-colors cursor-pointer ${
                    o.value === props.value
                      ? "bg-brand-500/10 text-brand-500 font-medium"
                      : i() === highlight()
                        ? "bg-ink-800/70 text-ink-100"
                        : "text-ink-200"
                  }`}
                >
                  <span class="truncate">{o.label}</span>
                  <Show when={o.value === props.value}>
                    <Icon name={Icons.check} size={14} class="shrink-0" />
                  </Show>
                </button>
              )}
            </For>
            </div>
          </Portal>
        </Show>
      </div>
      <Show when={props.hint}>
        <span class="block text-xs text-ink-500 mt-1.5">{props.hint}</span>
      </Show>
    </label>
  );
}

/**
 * Floating-ui tooltip: hover (hover-capable pointers) or keyboard focus shows
 * it; flip + shift keep it inside the viewport; Portal above the modal layer.
 * Replaces native `title` — instant, themed, never clipped.
 */
export function Tooltip(props: {
  content: JSX.Element;
  placement?: Placement;
  /** Hover-intent delay in ms (default 150). */
  delay?: number;
  children: JSX.Element;
}) {
  const [show, setShow] = createSignal(false);
  let anchor: HTMLSpanElement | undefined;
  let showTimer: number | undefined;

  const open = () => {
    // Touch pointers don't hover — a tap shouldn't pin a tooltip on screen.
    if (!window.matchMedia("(hover: hover)").matches) return;
    window.clearTimeout(showTimer);
    showTimer = window.setTimeout(
      () => setShow(true),
      props.delay ?? 150,
    );
  };
  const close = () => {
    window.clearTimeout(showTimer);
    setShow(false);
  };
  const onFocusIn = () => {
    // Keyboard focus only (the wrapper itself is never focusable).
    if (anchor?.querySelector(":focus-visible")) setShow(true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => {
    window.removeEventListener("keydown", onKey);
    window.clearTimeout(showTimer);
  });

  return (
    <>
      <span
        ref={anchor}
        class="inline-flex max-w-full"
        onMouseEnter={open}
        onMouseLeave={close}
        onFocusIn={onFocusIn}
        onFocusOut={close}
      >
        {props.children}
      </span>
      <Show when={show()}>
        <Portal>
          <div
            ref={(el) => {
              onCleanup(
                anchorFloat(anchor!, el, {
                  placement: props.placement ?? "top",
                  gap: 8,
                }),
              );
            }}
            role="tooltip"
            class="anim-float-in pointer-events-none max-w-60 rounded-lg border border-line bg-elev px-2.5 py-1.5 text-xs font-medium text-ink-100 shadow-xl shadow-black/10"
          >
            {props.content}
          </div>
        </Portal>
      </Show>
    </>
  );
}

export function Badge(props: {
  tone: "green" | "red" | "amber" | "zinc" | "indigo" | "blue";
  children: JSX.Element;
}) {
  const tones = {
    green: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
    red: "bg-rose-500/10 text-rose-500 border-rose-500/20",
    amber: "bg-amber-500/10 text-amber-500 border-amber-500/20",
    zinc: "bg-ink-800/70 text-ink-300 border-ink-600/60",
    indigo: "bg-brand-500/10 text-brand-500 border-brand-500/20",
    blue: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  };
  return (
    <span
      class={`max-h-5 min-h-5 max-w-fit min-w-fit inline-flex items-center rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${tones[props.tone]}`}
    >
      {props.children}
    </span>
  );
}

export function Modal(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  width?: string;
  /** Fullscreen sheet on small screens (mobile-first modals). */
  fullOnMobile?: boolean;
  children: JSX.Element;
}) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && props.open) props.onClose();
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    <Show when={props.open}>
      {/* Portal: keeps position:fixed relative to the viewport even if an
          ancestor has a transform/filter (which would create a containing
          block and fling the modal off-screen). CSS animation only — never
          data-usal here (retained transforms/filters break fixed layouts). */}
      <Portal>
        <div
          class="fixed inset-0 overflow-y-auto bg-black/55 backdrop-blur-sm"
          style={`z-index: ${Z.modal}`}
          onMouseDown={() => props.onClose()}
          role="dialog"
          aria-modal="true"
        >
          <div class="min-h-full flex items-center justify-center p-4">
            <div
              class={`anim-pop-in w-full ${props.width ?? "max-w-md"} rounded-xl border border-line bg-card shadow-2xl shadow-black/30 ${
                props.fullOnMobile
                  ? "max-sm:min-h-[100dvh] max-sm:max-w-full max-sm:rounded-none max-sm:border-0"
                  : ""
              }`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <div class="flex items-center justify-between px-5 py-3 border-b border-line">
                <h3 class="text-sm font-semibold">{props.title}</h3>
                <button
                  onClick={props.onClose}
                  class="rounded-lg p-1 text-ink-400 hover:text-ink-100 hover:bg-ink-800/60 transition-colors cursor-pointer"
                  aria-label="Close"
                >
                  <Icon name={Icons.x} />
                </button>
              </div>
              <div class="px-5 py-4">{props.children}</div>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

// ===== Toasts =====

interface Toast {
  id: number;
  kind: "ok" | "err";
  text: string;
}

const [toasts, setToasts] = createSignal<Toast[]>([]);
let toastId = 0;

/** Capitalize the first letter for display (leaves the rest untouched). */
export function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

export function toast(text: string, kind: "ok" | "err" = "ok"): void {
  const id = ++toastId;
  setToasts((t) => [...t.slice(-3), { id, kind, text: capitalize(text) }]);
  setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
}

export function Toasts() {
  return (
    <div
      class="fixed bottom-4 right-4 flex flex-col gap-2 items-end"
      style={`z-index: ${Z.toast}`}
    >
      <For each={toasts()}>
        {(t) => (
          <div
            class={`anim-slide-in rounded-xl border px-4 py-2.5 text-sm shadow-xl shadow-black/10 max-w-sm bg-elev ${
              t.kind === "ok"
                ? "border-emerald-500/30 text-emerald-500"
                : "border-rose-500/30 text-rose-500"
            }`}
          >
            {t.text}
          </div>
        )}
      </For>
    </div>
  );
}

export function Spinner(props: { class?: string }) {
  return (
    <svg
      class={`animate-spin ${props.class ?? "w-4 h-4"}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle
        class="opacity-20"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        stroke-width="4"
      />
      <path
        d="M22 12a10 10 0 0 0-10-10"
        stroke="currentColor"
        stroke-width="4"
        stroke-linecap="round"
      />
    </svg>
  );
}

export function EmptyState(props: {
  icon: string;
  title: string;
  hint?: string;
}) {
  return (
    <div class="flex flex-col items-center justify-center py-12 text-center">
      <div class="w-11 h-11 rounded-2xl bg-ink-800/70 border border-line flex items-center justify-center text-ink-400 mb-3">
        <Icon name={props.icon} size={20} />
      </div>
      <p class="text-sm font-medium text-ink-200">{props.title}</p>
      <Show when={props.hint}>
        <p class="text-xs text-ink-500 mt-1 max-w-xs">{props.hint}</p>
      </Show>
    </div>
  );
}

export function ProgressBar(props: {
  value: number;
  max: number;
  danger?: boolean;
}) {
  const pct = () =>
    Math.min(100, props.max > 0 ? (props.value / props.max) * 100 : 0);
  return (
    <div
      class="w-full h-2 rounded-full bg-ink-800 overflow-hidden"
      role="progressbar"
      aria-valuenow={Math.round(pct())}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        class={`h-full rounded-full transition-all duration-700 ${props.danger && pct() > 85 ? "bg-rose-500" : "bg-brand-500"}`}
        style={{ width: `${pct()}%` }}
      />
    </div>
  );
}

// ===== Formatting helpers =====

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Human window name for the shared day selectors ("1" = hourly 24h view,
 *  "all" = unbounded). */
export function windowLabel(days: string): string {
  if (days === "all") return "all time";
  return days === "1" ? "last 24 hours" : `last ${days} days`;
}

/** Per-hour axis label when the point is an hour bucket, else MM-DD. */
export function pointLabel(d: { date: string; label?: string }): string {
  return d.label ?? d.date.slice(5);
}

export function fmtDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeUntil(ts: number | null): string {
  if (!ts) return "never";
  const delta = ts - Date.now();
  if (delta <= 0) return "expired";
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  // Modern clipboard API — only exists in secure contexts (https/localhost).
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  // Legacy fallback: hidden textarea + execCommand("copy") — works on plain
  // http origins (e.g. port-forwarded hosts) where navigator.clipboard is
  // undefined.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText =
      "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Copy with standard user feedback (honest on failure). */
export async function copyWithToast(text: string): Promise<void> {
  if (await copyToClipboard(text)) toast("Copied");
  else
    toast(
      "Could not copy automatically — select the text and copy manually",
      "err",
    );
}
