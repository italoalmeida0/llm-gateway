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
import { Show, createMemo, createUniqueId, type JSX } from "solid-js";

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

export function DailyChart(props: {
  series: DailyPoint[];
  height?: number;
  metric?: "tokens" | "requests";
  unit?: "day" | "hour";
  /** External filter key; changing it clears solid-charts hover state. */
  resetKey?: string;
}) {
  const metric = () => props.metric ?? "tokens";
  const unit = () => props.unit ?? "day";
  const data = createMemo<DailyChartPoint[]>(() =>
    props.series.slice(-30).map((point) => ({
      ...point,
      tick: point.label ?? point.date.slice(5),
    })),
  );

  return (
    <Show
      when={data().length > 0}
      fallback={
        <div class="flex h-32 items-center justify-center text-xs text-ink-500">
          No usage data yet
        </div>
      }
    >
      <Show when={`${props.resetKey ?? "default"}:${metric()}`} keyed>
        {(_resetKey) => (
          <ChartFrame height={props.height ?? 180}>
            {/* solid-charts 0.0.2 keeps the hovered tick in internal state.
                This keyed wrapper resets it when a provider/window/metric
                changes while the pointer is still over the SVG. */}
            <Show when={data()} keyed>
              {(chartData) => (
                <Chart
                  data={chartData}
                  barConfig={{ bandGap: "18%", barGap: "10%" }}
                  class="chart-root"
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
                      interval={Math.max(1, Math.ceil(chartData.length / 6))}
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
              )}
            </Show>
          </ChartFrame>
        )}
      </Show>
      <div class="flex min-h-[18px] flex-wrap items-center gap-x-4 gap-y-1 px-2 pt-1 text-[11px] text-ink-400">
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
          <>
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
          </>
        </Show>
        <span class="inline-flex items-center gap-1.5">
          <span class="inline-block h-2.5 w-2.5 rounded-sm bg-brand-500" />
          Latest {unit()}
        </span>
      </div>
    </Show>
  );
}

export function AreaChart(props: {
  values: number[];
  labels?: string[];
  height?: number;
  /** External filter key; changing it clears solid-charts hover state. */
  resetKey?: string;
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
  const gradientId = `chart-area-gradient-${createUniqueId()}`;

  return (
    <Show
      when={points().length > 0}
      fallback={
        <div class="flex h-32 items-center justify-center text-xs text-ink-500">
          No data yet
        </div>
      }
    >
      <Show when={props.resetKey ?? "default"} keyed>
        {(_resetKey) => (
          <ChartFrame height={props.height ?? 170}>
            <Show when={points()} keyed>
              {(chartPoints) => (
                <Chart data={chartPoints} class="chart-root">
                  <defs>
                    <linearGradient
                      id={gradientId}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                      gradientUnits="objectBoundingBox"
                    >
                      <stop offset="0%" stop-color="var(--chart-brand)" stop-opacity="0.3" />
                      <stop offset="100%" stop-color="var(--chart-brand)" stop-opacity="0" />
                    </linearGradient>
                  </defs>
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
                      interval={Math.max(1, Math.ceil(chartPoints.length / 4))}
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
                    fill={`url(#${gradientId})`}
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
              )}
            </Show>
          </ChartFrame>
        )}
      </Show>
    </Show>
  );
}
