import {
  Area,
  Axis,
  AxisCursor,
  AxisGrid,
  AxisLabel,
  AxisLine,
  AxisTooltip,
  Bar,
  Chart,
  Line,
} from "solid-charts";
import { curveMonotoneX } from "solid-charts/curves";
import { Show, createEffect, createMemo, createSignal, type JSX } from "solid-js";

import type { DailyPoint } from "./api";
import { fmtNum } from "./ui";

const IN_BAR = "var(--chart-strong)";
const CACHE_BAR = "var(--chart-mid)";
const OUT_BAR = "var(--chart-soft)";

type DailyChartPoint = DailyPoint & {
  tick: string;
};

function ChartFrame(props: { height: number; children: JSX.Element }) {
  return (
    <div class="relative w-full" style={{ height: `${props.height}px` }}>
      {props.children}
    </div>
  );
}

function DailyTooltip(props: {
  data: DailyChartPoint;
  metric: "tokens" | "requests";
}) {
  return (
    <div class="z-20 min-w-32 rounded-xl border border-line bg-elev px-3 py-2 text-[11px] text-ink-200 shadow-xl shadow-black/10">
      <div class="mb-1.5 font-semibold text-ink-100">
        {props.data.label ?? props.data.date}
      </div>
      <Show
        when={props.metric === "tokens"}
        fallback={
          <div class="flex items-center justify-between gap-4">
            <span>Requests</span>
            <strong class="font-semibold text-ink-100">
              {fmtNum(props.data.reqs ?? 0)}
            </strong>
          </div>
        }
      >
        <div class="space-y-1">
          <div class="flex items-center justify-between gap-4">
            <span>Input</span>
            <strong class="font-semibold text-ink-100">
              {fmtNum(props.data.in_tok)}
            </strong>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span>Input cache</span>
            <strong class="font-semibold text-ink-100">
              {fmtNum(props.data.cache_tok ?? 0)}
            </strong>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span>Output</span>
            <strong class="font-semibold text-ink-100">
              {fmtNum(props.data.out_tok)}
            </strong>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span>Requests</span>
            <strong class="font-semibold text-ink-100">
              {fmtNum(props.data.reqs ?? 0)}
            </strong>
          </div>
        </div>
      </Show>
    </div>
  );
}

function chartBarIndex(event: MouseEvent): number | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const bar = target.closest("[data-sc-bar]");
  const group = bar?.parentElement;
  if (!bar || !group) return null;
  const bars = Array.from(group.children).filter((child) =>
    child.matches("[data-sc-bar]"),
  );
  const index = bars.indexOf(bar);
  return index >= 0 ? index : null;
}

export function DailyChart(props: {
  series: DailyPoint[];
  height?: number;
  metric?: "tokens" | "requests";
  unit?: "day" | "hour";
}) {
  const metric = () => props.metric ?? "tokens";
  const unit = () => props.unit ?? "day";
  const data = createMemo<DailyChartPoint[]>(() =>
    props.series.slice(-30).map((point) => ({
      ...point,
      tick: point.label ?? point.date.slice(5),
    })),
  );

  const [selected, setSelected] = createSignal<number | null>(null);
  createEffect(() => {
    props.series;
    setSelected(null);
  });
  const selectedDay = createMemo(() => {
    const index = selected();
    return index !== null ? (data()[index] ?? null) : null;
  });
  const toggleSelect = (index: number | null) => {
    if (index === null) return;
    setSelected(selected() === index ? null : index);
  };

  return (
    <Show
      when={data().length > 0}
      fallback={
        <div class="flex h-32 items-center justify-center text-xs text-ink-500">
          No usage data yet
        </div>
      }
    >
      <ChartFrame height={props.height ?? 180}>
        <Chart
          data={data()}
          barConfig={{ bandGap: "18%", barGap: "10%" }}
          class="chart-root"
          onClick={(event) => toggleSelect(chartBarIndex(event))}
        >
          <Axis axis="y" position="left" tickCount={5}>
            <AxisLabel
              fill="var(--chart-tick)"
              font-size="10"
              format={(value) => fmtNum(Number(value))}
            />
            <AxisGrid stroke="var(--chart-grid)" />
          </Axis>
          <Axis axis="x" position="bottom" dataKey="tick">
            <AxisLabel
              fill="var(--chart-tick)"
              font-size="10"
              interval={Math.max(1, Math.ceil(data().length / 6))}
            />
            <AxisLine stroke="var(--chart-grid)" />
            <AxisCursor
              stroke="var(--chart-grid)"
              stroke-dasharray="3 3"
              class="chart-cursor"
            />
            <AxisTooltip class="chart-tooltip">
              {(tooltip) => (
                <DailyTooltip data={tooltip.data} metric={metric()} />
              )}
            </AxisTooltip>
          </Axis>

          <Show
            when={metric() === "tokens"}
            fallback={
              <Bar
                dataKey="reqs"
                fill={OUT_BAR}
                rx={4}
                class="chart-bar chart-bar-requests"
              />
            }
          >
            <Bar
              dataKey="in_tok"
              fill={IN_BAR}
              rx={3}
              class="chart-bar chart-bar-input"
            />
            <Bar
              dataKey="cache_tok"
              fill={CACHE_BAR}
              rx={3}
              class="chart-bar"
            />
            <Bar
              dataKey="out_tok"
              fill={OUT_BAR}
              rx={3}
              class="chart-bar"
            />
          </Show>
        </Chart>
      </ChartFrame>
      <div class="flex min-h-[18px] flex-wrap items-center gap-x-4 gap-y-1 px-2 pt-1 text-[11px] text-ink-400">
        <Show
          when={selectedDay()}
          fallback={
            <>
              <Show
                when={metric() === "tokens"}
                fallback={
                  <span class="inline-flex items-center gap-1.5">
                    <span
                      class="inline-block h-2.5 w-2.5 rounded-sm"
                      style={{ background: OUT_BAR }}
                    />
                    Requests
                  </span>
                }
              >
                <span class="inline-flex items-center gap-1.5">
                  <span
                    class="inline-block h-2.5 w-2.5 rounded-sm"
                    style={{ background: IN_BAR }}
                  />
                  Input
                </span>
                <span class="inline-flex items-center gap-1.5">
                  <span
                    class="inline-block h-2.5 w-2.5 rounded-sm"
                    style={{ background: CACHE_BAR }}
                  />
                  Input cache
                </span>
                <span class="inline-flex items-center gap-1.5">
                  <span
                    class="inline-block h-2.5 w-2.5 rounded-sm"
                    style={{ background: OUT_BAR }}
                  />
                  Output
                </span>
              </Show>
              <span class="inline-flex items-center gap-1.5">
                <span class="inline-block h-2.5 w-2.5 rounded-sm bg-brand-500" />
                Latest {unit()}
              </span>
              <span class="ml-auto text-[10px] text-ink-500">
                Click a bar to pin
              </span>
            </>
          }
        >
          {(day) => (
            <>
              <span class="font-medium text-ink-200">
                {day().label ?? day().date}
              </span>
              <span class="inline-flex items-center gap-1.5">
                <span
                  class="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: IN_BAR }}
                />
                In {fmtNum(day().in_tok)}
              </span>
              <span class="inline-flex items-center gap-1.5">
                <span
                  class="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: CACHE_BAR }}
                />
                Cache {fmtNum(day().cache_tok ?? 0)}
              </span>
              <span class="inline-flex items-center gap-1.5">
                <span
                  class="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: OUT_BAR }}
                />
                Out {fmtNum(day().out_tok)}
              </span>
              <span class="tabular-nums">{fmtNum(day().reqs)} req</span>
              <button
                class="ml-auto cursor-pointer px-1 text-ink-500 transition-colors hover:text-ink-200"
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
  const points = createMemo(() => {
    const labels = props.labels ?? [];
    return props.values
      .map((value, index) => ({
        value,
        tick: labels[index] ?? "",
      }))
      .filter((point) => Number.isFinite(point.value));
  });

  return (
    <Show
      when={points().length > 0}
      fallback={
        <div class="flex h-32 items-center justify-center text-xs text-ink-500">
          No data yet
        </div>
      }
    >
      <ChartFrame height={props.height ?? 170}>
        <Chart data={points()} class="chart-root">
          <Axis axis="y" position="left" tickCount={5}>
            <AxisLabel
              fill="var(--chart-tick)"
              font-size="10"
              format={(value) => fmtNum(Number(value))}
            />
            <AxisGrid stroke="var(--chart-grid)" />
          </Axis>
          <Axis axis="x" position="bottom" dataKey="tick">
            <AxisLabel
              fill="var(--chart-tick)"
              font-size="10"
              interval={Math.max(1, Math.ceil(points().length / 4))}
            />
            <AxisLine stroke="var(--chart-grid)" />
            <AxisCursor
              stroke="var(--chart-grid)"
              stroke-dasharray="3 3"
              class="chart-cursor"
            />
            <AxisTooltip class="chart-tooltip">
              {(tooltip) => (
                <div class="z-20 min-w-28 rounded-xl border border-line bg-elev px-3 py-2 text-[11px] text-ink-200 shadow-xl shadow-black/10">
                  <div class="mb-1 font-semibold text-ink-100">
                    {tooltip.data.tick}
                  </div>
                  <div class="flex items-center justify-between gap-4">
                    <span>Requests</span>
                    <strong class="font-semibold text-ink-100">
                      {fmtNum(tooltip.data.value)}
                    </strong>
                  </div>
                </div>
              )}
            </AxisTooltip>
          </Axis>
          <Area
            dataKey="value"
            fill="var(--chart-brand)"
            fill-opacity={1}
            class="chart-area"
            curve={curveMonotoneX}
          />
          <Line
            dataKey="value"
            stroke="var(--chart-brand)"
            stroke-width={2}
            fill="none"
            pathLength={1}
            class="chart-line"
            curve={curveMonotoneX}
          />
        </Chart>
      </ChartFrame>
    </Show>
  );
}
