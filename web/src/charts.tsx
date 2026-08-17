import { Show, createEffect, createMemo, createSignal } from "solid-js";

import type { DailyPoint } from "./api";
import { EChart, chartColors, withAlpha } from "./echarts";
import { fmtNum, theme } from "./ui";

/**
 * ECharts-based usage charts. Colors are resolved from the theme CSS vars
 * (--chart-*) at render time and re-read when the theme flips, so white/dark
 * flip for free. Bars: one per token bucket — input (strong ink), cached
 * input (mid) and output (muted) — grouped per day, or a single requests bar
 * when metric is "requests"; the latest day is highlighted brand red.
 * Clicking a bar pins that day's metadata into the legend row (click again /
 * × to clear); hovering shows a rich tooltip.
 */

const IN_BAR = "var(--chart-strong)";
const CACHE_BAR = "var(--chart-mid)";
const OUT_BAR = "var(--chart-soft)";

export function DailyChart(props: {
  series: DailyPoint[];
  height?: number;
  metric?: "tokens" | "requests";
  unit?: "day" | "hour";
}) {
  const metric = () => props.metric ?? "tokens";
  const unit = () => props.unit ?? "day";
  const tickOf = (d: DailyPoint) => d.label ?? d.date.slice(5);
  const data = createMemo(() => props.series.slice(-30));

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
  const toggleSelect = (i: number) => setSelected(selected() === i ? null : i);

  const option = createMemo(() => {
    void theme();
    const c = chartColors();
    const ds = data();
    const isTokens = metric() === "tokens";
    const latest = ds.length - 1;
    const tooltip = {
      trigger: "axis" as const,
      position: "top" as const,
      confine: true,
      backgroundColor: c.elev,
      borderColor: c.line,
      borderWidth: 1,
      textStyle: { color: c.ink100, fontSize: 11 },
      formatter: (params: unknown) => {
        const arr = (Array.isArray(params) ? params : [params]) as Array<{
          dataIndex: number;
        }>;
        const d = ds[arr[0]?.dataIndex ?? 0];
        if (!d) return "";
        const rows = isTokens
          ? [
              `Input: <b>${fmtNum(d.in_tok)}</b>`,
              `Input cache: <b>${fmtNum(d.cache_tok ?? 0)}</b>`,
              `Output: <b>${fmtNum(d.out_tok)}</b>`,
              `Requests: <b>${fmtNum(d.reqs ?? 0)}</b>`,
            ]
          : [`Requests: <b>${fmtNum(d.reqs ?? 0)}</b>`];
        return `<div style="font-weight:600;margin-bottom:4px">${d.label ?? d.date}</div>${rows.join("<br/>")}`;
      },
    };
    const base = {
      animationDuration: 600,
      grid: { left: 8, right: 8, top: 12, bottom: 4, containLabel: true },
      xAxis: {
        type: "category" as const,
        data: ds.map(tickOf),
        axisLine: { lineStyle: { color: c.grid } },
        axisTick: { show: false },
        axisLabel: {
          color: c.tick,
          fontSize: 10,
          interval: Math.max(0, Math.ceil(ds.length / 6) - 1),
        },
      },
      yAxis: {
        type: "value" as const,
        splitLine: { lineStyle: { color: c.grid } },
        axisLabel: {
          color: c.tick,
          fontSize: 10,
          formatter: (v: number) => fmtNum(v),
        },
      },
      tooltip,
    };
    if (!isTokens) {
      return {
        ...base,
        series: [
          {
            name: "Requests",
            type: "bar" as const,
            barWidth: "38%",
            itemStyle: { color: c.soft, borderRadius: [4, 4, 0, 0] },
            data: ds.map((d, i) => ({
              value: d.reqs ?? 0,
              itemStyle:
                i === latest
                  ? { color: c.brand, borderRadius: [4, 4, 0, 0] }
                  : { color: c.soft, borderRadius: [4, 4, 0, 0] },
            })),
          },
        ],
      };
    }
    return {
      ...base,
      series: [
        {
          name: "Input",
          type: "bar" as const,
          itemStyle: { color: c.strong, borderRadius: [3, 3, 0, 0] },
          data: ds.map((d, i) => ({
            value: d.in_tok,
            itemStyle:
              i === latest
                ? { color: c.brand, borderRadius: [3, 3, 0, 0] }
                : { color: c.strong, borderRadius: [3, 3, 0, 0] },
          })),
        },
        {
          name: "Input cache",
          type: "bar" as const,
          itemStyle: { color: c.mid, borderRadius: [3, 3, 0, 0] },
          data: ds.map((d) => ({ value: d.cache_tok ?? 0 })),
        },
        {
          name: "Output",
          type: "bar" as const,
          itemStyle: { color: c.soft, borderRadius: [3, 3, 0, 0] },
          data: ds.map((d) => ({ value: d.out_tok })),
        },
      ],
    };
  });

  return (
    <Show
      when={data().length > 0}
      fallback={
        <div class="h-32 flex items-center justify-center text-xs text-ink-500">
          No usage data yet
        </div>
      }
    >
      <EChart
        option={option}
        height={props.height ?? 180}
        onClick={(i) => toggleSelect(i)}
      />
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 px-2 pt-1 min-h-[18px] text-[11px] text-ink-400">
        <Show
          when={selectedDay()}
          fallback={
            <>
              <Show
                when={metric() === "tokens"}
                fallback={
                  <span class="inline-flex items-center gap-1.5">
                    <span
                      class="w-2.5 h-2.5 rounded-sm inline-block"
                      style={{ background: OUT_BAR }}
                    />{" "}
                    Requests
                  </span>
                }
              >
                <span class="inline-flex items-center gap-1.5">
                  <span
                    class="w-2.5 h-2.5 rounded-sm inline-block"
                    style={{ background: IN_BAR }}
                  />{" "}
                  Input
                </span>
                <span class="inline-flex items-center gap-1.5">
                  <span
                    class="w-2.5 h-2.5 rounded-sm inline-block"
                    style={{ background: CACHE_BAR }}
                  />{" "}
                  Input cache
                </span>
                <span class="inline-flex items-center gap-1.5">
                  <span
                    class="w-2.5 h-2.5 rounded-sm inline-block"
                    style={{ background: OUT_BAR }}
                  />{" "}
                  Output
                </span>
              </Show>
              <span class="inline-flex items-center gap-1.5">
                <span class="w-2.5 h-2.5 rounded-sm bg-brand-500 inline-block" />{" "}
                Latest {unit()}
              </span>
              <span class="ml-auto text-[10px] text-ink-500">
                Click a bar to pin
              </span>
            </>
          }
        >
          {(d) => (
            <>
              <span class="font-medium text-ink-200">
                {d().label ?? d().date}
              </span>
              <span class="inline-flex items-center gap-1.5">
                <span
                  class="w-2.5 h-2.5 rounded-sm inline-block"
                  style={{ background: IN_BAR }}
                />
                In {fmtNum(d().in_tok)}
              </span>
              <span class="inline-flex items-center gap-1.5">
                <span
                  class="w-2.5 h-2.5 rounded-sm inline-block"
                  style={{ background: CACHE_BAR }}
                />
                Cache {fmtNum(d().cache_tok ?? 0)}
              </span>
              <span class="inline-flex items-center gap-1.5">
                <span
                  class="w-2.5 h-2.5 rounded-sm inline-block"
                  style={{ background: OUT_BAR }}
                />
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

export function AreaChart(props: {
  values: number[];
  labels?: string[];
  height?: number;
}) {
  const pts = createMemo(() => {
    const labels = props.labels ?? [];
    return props.values
      .map((v, i) => ({ v, label: labels[i] ?? "" }))
      .filter((p) => Number.isFinite(p.v));
  });

  const option = createMemo(() => {
    void theme();
    const c = chartColors();
    const p = pts();
    const n = p.length;
    return {
      animationDuration: 600,
      grid: { left: 8, right: 8, top: 12, bottom: 4, containLabel: true },
      xAxis: {
        type: "category" as const,
        boundaryGap: false,
        data: p.map((x) => x.label),
        axisLine: { lineStyle: { color: c.grid } },
        axisTick: { show: false },
        axisLabel: {
          color: c.tick,
          fontSize: 10,
          interval: Math.max(0, Math.ceil(n / 4) - 1),
        },
      },
      yAxis: {
        type: "value" as const,
        splitLine: { lineStyle: { color: c.grid } },
        axisLabel: {
          color: c.tick,
          fontSize: 10,
          formatter: (v: number) => fmtNum(v),
        },
      },
      tooltip: {
        trigger: "axis" as const,
        position: "top" as const,
        confine: true,
        backgroundColor: c.elev,
        borderColor: c.line,
        borderWidth: 1,
        textStyle: { color: c.ink100, fontSize: 11 },
        valueFormatter: (v: unknown) => fmtNum(Number(v)),
      },
      series: [
        {
          name: "Requests",
          type: "line" as const,
          smooth: true,
          symbol: "none",
          lineStyle: { color: c.brand, width: 2 },
          itemStyle: { color: c.brand },
          emphasis: { disabled: true },
          areaStyle: { color: withAlpha(c.brand, 0.15) },
          data: p.map((x) => x.v),
        },
      ],
    };
  });

  return (
    <Show
      when={pts().length > 0}
      fallback={
        <div class="h-32 flex items-center justify-center text-xs text-ink-500">
          No data yet
        </div>
      }
    >
      <EChart option={option} height={props.height ?? 170} />
    </Show>
  );
}
