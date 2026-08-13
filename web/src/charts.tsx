import { For, Show, createEffect, createMemo, createSignal } from "solid-js";

import type { DailyPoint } from "./api";
import { fmtNum } from "./ui";

/**
 * Tiny hand-rolled SVG charts — no chart lib. Colors come from theme CSS
 * vars (--chart-*), so white/dark flip for free. Bars: one per token bucket —
 * input (strong ink), cached input (mid) and output (muted) — grouped per
 * day, or a single requests bar when metric is "requests"; the latest day is
 * highlighted brand red. Clicking a bar pins that day's metadata into the
 * legend row (click again / × to clear).
 * Area: smooth brand-red curve with gradient fill.
 */

const GRID = "var(--chart-grid)";
const TICK = "var(--chart-tick)";
const IN_BAR = "var(--chart-strong)";
const CACHE_BAR = "var(--chart-mid)";
const OUT_BAR = "var(--chart-soft)";
const BRAND = "var(--chart-brand)";

export function DailyChart(props: {
  series: DailyPoint[];
  height?: number;
  metric?: "tokens" | "requests";
  /** What one bar represents — drives legend pin text ("Latest day/hour"). */
  unit?: "day" | "hour";
}) {
  const W = 720;
  const H = props.height ?? 180;
  const PAD = { l: 40, r: 6, t: 14, b: 26 };

  const metric = () => props.metric ?? "tokens";
  const unit = () => props.unit ?? "day";
  const tickOf = (d: DailyPoint) => d.label ?? d.date.slice(5);
  const data = createMemo(() => props.series.slice(-30));
  const maxV = createMemo(() =>
    Math.max(
      1,
      ...data().map((d) =>
        metric() === "requests"
          ? (d.reqs ?? 0)
          : Math.max(d.in_tok ?? 0, d.cache_tok ?? 0, d.out_tok ?? 0),
      ),
    ),
  );

  const slotW = createMemo(() => (W - PAD.l - PAD.r) / Math.max(1, data().length));
  /** Three token bars (in/cache/out) fit side by side inside one day slot. */
  const barW = createMemo(() => Math.max(2, Math.min(9, slotW() * 0.22)));
  const BAR_GAP = 2;

  const barX = (i: number, which: "in" | "cache" | "out") => {
    const center = PAD.l + slotW() * i + slotW() / 2;
    const clusterW = barW() * 3 + BAR_GAP * 2;
    const start = center - clusterW / 2;
    return start + (which === "in" ? 0 : which === "cache" ? barW() + BAR_GAP : 2 * (barW() + BAR_GAP));
  };
  /** Centered single bar (requests metric). */
  const soloX = (i: number) => PAD.l + slotW() * i + slotW() / 2 - barW() - 1;
  const yFor = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - v / maxV());

  const ticks = createMemo(() => [0, 0.5, 1].map((f) => Math.round(maxV() * f)));

  /** Clicked/pinned day — its metadata replaces the legend row. Reset when
   *  a new series arrives (key/days/window change). */
  const [selected, setSelected] = createSignal<number | null>(null);
  createEffect(() => {
    props.series;
    setSelected(null);
  });
  const selectedDay = createMemo(() => {
    const i = selected();
    return i !== null ? (data()[i] ?? null) : null;
  });
  const toggleSelect = (i: number) =>
    setSelected(selected() === i ? null : i);

  return (
    <Show
      when={data().length > 0}
      fallback={<div class="h-32 flex items-center justify-center text-xs text-ink-500">No usage data yet</div>}
    >
      <svg viewBox={`0 0 ${W} ${H}`} class="w-full" role="img" aria-label="Daily token usage chart">
        <For each={ticks()}>
          {(t) => (
            <g>
              <line x1={PAD.l} x2={W - PAD.r} y1={yFor(t)} y2={yFor(t)} stroke={GRID} stroke-width="1" />
              <text x={PAD.l - 6} y={yFor(t) + 3} text-anchor="end" font-size="9" fill={TICK}>
                {fmtNum(t)}
              </text>
            </g>
          )}
        </For>
        <For each={data()}>
          {(d, i) => {
            const latest = () => i() === data().length - 1;
            // Branch with <Show> (never if/return): a For child body runs once
            // per item, so a plain if/else branch would go stale when the
            // metric flips — leaving bars with the previous branch's shape.
            return (
              <g class="group cursor-pointer" onClick={() => toggleSelect(i())}>
                <title>{`${d.date} — in ${fmtNum(d.in_tok)}, cache ${fmtNum(d.cache_tok ?? 0)}, out ${fmtNum(d.out_tok)}, ${fmtNum(d.reqs ?? 0)} req`}</title>
                <Show
                  when={metric() === "tokens"}
                  fallback={
                    <rect
                      x={soloX(i())}
                      y={yFor(d.reqs ?? 0)}
                      width={barW() * 2 + 2}
                      height={Math.max(0, ((d.reqs ?? 0) / maxV()) * (H - PAD.t - PAD.b))}
                      rx="2.5"
                      fill={latest() ? BRAND : OUT_BAR}
                      stroke={selected() === i() ? BRAND : "none"}
                      stroke-width="1.5"
                      class={`chart-bar transition-opacity duration-200 group-hover:opacity-80 ${latest() ? "glow-brand" : ""}`}
                      style={{ "animation-delay": `${i() * 35}ms` }}
                    />
                  }
                >
                  <rect
                    x={barX(i(), "in")}
                    y={yFor(d.in_tok)}
                    width={barW()}
                    height={Math.max(0, (d.in_tok / maxV()) * (H - PAD.t - PAD.b))}
                    rx="2.5"
                    fill={latest() ? BRAND : IN_BAR}
                    stroke={selected() === i() ? BRAND : "none"}
                    stroke-width="1.5"
                    class={`chart-bar transition-opacity duration-200 group-hover:opacity-80 ${latest() ? "glow-brand" : ""}`}
                    style={{ "animation-delay": `${i() * 35}ms` }}
                  />
                  <rect
                    x={barX(i(), "cache")}
                    y={yFor(d.cache_tok ?? 0)}
                    width={barW()}
                    height={Math.max(0, ((d.cache_tok ?? 0) / maxV()) * (H - PAD.t - PAD.b))}
                    rx="2.5"
                    fill={CACHE_BAR}
                    stroke={selected() === i() ? BRAND : "none"}
                    stroke-width="1.5"
                    class="chart-bar transition-opacity duration-200 group-hover:opacity-80"
                    style={{ "animation-delay": `${i() * 35 + 30}ms` }}
                  />
                  <rect
                    x={barX(i(), "out")}
                    y={yFor(d.out_tok)}
                    width={barW()}
                    height={Math.max(0, (d.out_tok / maxV()) * (H - PAD.t - PAD.b))}
                    rx="2.5"
                    fill={OUT_BAR}
                    stroke={selected() === i() ? BRAND : "none"}
                    stroke-width="1.5"
                    class="chart-bar transition-opacity duration-200 group-hover:opacity-80"
                    style={{ "animation-delay": `${i() * 35 + 60}ms` }}
                  />
                </Show>
              </g>
            );
          }}
        </For>
        <For each={data().filter((_, i) => i % Math.ceil(data().length / 6) === 0)}>
          {(d) => {
            const i = () => data().indexOf(d);
            return (
              <text x={PAD.l + slotW() * i() + slotW() / 2} y={H - 8} text-anchor="middle" font-size="9" fill={TICK}>
                {tickOf(d)}
              </text>
            );
          }}
        </For>
      </svg>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 px-2 pt-1 min-h-[18px] text-[11px] text-ink-400">
        <Show
          when={selectedDay()}
          fallback={
            <>
              <Show
                when={metric() === "tokens"}
                fallback={
                  <span class="inline-flex items-center gap-1.5">
                    <span class="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: OUT_BAR }} /> Requests
                  </span>
                }
              >
                <span class="inline-flex items-center gap-1.5">
                  <span class="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: IN_BAR }} /> Input tokens
                </span>
                <span class="inline-flex items-center gap-1.5">
                  <span class="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: CACHE_BAR }} /> Cached input
                </span>
                <span class="inline-flex items-center gap-1.5">
                  <span class="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: OUT_BAR }} /> Output tokens
                </span>
              </Show>
              <span class="inline-flex items-center gap-1.5">
                <span class="w-2.5 h-2.5 rounded-sm bg-brand-500 inline-block" /> Latest {unit()}
              </span>
              <span class="ml-auto text-[10px] text-ink-500">Click a bar to pin {unit() === "hour" ? "an" : "a"} {unit()}</span>
            </>
          }
        >
          {(d) => (
            <>
              <span class="font-medium text-ink-200">{d().label ?? d().date}</span>
              <span class="inline-flex items-center gap-1.5">
                <span class="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: IN_BAR }} />
                In {fmtNum(d().in_tok)}
              </span>
              <span class="inline-flex items-center gap-1.5">
                <span class="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: CACHE_BAR }} />
                Cache {fmtNum(d().cache_tok ?? 0)}
              </span>
              <span class="inline-flex items-center gap-1.5">
                <span class="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: OUT_BAR }} />
                Out {fmtNum(d().out_tok)}
              </span>
              <span class="tabular-nums">{fmtNum(d().reqs)} req</span>
              <button
                class="ml-auto px-1 cursor-pointer text-ink-500 hover:text-ink-200 transition-colors"
                onClick={() => setSelected(null)}
                aria-label="Clear selected day"
              >
                ×
              </button>
            </>
          )}
        </Show>
      </div>
    </Show>
  );
}

/** Smooth path through points (Catmull-Rom → cubic Bézier). */
function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0]!.x} ${pts[0]!.y}`;
  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

let gradientSeq = 0;

export function AreaChart(props: { values: number[]; labels?: string[]; height?: number }) {
  const W = 720;
  const H = props.height ?? 170;
  const PAD = { l: 10, r: 10, t: 14, b: 26 };
  const gid = `area-fill-${++gradientSeq}`;

  const vals = createMemo(() => props.values.filter((v) => Number.isFinite(v)));
  const maxV = createMemo(() => Math.max(1, ...vals()));

  const pts = createMemo(() => {
    const n = vals().length;
    if (n === 0) return [];
    return vals().map((v, i) => ({
      x: n === 1 ? W / 2 : PAD.l + ((W - PAD.l - PAD.r) / (n - 1)) * i,
      y: PAD.t + (H - PAD.t - PAD.b) * (1 - v / maxV()),
    }));
  });

  const line = createMemo(() => smoothPath(pts()));
  const area = createMemo(() =>
    pts().length > 0
      ? `${line()} L ${pts()[pts().length - 1]!.x} ${H - PAD.b} L ${pts()[0]!.x} ${H - PAD.b} Z`
      : "",
  );

  const labelIdx = createMemo(() => {
    const labels = props.labels ?? [];
    if (labels.length === 0) return [] as Array<{ i: number; text: string }>;
    const n = labels.length;
    const step = Math.max(1, Math.floor((n - 1) / 3));
    const idx = new Set<number>([0, step, 2 * step, n - 1]);
    return [...idx]
      .filter((i) => i >= 0 && i < n)
      .sort((a, b) => a - b)
      .map((i) => ({ i, text: labels[i]! }));
  });

  return (
    <Show
      when={pts().length > 0}
      fallback={<div class="h-32 flex items-center justify-center text-xs text-ink-500">No data yet</div>}
    >
      <svg viewBox={`0 0 ${W} ${H}`} class="w-full" role="img" aria-label="Trend chart">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color={BRAND} stop-opacity="0.25" />
            <stop offset="100%" stop-color={BRAND} stop-opacity="0" />
          </linearGradient>
        </defs>
        <line x1={PAD.l} x2={W - PAD.r} y1={yGrid(H, PAD, 0.5)} y2={yGrid(H, PAD, 0.5)} stroke={GRID} stroke-width="1" />
        <line x1={PAD.l} x2={W - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke={GRID} stroke-width="1" />
        <path d={area()} fill={`url(#${gid})`} />
        <path d={line()} fill="none" stroke={BRAND} stroke-width="2" stroke-linecap="round" />
        <circle
          cx={pts()[pts().length - 1]!.x}
          cy={pts()[pts().length - 1]!.y}
          r="4"
          fill={BRAND}
          stroke="var(--ink-900)"
          stroke-width="2"
          class="glow-brand"
        />
        <For each={labelIdx()}>
          {(l) => (
            <text x={pts()[l.i]?.x ?? 0} y={H - 8} text-anchor="middle" font-size="9" fill={TICK}>
              {l.text}
            </text>
          )}
        </For>
      </svg>
    </Show>
  );
}

function yGrid(H: number, PAD: { b: number; t: number }, f: number): number {
  return PAD.t + (H - PAD.t - PAD.b) * (1 - f);
}
