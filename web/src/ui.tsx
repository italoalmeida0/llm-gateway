import {
  createSignal,
  createMemo,
  For,
  onCleanup,
  onMount,
  Show,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";

import { usalCount } from "./motion";

/**
 * Hand-built UI kit: buttons, cards, inputs, custom select, modal, toast,
 * badges — themed through CSS vars (white/dark), monospace-red brand accents,
 * USAL friendly. No component library by design.
 */

// ==========================================
// ICON SYSTEM (inline stroke SVGs, currentColor — themable, no CDN fetch)
// ==========================================

const ICON_PATHS: Record<string, string[]> = {
  key: [
    "M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1121.75 8.25z",
  ],
  chart: [
    "M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z",
  ],
  users: [
    "M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z",
  ],
  cog: [
    "M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28z",
    "M15 12a3 3 0 11-6 0 3 3 0 016 0z",
  ],
  logout: [
    "M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9",
  ],
  plus: ["M12 4.5v15m7.5-7.5h-15"],
  copy: [
    "M16.5 8.25V6a2.25 2.25 0 00-2.25-2.25H6A2.25 2.25 0 003.75 6v8.25A2.25 2.25 0 006 16.5h2.25m8.25-8.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-7.5A2.25 2.25 0 018.25 18v-7.5a2.25 2.25 0 012.25-2.25h6z",
  ],
  check: ["M4.5 12.75l6 6 9-13.5"],
  trash: [
    "M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0",
  ],
  shield: [
    "M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z",
  ],
  clock: ["M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"],
  x: ["M6 18L18 6M6 6l12 12"],
  server: [
    "M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z",
  ],
  refresh: [
    "M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99",
  ],
  eye: [
    "M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z",
    "M15 12a3 3 0 11-6 0 3 3 0 016 0z",
  ],
  bolt: ["M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"],
  ban: [
    "M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636",
  ],
  book: [
    "M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25",
  ],
  home: [
    "M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75",
  ],
  warning: [
    "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z",
  ],
  search: [
    "M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z",
  ],
  edit: [
    "M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10",
  ],
  sun: [
    "M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z",
  ],
  moon: [
    "M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z",
  ],
  chevronDown: ["M19.5 8.25l-7.5 7.5-7.5-7.5"],
  arrowUpRight: ["M4.5 19.5l15-15m0 0H8.25m11.25 0v11.25"],
  menu: ["M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"],
  grip: [
    "M9 5.25h.01M9 12h.01M9 18.75h.01M15 5.25h.01M15 12h.01M15 18.75h.01",
  ],
  layers: [
    "M6.429 9.75L2.25 12l4.179 2.25m0-4.5l5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L21.75 12l-4.179 2.25m0 0l4.179 2.25L12 21.75 2.25 16.5l4.179-2.25m11.142 0l-5.571 3-5.571-3",
  ],
};

// Semantic names -> inline icon keys
export const Icons = {
  key: "key",
  chart: "chart",
  users: "users",
  cog: "cog",
  logout: "logout",
  plus: "plus",
  copy: "copy",
  check: "check",
  trash: "trash",
  shield: "shield",
  clock: "clock",
  x: "x",
  server: "server",
  refresh: "refresh",
  eye: "eye",
  bolt: "bolt",
  ban: "ban",
  book: "book",
  gauge: "home",
  warning: "warning",
  search: "search",
  edit: "edit",
  home: "home",
  sun: "sun",
  moon: "moon",
  chevronDown: "chevronDown",
  arrowUpRight: "arrowUpRight",
  menu: "menu",
  grip: "grip",
  layers: "layers",
} as const;

export function Icon(props: {
  name: string;
  size?: number;
  class?: string;
  strokeWidth?: number;
}) {
  const paths = () => ICON_PATHS[props.name] ?? [];
  return (
    <span
      class={`inline-flex items-center justify-center shrink-0 ${props.class ?? ""}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width={props.strokeWidth ?? 1.8}
        stroke-linecap="round"
        stroke-linejoin="round"
        width={props.size ?? 16}
        height={props.size ?? 16}
        aria-hidden="true"
      >
        <For each={paths()}>{(d) => <path d={d} />}</For>
      </svg>
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

export function ThemeToggle(props: { class?: string }) {
  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={
        theme() === "dark" ? "Switch to light theme" : "Switch to dark theme"
      }
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
  return (
    <button
      type={props.type ?? "button"}
      class={`${base} ${variant} ${size} ${props.class ?? ""}`}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.children}
    </button>
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
 *  `danger` turns rose on hover. The label lives in title + aria-label. */
export function IconBtn(props: {
  icon: string;
  title: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={props.title}
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

  const current = () =>
    props.options.find((o) => o.value === props.value) ?? {
      value: props.value,
      label: props.value || "Select…",
    };

  const onDocClick = (e: MouseEvent) => {
    if (root && !root.contains(e.target as Node)) setOpen(false);
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

  let listRef: HTMLDivElement | undefined;
  createMemo(() => {
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
          <div
            ref={listRef}
            role="listbox"
            class="anim-pop-in absolute left-0 right-0 top-full mt-1.5 z-40 max-h-64 overflow-y-auto rounded-xl border border-line bg-elev p-1 shadow-xl shadow-black/10"
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
        </Show>
      </div>
      <Show when={props.hint}>
        <span class="block text-xs text-ink-500 mt-1.5">{props.hint}</span>
      </Show>
    </label>
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
          class="fixed inset-0 z-50 overflow-y-auto bg-black/55 backdrop-blur-sm"
          onMouseDown={() => props.onClose()}
          role="dialog"
          aria-modal="true"
        >
          <div class="min-h-full flex items-center justify-center p-4">
            <div
              class={`anim-pop-in w-full ${props.width ?? "max-w-md"} rounded-[1.5rem] border border-line bg-card shadow-2xl shadow-black/30`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <div class="flex items-center justify-between px-6 py-4 border-b border-line">
                <h3 class="text-sm font-semibold">{props.title}</h3>
                <button
                  onClick={props.onClose}
                  class="rounded-lg p-1 text-ink-400 hover:text-ink-100 hover:bg-ink-800/60 transition-colors cursor-pointer"
                  aria-label="Close"
                >
                  <Icon name={Icons.x} />
                </button>
              </div>
              <div class="px-6 py-5">{props.children}</div>
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
    <div class="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 items-end">
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
