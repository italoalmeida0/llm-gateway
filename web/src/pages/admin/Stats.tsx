import { createMemo, createResource, createSignal, Show } from "solid-js";

import { api, type DailyPoint, type ProviderDto } from "../../api";
import { PageTitle } from "../../index";
import { usalItems } from "../../motion";
import { DailyChart } from "../../charts";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Icons,
  Segmented,
  Select,
  StatCard,
  Tooltip,
  fmtNum,
  windowLabel,
} from "../../ui";
import {
  UsageGrid,
  ProtoCell,
  serverDatasource,
  countFormatter,
  tokenFormatter,
  type GridTotals,
} from "../../aggrid";
import type { ColDef } from "ag-grid-community";

interface Buckets {
  in_tok: number;
  cache_tok: number;
  out_tok: number;
  reqs: number;
}

interface StatsDto {
  series: DailyPoint[];
  counts: {
    users: number;
    keys: number;
    activeKeys: number;
    providers: number;
  };
  kvCache?: KvCacheSnapshot;
}

/** btdby4 KV provider snapshot (server memoizes it for 60s). */
interface KvCacheSnapshot {
  namespaces: number;
  nodes: number;
  branches: number;
  tokens: number;
  bytes: number;
  max_bytes: number;
  available_bytes: number;
  ttl_seconds: number;
  captured_at: number;
  stale: boolean;
}

interface UserRow extends Buckets {
  user_id: string;
  email: string;
}

interface ModelRow extends Buckets {
  model: string;
  proto: string;
  provider_id: string;
  provider_name: string | null;
  provider_key_id: string;
  provider_key_label: string | null;
  upstream_model: string;
}

const fmtOrDash = (v: unknown) => (v == null || v === "" ? "—" : String(v));

const userCols: ColDef<UserRow>[] = [
  { field: "email", headerName: "User", flex: 1.4 },
  { field: "in_tok", headerName: "In", width: 110, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "cache_tok", headerName: "Cache", width: 120, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "out_tok", headerName: "Out", width: 120, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "reqs", headerName: "Requests", width: 110, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: countFormatter },
];

const modelCols: ColDef<ModelRow>[] = [
  { field: "model", headerName: "Model", flex: 1.2, valueFormatter: (p) => fmtOrDash(p.value) },
  { field: "proto", headerName: "Proto", width: 110, cellRenderer: ProtoCell },
  { field: "provider_name", headerName: "Provider", flex: 1, valueFormatter: (p) => fmtOrDash(p.value) },
  { field: "upstream_model", headerName: "Upstream", flex: 1, valueFormatter: (p) => fmtOrDash(p.value) },
  {
    field: "provider_key_id",
    headerName: "Upstream key",
    flex: 0.8,
    valueGetter: (p) => p.data?.provider_key_label || p.data?.provider_key_id?.slice(0, 8) || "—",
    valueFormatter: (p) => p.value,
  },
  { field: "reqs", headerName: "Requests", width: 100, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: countFormatter },
  { field: "in_tok", headerName: "In", width: 100, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "cache_tok", headerName: "Cache", width: 110, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "out_tok", headerName: "Out", width: 110, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
];

/** Compact MB formatter for the KV chip (10.4/400 MB). */
function fmtMB(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 100 ? String(Math.round(mb)) : mb.toFixed(1);
}

/** KV-cache chip for the Global overview header: used/cap % + TTL.
 * The snapshot rides the stats payload (memoized server-side for 60s),
 * so the chip never polls — it renders what arrived with the page. */
function KvCacheChip(props: { snapshot?: KvCacheSnapshot }) {
  const snap = () => props.snapshot;
  const used = () => snap()?.bytes ?? 0;
  const cap = () => Math.max(1, snap()?.max_bytes ?? 1);
  const pct = () => Math.min(100, (used() / cap()) * 100);
  const ttlMin = () => Math.round((snap()?.ttl_seconds ?? 600) / 60);
  const tone = () => (pct() >= 90 ? "red" : pct() >= 70 ? "amber" : "zinc");
  const tip = () => {
    const s = snap();
    if (!s) return "KV cache snapshot unavailable";
    const age = Math.max(0, Math.round((Date.now() - s.captured_at) / 1000));
    return (
      <span>
        Prefix-cache kept inside btdby4 for zero-usage inference
        <br />
        {s.namespaces} namespace(s) · {s.nodes} node(s) · {s.branches} branche(s) · {fmtNum(s.tokens)} token(s)
        <br />
        Snapshot {age}s old (refreshes every 60s)
      </span>
    );
  };
  return (
    <Show when={snap()}>
      <Tooltip content={tip()}>
        <span class="inline-flex items-center">
          <Badge tone={tone()}>
            KV {fmtMB(used())}/{fmtMB(cap())} MB {pct() < 10 && pct() > 0 ? pct().toFixed(1) : Math.round(pct())}% · TTL {ttlMin()} MIN
          </Badge>
        </span>
      </Tooltip>
    </Show>
  );
}

/** Card heading split in two tight spans so long windows never wrap. */
function CardLabel(props: { title: string; window: string }) {
  return (
    <span class="flex flex-col gap-0.5 leading-tight whitespace-nowrap">
      <span class="text-ink-400">{props.title}</span>
      <span class="text-[10px] uppercase tracking-wider text-ink-600">
        {props.window}
      </span>
    </span>
  );
}

export default function AdminStatsPage() {
  const [days, setDays] = createSignal("14");
  const [providerId, setProviderId] = createSignal("");

  const statsQuery = createMemo(() => ({ d: days(), p: providerId() }));
  const [stats] = createResource(statsQuery, async (q) => {
    const params = new URLSearchParams(
      q.d === "1" ? { hours: "24" } : { days: q.d },
    );
    if (q.p) params.set("provider_id", q.p);
    return api<StatsDto>("GET", `/api/admin/stats?${params.toString()}`);
  });

  const [providers] = createResource(async () => {
    const j = await api<{ providers: ProviderDto[] }>("GET", "/api/admin/providers");
    return j.providers;
  });
  const providerOptions = createMemo(() => [
    { value: "", label: "All providers" },
    ...(providers() ?? []).map((p) => ({ value: p.id, label: p.name })),
  ]);

  const [breakdownCounts] = createResource(statsQuery, async (q) => {
    const params = new URLSearchParams({ days: q.d, limit: "1" });
    if (q.p) params.set("provider_id", q.p);
    const [users, models] = await Promise.all([
      api<{ total: number }>("GET", `/api/admin/usage-breakdown/users?${params.toString()}`),
      api<{ total: number }>("GET", `/api/admin/usage-breakdown/models?${params.toString()}`),
    ]);
    return { users: users.total, models: models.total };
  });
  const [usersTotals, setUsersTotals] = createSignal<GridTotals | null>(null);
  const [modelsTotals, setModelsTotals] = createSignal<GridTotals | null>(null);
  const usersDatasource = serverDatasource<UserRow>(async (params) => {
    const qs = new URLSearchParams({
      days: days(),
      limit: String(Math.min(params.endRow - params.startRow, 500)),
      offset: String(params.startRow),
    });
    if (providerId()) qs.set("provider_id", providerId());
    if (params.sortModel.length > 0) qs.set("sort", JSON.stringify(params.sortModel));
    if (Object.keys(params.filterModel).length > 0) qs.set("filters", JSON.stringify(params.filterModel));
    const j = await api<{ users: UserRow[]; total: number; totals?: GridTotals }>("GET", `/api/admin/usage-breakdown/users?${qs}`);
    if (j.totals) setUsersTotals(j.totals);
    return { rows: j.users, total: j.total };
  });
  const modelsDatasource = serverDatasource<ModelRow>(async (params) => {
    const qs = new URLSearchParams({
      days: days(),
      limit: String(Math.min(params.endRow - params.startRow, 500)),
      offset: String(params.startRow),
    });
    if (providerId()) qs.set("provider_id", providerId());
    if (params.sortModel.length > 0) qs.set("sort", JSON.stringify(params.sortModel));
    if (Object.keys(params.filterModel).length > 0) qs.set("filters", JSON.stringify(params.filterModel));
    const j = await api<{ models: ModelRow[]; total: number; totals?: GridTotals }>("GET", `/api/admin/usage-breakdown/models?${qs}`);
    if (j.totals) setModelsTotals(j.totals);
    return { rows: j.models, total: j.total };
  });

  // Window totals are summed from the displayed series (per bucket — never
  // one lumped "tokens" number), so the cards describe exactly what the
  // chart below shows.
  const winIn = createMemo(() =>
    (stats()?.series ?? []).reduce((s, d) => s + (d.in_tok ?? 0), 0),
  );
  const winCache = createMemo(() =>
    (stats()?.series ?? []).reduce((s, d) => s + (d.cache_tok ?? 0), 0),
  );
  const winOut = createMemo(() =>
    (stats()?.series ?? []).reduce((s, d) => s + (d.out_tok ?? 0), 0),
  );
  const winReqs = createMemo(() =>
    (stats()?.series ?? []).reduce((s, d) => s + (d.reqs ?? 0), 0),
  );

  return (
    <div>
      <PageTitle
        title="Global overview"
        subtitle="All users, all keys"
        right={
          <div class="flex flex-wrap items-end gap-3">
            <div class="pb-0.5">
              <KvCacheChip snapshot={stats()?.kvCache} />
            </div>
            <div class="w-56">
              <Select
                label="Provider"
                value={providerId()}
                onChange={setProviderId}
                options={providerOptions()}
              />
            </div>
            <Segmented
              value={days()}
              onChange={setDays}
              options={[
                { value: "1", label: "1D" },
                { value: "7", label: "7D" },
                { value: "14", label: "14D" },
                { value: "30", label: "30D" },
                { value: "90", label: "90D" },
                { value: "all", label: "ALL" },
              ]}
            />
          </div>
        }
      />

      <Show when={stats() && !stats.loading}>
        <div
          class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4 mb-5"
          {...usalItems("fade-u", 90)}
        >
          <StatCard
            icon={Icons.chart}
            label={<CardLabel title="Input" window={windowLabel(days())} />}
            countValue={winIn()}
          />
          <StatCard
            icon={Icons.bolt}
            label={
              <CardLabel title="Input cache" window={windowLabel(days())} />
            }
            countValue={winCache()}
          />
          <StatCard
            icon={Icons.arrowUpRight}
            label={<CardLabel title="Output" window={windowLabel(days())} />}
            countValue={winOut()}
            sub={<span>{fmtNum(winReqs())} requests in window</span>}
          />
          <StatCard
            icon={Icons.users}
            label={<CardLabel title="Users" window={" "} />}
            countValue={stats()!.counts.users}
            sub={<span>{stats()!.counts.providers} provider(s)</span>}
          />
          <StatCard
            icon={Icons.key}
            label={<CardLabel title="API keys" window={" "} />}
            value={`${stats()!.counts.activeKeys}/${stats()!.counts.keys}`}
            sub={<span>active / total</span>}
          />
        </div>

        <Card class="mb-5">
          <CardHeader
            title={days() === "1" ? "Hourly usage" : "Daily usage"}
            subtitle={`Tokens per ${days() === "1" ? "hour" : "day"} (UTC)`}
          />
          <div class="px-4 pb-4">
            <DailyChart
              series={stats()!.series}
              unit={days() === "1" ? "hour" : "day"}
              resetKey={`${days()}:${providerId()}`}
            />
          </div>
        </Card>

        <div class="flex flex-col gap-4" {...usalItems("fade-u", 90)}>
          <Card>
            <CardHeader
              title="Top users"
              subtitle={`By category · ${windowLabel(days())}`}
            />
            <Show
              when={!breakdownCounts.loading}
              fallback={<div class="p-5 text-xs text-ink-500">Loading…</div>}
            >
              <Show
                when={(breakdownCounts()?.users ?? 0) > 0}
                fallback={
                  <div class="p-5">
                    <EmptyState icon={Icons.users} title="No user data in this window" />
                  </div>
                }
              >
                <div class="p-2">
                  <UsageGrid
                    columnDefs={userCols}
                    datasource={usersDatasource}
                    cacheBlockSize={100}
                    refreshDeps={`${days()}:${providerId()}`}
                    storageKey="llmgw-grid:admin.stats.users"
                    totals={usersTotals()}
                  />
                </div>
              </Show>
            </Show>
          </Card>

          <Card>
            <CardHeader
              title="Models by provider"
              subtitle={`Model × provider breakdown · ${windowLabel(days())}`}
            />
            <Show
              when={!breakdownCounts.loading}
              fallback={<div class="p-5 text-xs text-ink-500">Loading…</div>}
            >
              <Show
                when={(breakdownCounts()?.models ?? 0) > 0}
                fallback={
                  <div class="p-5">
                    <EmptyState icon={Icons.chart} title="No model data in this window" />
                  </div>
                }
              >
                <div class="p-2">
                  <UsageGrid
                    columnDefs={modelCols}
                    datasource={modelsDatasource}
                    cacheBlockSize={100}
                    refreshDeps={`${days()}:${providerId()}`}
                    storageKey="llmgw-grid:admin.stats.models"
                    totals={modelsTotals()}
                  />
                </div>
              </Show>
            </Show>
          </Card>
        </div>
      </Show>
    </div>
  );
}
