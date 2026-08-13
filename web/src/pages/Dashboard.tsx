import {
  createMemo,
  createResource,
  createSignal,
  Show,
  type JSX,
} from "solid-js";

import { api, type ApiKeyDto, type DailyPoint } from "../api";
import { PageTitle, navigate } from "../index";
import { DailyChart, AreaChart } from "../charts";
import { usal, usalItems } from "../motion";
import {
  Card,
  CountUp,
  DeltaPill,
  Icon,
  IconTile,
  Icons,
  ProgressBar,
  Segmented,
  fmtNum,
  pointLabel,
  windowLabel,
} from "../ui";

/** % change of the second half vs the first half of `series`; null if no base. */
function deltaPct(
  series: DailyPoint[],
  pick: (d: DailyPoint) => number,
): number | null {
  const half = Math.floor(series.length / 2);
  if (half < 1) return null;
  const prev = series.slice(0, half).reduce((s, d) => s + pick(d), 0);
  const cur = series.slice(-half).reduce((s, d) => s + pick(d), 0);
  if (prev <= 0) return null;
  return ((cur - prev) / prev) * 100;
}

function HeroHeader(props: {
  icon: string;
  count: number;
  label: string;
  delta: number | null;
}) {
  return (
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="text-xs font-medium text-ink-500 mb-2">{props.label}</div>
        <div class="text-[40px] leading-tight font-light tracking-tight">
          <CountUp value={props.count} />
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <Show when={props.delta !== null}>
          <DeltaPill pct={props.delta!} />
        </Show>
        <IconTile icon={props.icon} class="w-10 h-10" />
      </div>
    </div>
  );
}

/** One token bucket: big number on top, colored dot + label + delta beneath. */
function BucketStat(props: {
  label: string;
  count: number;
  delta: number | null;
  color: string;
}) {
  return (
    <div class="min-w-0">
      <div class="text-[28px] leading-tight font-light tracking-tight truncate">
        <CountUp value={props.count} />
      </div>
      <div class="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-500 min-h-[22px]">
        <span
          class="w-2 h-2 rounded-sm inline-block shrink-0"
          style={{ background: props.color }}
        />
        <span class="truncate">{props.label}</span>
        <Show when={props.delta !== null}>
          <DeltaPill pct={props.delta!} />
        </Show>
      </div>
    </div>
  );
}

const IN_COLOR = "var(--chart-strong)";
const CACHE_COLOR = "var(--chart-mid)";
const OUT_COLOR = "var(--chart-soft)";

export default function DashboardPage() {
  const [days, setDays] = createSignal("14");

  // Fetch double the window so the delta can compare against the previous
  // period — for the 1D view that means 48 hourly buckets (last 24h shown).
  // "all" is already unbounded, nothing to double.
  const [series] = createResource(days, async (d) => {
    const query =
      d === "1" ? "hours=48" : d === "all" ? "days=all" : `days=${Number(d) * 2}`;
    const j = await api<{ series: DailyPoint[] }>("GET", `/api/usage/daily?${query}`);
    return j.series;
  });
  const [keys] = createResource(async () => {
    const j = await api<{ keys: ApiKeyDto[] }>("GET", "/api/keys");
    return j.keys;
  });

  const view = createMemo(() => {
    const s = series() ?? [];
    if (days() === "1") return s.slice(-24);
    if (days() === "all") return s;
    return s.slice(-Number(days()));
  });
  // Three separate buckets — never one lumped "total tokens" number.
  const winIn = createMemo(() => view().reduce((s, d) => s + (d.in_tok ?? 0), 0));
  const winCache = createMemo(() => view().reduce((s, d) => s + (d.cache_tok ?? 0), 0));
  const winOut = createMemo(() => view().reduce((s, d) => s + (d.out_tok ?? 0), 0));
  const winReqs = createMemo(() => view().reduce((s, d) => s + (d.reqs ?? 0), 0));
  const inDelta = createMemo(() => deltaPct(series() ?? [], (d) => d.in_tok ?? 0));
  const cacheDelta = createMemo(() => deltaPct(series() ?? [], (d) => d.cache_tok ?? 0));
  const outDelta = createMemo(() => deltaPct(series() ?? [], (d) => d.out_tok ?? 0));
  const reqDelta = createMemo(() =>
    deltaPct(series() ?? [], (d) => d.reqs ?? 0),
  );

  const budget = createMemo(() => {
    const ks = keys() ?? [];
    return {
      cap: ks.reduce((s, k) => s + (k.totalLimit ?? 0), 0),
      used: ks.reduce((s, k) => s + (k.outputTotal ?? 0), 0),
    };
  });
  const activeKeys = createMemo(
    () => (keys() ?? []).filter((k) => k.status === "active").length,
  );

  const todayStr = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div>
      <PageTitle
        title="Usage overview"
        subtitle={`${todayStr} · Live from your gateway keys`}
        right={
          <Segmented
            value={days()}
            onChange={setDays}
            options={[
              { value: "1", label: "1D" },
              { value: "7", label: "7D" },
              { value: "14", label: "14D" },
              { value: "30", label: "30D" },
              { value: "all", label: "ALL" },
            ]}
          />
        }
      />

      {/* Gate on the resource: CountUp mounts once with final values — a
          late series() update would hit a text node USAL already replaced. */}
      <Show when={series()}>
        {() => (
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6" {...usalItems("fade-u", 110)}>
            <Card interactive class="p-6">
              <div class="flex items-start justify-between gap-3 mb-4">
                <div class="text-xs font-medium text-ink-500">
                  Tokens · {windowLabel(days())}
                </div>
                <IconTile icon={Icons.chart} class="w-10 h-10" />
              </div>
              <div class="grid grid-cols-3 gap-3">
                <BucketStat label="Input" count={winIn()} delta={inDelta()} color={IN_COLOR} />
                <BucketStat label="Input cache" count={winCache()} delta={cacheDelta()} color={CACHE_COLOR} />
                <BucketStat label="Output" count={winOut()} delta={outDelta()} color={OUT_COLOR} />
              </div>
              <div class="mt-4" {...usal("fade-u delay-250 duration-700 threshold-5")}>
                <DailyChart series={view()} unit={days() === "1" ? "hour" : "day"} />
              </div>
            </Card>

            <Card interactive class="p-6">
              <HeroHeader
                icon={Icons.bolt}
                count={winReqs()}
                label={`Requests · ${windowLabel(days())}`}
                delta={reqDelta()}
              />
              <div class="mt-5 pt-4 border-t border-line flex items-center gap-2.5">
                <span class="w-7 h-7 rounded-lg bg-elev border border-line inline-flex items-center justify-center text-ink-400 shrink-0">
                  <Icon name={Icons.key} size={13} />
                </span>
                <span class="text-xs text-ink-500">Active keys</span>
                <span class="ml-auto text-base font-semibold text-ink-100 tabular-nums">
                  {activeKeys()}
                </span>
              </div>
              <div class="mt-4" {...usal("fade-u delay-350 duration-700 threshold-5")}>
                <AreaChart
                  values={view().map((d) => d.reqs ?? 0)}
                  labels={view().map((d) => pointLabel(d))}
                />
              </div>
            </Card>
          </div>
        )}
      </Show>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-5" {...usalItems("fade-u", 110)}>
        <Card class="p-6">
          <div class="flex items-start justify-between gap-3 mb-4">
            <div>
              <h2 class="text-sm font-semibold text-ink-100">Output token budget</h2>
              <p class="text-xs text-ink-500 mt-0.5">Across all your keys</p>
            </div>
            <IconTile icon={Icons.key} class="w-9 h-9 rounded-xl" />
          </div>
          <Show
            when={budget().cap > 0}
            fallback={
              <div>
                <div class="text-[28px] font-light tracking-tight mb-2">Unlimited</div>
                <p class="text-xs text-ink-500 leading-relaxed">
                  No lifetime output caps set. Add a total output limit to any
                  key to track spend against a cap here.
                </p>
              </div>
            }
          >
            <div class="flex items-baseline gap-2 mb-3">
              <span class="text-[28px] font-light tracking-tight">
                <CountUp value={budget().used} />
              </span>
              <span class="text-sm text-ink-500">
                of {fmtNum(budget().cap)} output tokens
              </span>
            </div>
            <ProgressBar value={budget().used} max={budget().cap} danger />
            <div class="mt-2.5 text-[11px] text-ink-500 tabular-nums">
              {budget().cap > 0
                ? `${Math.min(100, Math.round((budget().used / budget().cap) * 100))}% of the combined caps consumed`
                : ""}
            </div>
          </Show>
        </Card>

        <Card class="p-6">
          <div class="mb-4">
            <h2 class="text-sm font-semibold text-ink-100">
              Endpoint configuration
            </h2>
            <p class="text-xs text-ink-500 mt-0.5">
              Point your tools at this gateway
            </p>
          </div>
          <div class="grid gap-3">
            <EndpointRow
              label="OpenAI-compatible"
              value={`${location.origin}/openai/v1`}
            />
            <EndpointRow
              label="Anthropic-compatible"
              value={`${location.origin}/anthropic/v1`}
            />
            <Show when={(keys() ?? []).length === 0}>
              <button
                onClick={() => navigate("/keys")}
                class="group mt-1 w-full rounded-2xl bg-accent-500 text-accent-fg px-5 py-3.5 text-sm font-medium flex items-center justify-between transition-all duration-300 hover:shadow-lg cursor-pointer"
                {...usal("zoomin-15 delay-150 duration-500")}
              >
                Create your first API key
                <Icon
                  name={Icons.arrowUpRight}
                  size={16}
                  class="transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                />
              </button>
            </Show>
          </div>
        </Card>
      </div>
    </div>
  );
}

function EndpointRow(props: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div class="text-xs font-medium text-ink-500 mb-1.5">{props.label}</div>
      <code class="block rounded-xl bg-elev border border-line px-3.5 py-2.5 text-xs text-ink-200 select-all break-all transition-colors hover:border-ink-600">
        {props.value}
      </code>
    </div>
  );
}
