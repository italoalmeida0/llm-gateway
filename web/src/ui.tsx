import {
  createSignal,
  createUniqueId,
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
 * badges — themed through CSS vars (white/dark), restrained teal accents,
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
      {/* eslint-disable solid/no-innerhtml -- icon bodies come from the build-time icon registry, never user input */}
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
      {/* eslint-enable solid/no-innerhtml */}
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
        class={`relative flex h-9 w-9 items-center justify-center rounded-lg text-ink-400 hover:text-ink-100 hover:bg-ink-800/60 transition-all duration-300 cursor-pointer ${props.class ?? ""}`}
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
  const btn = (
    <button
      type={props.type ?? "button"}
      class={`ui-button ui-button-${props.variant ?? "primary"} ${props.size === "sm" ? "ui-button-sm" : ""} ${props.class ?? ""}`}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      {props.children}
    </button>
  );
  // title floats as a themed Tooltip (never two competing labels).
  return (
    <Show when={props.title} fallback={btn}>
      {(title) => <Tooltip content={title()}>{btn}</Tooltip>}
    </Show>
  );
}

export function Card(props: {
  class?: string;
  interactive?: boolean;
  children: JSX.Element;
}) {
  return (
    <div
      class={`ui-card ${
        props.interactive
          ? "ui-card-interactive"
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
    <div class="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
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
      class={`rounded-lg bg-ink-900 border border-line text-ink-400 flex items-center justify-center shrink-0 ${props.class ?? "w-10 h-10"}`}
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
        class={`flex items-center justify-center rounded-lg p-2 transition-all duration-200 active:translate-y-px disabled:opacity-40 disabled:pointer-events-none cursor-pointer ${
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
      class={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
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

/** Compact segmented control with a raised active option. */
export function Segmented<T extends string>(props: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string }>;
  class?: string;
}) {
  return (
    <div
      class={`ui-segmented ${props.class ?? ""}`}
      role="group"
    >
      <For each={props.options}>
        {(o) => (
          <button
            type="button"
            aria-pressed={o.value === props.value}
            onClick={() => props.onChange(o.value)}
            class="ui-segment"
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
    <Card interactive class="p-5">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="text-xs font-medium text-ink-500 mb-2">{props.label}</div>
          <div class="text-[28px] leading-8 font-medium tracking-tight truncate">
            <Show when={props.countValue !== undefined} fallback={props.value}>
              <CountUp value={props.countValue!} />
            </Show>
          </div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <Show when={props.delta !== null && props.delta !== undefined}>
            <DeltaPill pct={props.delta!} />
          </Show>
          <IconTile icon={props.icon} class="w-8 h-8 rounded-lg" />
        </div>
      </div>
      <Show when={props.sub}>
        <div class="mt-3 pt-3 border-t border-line text-xs text-ink-500">
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
  const [revealed, setRevealed] = createSignal(false);
  const inputId = createUniqueId();
  const hintId = createUniqueId();
  return (
    <div class="block">
      <Show when={props.label}>
        <label for={inputId} class="block text-xs font-medium text-ink-300 mb-1.5">
          {props.label}
        </label>
      </Show>
      <div class="relative">
      <input
        id={inputId}
        aria-describedby={props.hint ? hintId : undefined}
        type={props.type === "password" && revealed() ? "text" : props.type ?? "text"}
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        placeholder={props.placeholder}
        min={props.min}
        max={props.max}
        autocomplete={props.autocomplete}
        required={props.required}
        disabled={props.disabled}
        class={`ui-field ${props.type === "password" ? "pr-10" : ""}`}
      />
      <Show when={props.type === "password"}>
        <button
          type="button"
          aria-label={revealed() ? "Hide password" : "Show password"}
          aria-pressed={revealed()}
          disabled={props.disabled}
          onClick={() => setRevealed(!revealed())}
          class="absolute inset-y-px right-px flex w-9 items-center justify-center rounded-r-lg border-l border-line text-ink-400 hover:text-ink-100 hover:bg-ink-800/50 cursor-pointer disabled:opacity-50"
        >
          <Icon name={revealed() ? "lucide:eye-off" : Icons.eye} size={15} />
        </button>
      </Show>
      </div>
      <Show when={props.hint}>
        <span id={hintId} class="block text-xs text-ink-500 mt-1.5">{props.hint}</span>
      </Show>
    </div>
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
          class={`ui-field text-left flex items-center justify-between gap-2 cursor-pointer ${
            open() ? "border-brand-500" : ""
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
              class="ui-popover anim-float-in overflow-y-auto p-1"
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
                  class={`w-full flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[13px] text-left transition-colors cursor-pointer ${
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
            class="ui-popover anim-float-in pointer-events-none w-max max-w-[calc(100vw-1rem)] whitespace-pre-wrap break-words px-2 py-1 text-[11px] font-medium text-ink-100"
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
    blue: "bg-brand-500/10 text-brand-500 border-brand-500/20",
  };
  return (
    <span
      class={`max-h-5 min-h-5 max-w-fit min-w-fit inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${tones[props.tone]}`}
    >
      {props.children}
    </span>
  );
}

export function ModalSection(props: {
  title?: string;
  subtitle?: string;
  info?: string;
  badge?: JSX.Element;
  action?: JSX.Element;
  children: JSX.Element;
  class?: string;
}) {
  return (
    <div class={`space-y-3 ${props.class ?? ""}`}>
      <Show when={props.title || props.action}>
        <div class="flex items-start sm:items-center justify-between gap-3 flex-wrap">
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <h4 class="text-xs sm:text-sm font-semibold text-ink-100">
                {props.title}
              </h4>
              <Show when={props.info}>
                <Tooltip content={props.info}>
                  <span tabindex="0" aria-label={props.info} class="inline-flex text-ink-400 hover:text-ink-200 cursor-help transition-colors">
                    <Icon name="lucide:info" size={12} />
                  </span>
                </Tooltip>
              </Show>
              {props.badge}
            </div>
            <Show when={props.subtitle}>
              <p class="text-xs text-ink-400 leading-relaxed mt-0.5">
                {props.subtitle}
              </p>
            </Show>
          </div>
          <Show when={props.action}>
            <div class="shrink-0">{props.action}</div>
          </Show>
        </div>
      </Show>
      {props.children}
    </div>
  );
}

export function OrDivider(props: { text?: string; class?: string }) {
  return (
    <div class={`flex items-center gap-3 my-3 ${props.class ?? ""}`}>
      <div class="h-px bg-line/80 flex-1" />
      <span class="text-[11px] font-medium text-ink-500 uppercase tracking-wider">
        {props.text ?? "Or"}
      </span>
      <div class="h-px bg-line/80 flex-1" />
    </div>
  );
}

export function ModalField(props: {
  label?: string;
  hint?: string;
  children: JSX.Element;
  class?: string;
}) {
  return (
    <div class={`space-y-1.5 ${props.class ?? ""}`}>
      <Show when={props.label}>
        <label class="block text-xs font-medium text-ink-300">
          {props.label}
        </label>
      </Show>
      {props.children}
      <Show when={props.hint}>
        <p class="text-[11px] text-ink-500">{props.hint}</p>
      </Show>
    </div>
  );
}

export function SwitchCard(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  description?: string;
  badge?: JSX.Element;
  disabled?: boolean;
  class?: string;
}) {
  return (
    <label
      class={`ui-switch-card select-none ${
        props.disabled ? "opacity-50 pointer-events-none" : ""
      } ${props.class ?? ""}`}
    >
      <span class="relative shrink-0">
      <input
        type="checkbox"
        role="switch"
        class="peer sr-only"
        aria-label={props.title}
        checked={props.checked}
        aria-checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <span class="ui-switch-track" aria-hidden="true"><span class="ui-switch-thumb" /></span>
      </span>
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-2 flex-wrap">
          <span class="text-xs font-medium text-ink-100">
            {props.title}
          </span>
          {props.badge}
        </span>
        <Show when={props.description}>
          <span class="block text-xs text-ink-400 leading-relaxed mt-0.5">
            {props.description}
          </span>
        </Show>
      </span>
    </label>
  );
}

export function FilterChip(props: {
  selected?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  children: JSX.Element;
  disabled?: boolean;
  badge?: JSX.Element;
  class?: string;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      class={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-all cursor-pointer select-none border ${
        props.selected
          ? "bg-accent-500 text-accent-fg border-accent-500 font-semibold shadow-sm"
          : "bg-ink-900/60 text-ink-300 border-line hover:border-ink-500 hover:text-ink-100"
      } ${props.disabled ? "opacity-40 cursor-not-allowed" : ""} ${props.class ?? ""}`}
    >
      <span>{props.children}</span>
      {props.badge}
      <Show when={props.selected && props.onRemove}>
        <span
          role="button"
          onClick={(e) => {
            e.stopPropagation();
            props.onRemove?.();
          }}
          class="hover:opacity-75 p-0.5 rounded transition-opacity"
          title="Deselect"
        >
          <Icon name={Icons.x} size={11} />
        </span>
      </Show>
    </button>
  );
}

export function ModalNotice(props: {
  tone?: "info" | "warn" | "danger" | "success";
  title?: string;
  children: JSX.Element;
  class?: string;
}) {
  const tones = {
    info: "border-brand-500/30 bg-brand-500/10 text-brand-400",
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-400",
    danger: "border-rose-500/30 bg-rose-500/10 text-rose-400",
    success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  };
  return (
    <div
      class={`rounded-lg border p-3 text-xs leading-relaxed ${tones[props.tone ?? "info"]} ${props.class ?? ""}`}
    >
      <Show when={props.title}>
        <div class="font-semibold text-ink-100 mb-1">{props.title}</div>
      </Show>
      <div class="text-ink-300">{props.children}</div>
    </div>
  );
}

const modalStack: HTMLElement[] = [];
let previousBodyOverflow = "";

export function Modal(props: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  subtitle?: string;
  badge?: JSX.Element;
  width?: string;
  fullOnMobile?: boolean;
  footer?: JSX.Element;
  children: JSX.Element;
  bodyRef?: (el: HTMLDivElement | undefined) => void;
}) {
  const titleId = createUniqueId();
  const descriptionId = createUniqueId();
  const desc = () => props.subtitle ?? props.description;

  const setupDialog = (panel: HTMLDivElement) => {
    const previousFocus = document.activeElement as HTMLElement | null;
    if (modalStack.length === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    modalStack.push(panel);
    const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]',
    )).filter((el) => el.getClientRects().length > 0);
    const raf = requestAnimationFrame(() => {
      if (modalStack.at(-1) === panel) (panel.querySelector<HTMLElement>("[autofocus]") || focusable()[0] || panel).focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (modalStack.at(-1) !== panel || e.defaultPrevented) return;
      // Floating menus own Escape before the dialog beneath them.
      if (document.querySelector("[data-floatmenu], [role=listbox]")) return;
      if (e.key === "Escape") { e.preventDefault(); props.onClose(); }
      if (e.key !== "Tab") return;
      const items = focusable();
      const first = items[0] || panel;
      const last = items.at(-1) || panel;
      if (!panel.contains(document.activeElement) || (e.shiftKey && document.activeElement === first)) {
        e.preventDefault(); (e.shiftKey ? last : first).focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      const wasTop = modalStack.at(-1) === panel;
      const index = modalStack.indexOf(panel);
      if (index >= 0) modalStack.splice(index, 1);
      if (modalStack.length === 0) document.body.style.overflow = previousBodyOverflow;
      if (wasTop && previousFocus?.isConnected) previousFocus.focus();
    });
  };
  return (
    <Show when={props.open}>
      <Portal>
        <div
          class="ui-dialog-backdrop fixed inset-0 overflow-y-auto p-3 sm:p-6 flex items-center justify-center"
          style={{ "z-index": Z.modal }}
          onMouseDown={props.onClose}
        >
          <div
            ref={setupDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={desc() ? descriptionId : undefined}
            tabindex="-1"
            class={`ui-dialog anim-pop-in flex max-h-[calc(100dvh-2rem)] sm:max-h-[90dvh] my-auto min-h-0 w-full flex-col ${
              props.width ?? "max-w-xl"
            } ${props.fullOnMobile ? "ui-dialog-full" : ""} outline-none overflow-hidden`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div class="ui-dialog-header flex shrink-0 items-start justify-between gap-3 px-4 py-3.5 border-b border-line">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <h3
                    id={titleId}
                    class="text-sm font-semibold text-ink-100 tracking-tight break-words"
                  >
                    {props.title}
                  </h3>
                  {props.badge}
                </div>
                <Show when={desc()}>
                  <p
                    id={descriptionId}
                    class="mt-1 text-xs text-ink-400 leading-relaxed font-normal"
                  >
                    {desc()}
                  </p>
                </Show>
              </div>
              <button
                type="button"
                onClick={props.onClose}
                class="shrink-0 rounded-lg p-1.5 text-ink-400 hover:text-ink-100 hover:bg-elev active:scale-95 transition-colors cursor-pointer"
                aria-label="Close"
              >
                <Icon name={Icons.x} size={16} />
              </button>
            </div>

            {/* Body */}
            <div
              ref={(el) => props.bodyRef?.(el)}
              class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 space-y-4 text-[13px]"
            >
              {props.children}
            </div>

            {/* Footer */}
            <Show when={props.footer}>
              <div class="ui-dialog-footer flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-2.5">
                {props.footer}
              </div>
            </Show>
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
      style={{ "z-index": Z.toast }}
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
