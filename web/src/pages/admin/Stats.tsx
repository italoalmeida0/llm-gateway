import { createMemo, createResource, createSignal, Show } from "solid-js";

import { api, type DailyPoint, type ProviderDto } from "../../api";
import { PageTitle } from "../../index";
import { usalItems } from "../../motion";
import { DailyChart } from "../../charts";
import {
  Card,
  CardHeader,
  Icons,
  Segmented,
  Select,
  StatCard,
  fmtNum,
  windowLabel,
} from "../../ui";
import {
  UsageGrid,
  ProtoCell,
  countFormatter,
  tokenFormatter,
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
  { field: "in_tok", headerName: "In", width: 110, type: "rightAligned", valueFormatter: tokenFormatter },
  { field: "cache_tok", headerName: "Cache", width: 120, type: "rightAligned", valueFormatter: tokenFormatter },
  { field: "out_tok", headerName: "Out", width: 120, type: "rightAligned", valueFormatter: tokenFormatter },
  { field: "reqs", headerName: "Requests", width: 110, type: "rightAligned", valueFormatter: countFormatter },
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
  { field: "reqs", headerName: "Requests", width: 100, type: "rightAligned", valueFormatter: countFormatter },
  { field: "in_tok", headerName: "In", width: 100, type: "rightAligned", valueFormatter: tokenFormatter },
  { field: "cache_tok", headerName: "Cache", width: 110, type: "rightAligned", valueFormatter: tokenFormatter },
  { field: "out_tok", headerName: "Out", width: 110, type: "rightAligned", valueFormatter: tokenFormatter },
];

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

  const breakdownQuery = createMemo(() => ({
    d: days(),
    p: providerId(),
  }));
  const [breakdown] = createResource(breakdownQuery, async (q) => {
    const params = new URLSearchParams({ days: q.d });
    if (q.p) params.set("provider_id", q.p);
    return api<{ users: UserRow[]; models: ModelRow[] }>(
      "GET",
      `/api/admin/usage-breakdown?${params.toString()}`,
    );
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

      <Show when={stats()}>
        <div
          class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4 mb-6"
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

        <Card class="mb-6">
          <CardHeader
            title={days() === "1" ? "Hourly usage" : "Daily usage"}
            subtitle={`Tokens per ${days() === "1" ? "hour" : "day"} (UTC)`}
          />
          <div class="px-4 pb-4">
            <DailyChart
              series={stats()!.series}
              unit={days() === "1" ? "hour" : "day"}
            />
          </div>
        </Card>

        <div class="flex flex-col gap-6" {...usalItems("fade-u", 90)}>
          <Card>
            <CardHeader
              title="Top users"
              subtitle={`By category · ${windowLabel(days())}`}
            />
            <div class="p-2" {...usalItems("fade-u", 60)}>
              <UsageGrid
                columnDefs={userCols}
                rowData={breakdown()?.users}
                pageSize={15}
                storageKey="llmgw-grid:admin.users"
              />
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Models by provider"
              subtitle={`Model × provider breakdown · ${windowLabel(days())}`}
            />
            <div class="p-2" {...usalItems("fade-u", 60)}>
              <UsageGrid
                columnDefs={modelCols}
                rowData={breakdown()?.models}
                pageSize={15}
                storageKey="llmgw-grid:admin.models"
              />
            </div>
          </Card>
        </div>
      </Show>
    </div>
  );
}