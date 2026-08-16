/**
 * Thin SolidJS wrapper around Apache ECharts (canvas renderer, tree-shaken to
 * just bar + line). Colors are resolved from the theme CSS vars at render
 * time and re-read whenever the theme flips, so white/dark charts stay in
 * sync with the rest of the UI.
 */
import { createEffect, onCleanup, type JSX } from "solid-js";
import * as echarts from "echarts/core";
import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { EChartsCoreOption } from "echarts/core";

echarts.use([
  BarChart,
  LineChart,
  GridComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export { echarts };

/** Resolve a CSS custom property to a concrete color (nested var() chains
 *  included) by reading it back from a live element. */
function resolveVar(name: string): string {
  const el = document.createElement("div");
  el.style.color = `var(${name})`;
  document.body.appendChild(el);
  const c = getComputedStyle(el).color;
  el.remove();
  return c;
}

export interface ChartColors {
  grid: string;
  tick: string;
  strong: string;
  mid: string;
  soft: string;
  brand: string;
  card: string;
  elev: string;
  line: string;
  ink100: string;
  ink400: string;
}

/** Snapshot of the theme chart palette (resolved, canvas-safe). */
export function chartColors(): ChartColors {
  return {
    grid: resolveVar("--chart-grid"),
    tick: resolveVar("--chart-tick"),
    strong: resolveVar("--chart-strong"),
    mid: resolveVar("--chart-mid"),
    soft: resolveVar("--chart-soft"),
    brand: resolveVar("--chart-brand"),
    card: resolveVar("--card"),
    elev: resolveVar("--elev"),
    line: resolveVar("--line"),
    ink100: resolveVar("--ink-100"),
    ink400: resolveVar("--ink-400"),
  };
}

/** Add an alpha channel to an rgb()/hex color string. */
export function withAlpha(color: string, alpha: number): string {
  const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
  return color;
}

/**
 * Renders an ECharts instance into a div, re-setting the option whenever the
 * `option()` getter's tracked dependencies change (data, theme, …). Resizes
 * with the container and disposes on unmount.
 */
export function EChart(props: {
  option: () => EChartsCoreOption;
  height?: number;
  class?: string;
  onClick?: (dataIndex: number) => void;
}): JSX.Element {
  let ref: HTMLDivElement | undefined;
  let chart: echarts.ECharts | undefined;
  let ro: ResizeObserver | undefined;

  createEffect(() => {
    const opt = props.option();
    if (!ref) return;
    if (!chart) {
      chart = echarts.init(ref, undefined, {
        width: ref.clientWidth || 320,
        height: props.height ?? 180,
      });
      ro = new ResizeObserver(() => chart?.resize());
      ro.observe(ref);
      if (props.onClick) {
        chart.on("click", (p) => {
          if (p.componentType === "series") props.onClick!(p.dataIndex as number);
        });
      }
    }
    chart.setOption(opt, { notMerge: true });
  });

  onCleanup(() => {
    ro?.disconnect();
    chart?.dispose();
    chart = undefined;
    ro = undefined;
  });

  return (
    <div
      ref={ref}
      class={props.class ?? ""}
      style={{ height: `${props.height ?? 180}px`, width: "100%" }}
    />
  );
}
