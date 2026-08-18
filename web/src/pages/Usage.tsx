import { createMemo, createResource, createSignal, Show } from "solid-js";

import { api, type ApiKeyDto } from "../api";
import { PageTitle } from "../index";
import { usalItems } from "../motion";
import { DailyChart } from "../charts";
import {
  Card,
  CardHeader,
  EmptyState,
  Icons,
  Segmented,
  Select,
  fmtNum,
  windowLabel,
} from "../ui";
import {
  UsageGrid,
  EPOCH_DATE_FILTER_PARAMS,
  ProtoCell,
  serverDatasource,
  StatusCell,
  latencyFormatter,
  timeFormatter,
  tokenFormatter,
} from "../aggrid";
import type { ColDef } from "ag-grid-community";

const EVENTS_BLOCK = 100;

interface BreakdownRow {
  key_id: string;
  key_name: string;
  model: string;
  proto: "openai" | "anthropic";
  provider_id: string;
  provider_name: string | null;
  provider_key_id: string;
  provider_key_label: string | null;
  upstream_model: string;
  in_tok: number;
  cache_tok: number;
  out_tok: number;
  reqs: number;
}

const fmtOrDash = (v: unknown) => (v == null || v === "" ? "—" : String(v));

const byModelCols: ColDef<BreakdownRow>[] = [
  {
    field: "model",
    headerName: "Model",
    flex: 1.2,
    valueFormatter: (p) => fmtOrDash(p.value),
  },
  {
    field: "proto",
    headerName: "Proto",
    width: 110,
    cellRenderer: ProtoCell,
  },
  {
    field: "provider_name",
    headerName: "Provider",
    flex: 1,
    valueFormatter: (p) => fmtOrDash(p.value),
  },
  {
    field: "upstream_model",
    headerName: "Upstream",
    flex: 1,
    valueFormatter: (p) => fmtOrDash(p.value),
  },
  {
    field: "provider_key_id",
    headerName: "Upstream key",
    flex: 0.8,
    valueGetter: (p) => p.data?.provider_key_label || p.data?.provider_key_id?.slice(0, 8) || "—",
    valueFormatter: (p) => p.value,
  },
  { field: "reqs", headerName: "Requests", width: 100, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "in_tok", headerName: "In", width: 100, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "cache_tok", headerName: "Cache", width: 110, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "out_tok", headerName: "Out", width: 110, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
];

const eventCols: ColDef[] = [
  // Formatted display ≠ raw epoch — no text filter on Time (sort stays).
  { field: "ts", headerName: "Time", width: 150, filter: "agDateColumnFilter", filterParams: EPOCH_DATE_FILTER_PARAMS, valueFormatter: timeFormatter },
  { field: "key_name", headerName: "Key", width: 140, flex: 0.8 },
  { field: "proto", headerName: "Protocol", width: 120, cellRenderer: ProtoCell },
  { field: "provider_name", headerName: "Provider", width: 150, flex: 1, valueFormatter: (p) => fmtOrDash(p.value) },
  { field: "model", headerName: "Model", flex: 1.2, valueFormatter: (p) => fmtOrDash(p.value) },
  { field: "upstream_model", headerName: "Upstream", width: 150, valueFormatter: (p) => fmtOrDash(p.value) },
  { field: "in_tok", headerName: "In", width: 90, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "cache_tok", headerName: "Cache", width: 100, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "out_tok", headerName: "Out", width: 100, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: tokenFormatter },
  { field: "latency_ms", headerName: "Latency", width: 100, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: latencyFormatter },
  { field: "status", headerName: "Status", width: 90, type: "rightAligned", filter: "agNumberColumnFilter", cellRenderer: StatusCell },
];

export default function UsagePage() {
  const [keyId, setKeyId] = createSignal("");
  const [days, setDays] = createSignal("14");
  const [chartMetric, setChartMetric] = createSignal<"tokens" | "requests">(
    "tokens",
  );

  const [keys] = createResource(async () => {
    const j = await api<{ keys: ApiKeyDto[] }>("GET", "/api/keys");
    return j.keys;
  });

  const query = createMemo(() => ({ k: keyId(), d: days() }));

  const [series] = createResource(query, async (q) => {
    const hourly = q.d === "1";
    const j = await api<{ series: any[] }>(
      "GET",
      `/api/usage/daily?${hourly ? "hours=24" : `days=${q.d}`}${q.k ? `&key_id=${q.k}` : ""}`,
    );
    return j.series;
  });

  const [breakdownCount] = createResource(query, async (q) => {
    const j = await api<{ total: number }>(
      "GET",
      `/api/usage/breakdown?days=${q.d}&limit=1${q.k ? `&key_id=${q.k}` : ""}`,
    );
    return j.total;
  });
  const breakdownDatasource = serverDatasource<BreakdownRow>(async (params) => {
    const qs = new URLSearchParams({
      days: days(),
      limit: String(Math.min(params.endRow - params.startRow, 500)),
      offset: String(params.startRow),
    });
    if (keyId()) qs.set("key_id", keyId());
    if (params.sortModel.length > 0) qs.set("sort", JSON.stringify(params.sortModel));
    if (Object.keys(params.filterModel).length > 0) qs.set("filters", JSON.stringify(params.filterModel));
    const j = await api<{ rows: BreakdownRow[]; total: number }>("GET", `/api/usage/breakdown?${qs}`);
    return { rows: j.rows, total: j.total };
  });

  // Header count only — LIMIT 1 (the grid below pulls its own blocks).
  const [eventCount] = createResource(query, async (q) => {
    const j = await api<{ total: number }>(
      "GET",
      `/api/usage/events?limit=1${q.k ? `&key_id=${q.k}` : ""}`,
    );
    return j.total;
  });

  /** AG Grid infinite row model: blocks are fetched from the API on scroll,
   *  with the grid's sortModel/filterModel translated to SQL server-side. */
  const eventsDatasource = serverDatasource<any>(async (params) => {
    const qs = new URLSearchParams({
      limit: String(Math.min(params.endRow - params.startRow, 500)),
      offset: String(params.startRow),
    });
    if (keyId()) qs.set("key_id", keyId());
    if (params.sortModel.length > 0) qs.set("sort", JSON.stringify(params.sortModel));
    if (Object.keys(params.filterModel).length > 0) {
      qs.set("filters", JSON.stringify(params.filterModel));
    }
    const j = await api<{ events: any[]; total: number }>(
      "GET",
      `/api/usage/events?${qs.toString()}`,
    );
    return { rows: j.events, total: j.total };
  });

  const keyOptions = createMemo(() => [
    { value: "", label: "All keys" },
    ...(keys() ?? []).map((k) => ({
      value: k.id,
      label: `${k.name} (${k.prefix}…)`,
    })),
  ]);

  return (
    <div>
      <PageTitle
        title="Usage"
        subtitle="Inspect consumption per key, provider, model and request"
      />

      <Card class="mb-6">
        <div class="flex flex-wrap gap-3 items-end justify-between px-6 pt-5">
          <div class="w-full sm:w-64">
            <Select
              label="Key"
              value={keyId()}
              onChange={setKeyId}
              options={keyOptions()}
            />
          </div>
          <div class="flex flex-wrap items-end gap-3">
            <Segmented
              class="mb-0.5"
              value={chartMetric()}
              onChange={setChartMetric}
              options={[
                { value: "tokens", label: "Tokens" },
                { value: "requests", label: "Requests" },
              ]}
            />
            <Segmented
              class="mb-0.5"
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
        </div>
        <div class="px-4 pb-4 pt-2">
          <Show when={series()} fallback={<div class="h-32" />}>
            <DailyChart
              series={series()!}
              metric={chartMetric()}
              unit={days() === "1" ? "hour" : "day"}
              resetKey={`${days()}:${keyId()}`}
            />
          </Show>
        </div>
      </Card>

      <Card class="mb-6">
        <CardHeader
          title="By model"
          subtitle={`Model × provider breakdown · ${windowLabel(days())}`}
        />
        <Show
          when={(breakdownCount() ?? 0) > 0}
          fallback={<EmptyState icon={Icons.chart} title="No model data in this window" />}
        >
          <div class="px-1 py-1">
            <UsageGrid
              columnDefs={byModelCols}
              datasource={breakdownDatasource}
              cacheBlockSize={100}
              refreshDeps={`${days()}:${keyId()}`}
              heightClass="h-[420px]"
              storageKey="llmgw-grid:usage.by-model"
            />
          </div>
        </Show>
      </Card>

      <Card>
        <CardHeader
          title="Recent requests"
          subtitle={`${fmtNum(eventCount() ?? 0)} events`}
        />
        <Show
          when={(eventCount() ?? 0) > 0}
          fallback={
            <EmptyState icon={Icons.chart} title="No requests in this window" />
          }
        >
          <div class="px-2 py-2">
            <UsageGrid
              columnDefs={eventCols}
              datasource={eventsDatasource}
              cacheBlockSize={EVENTS_BLOCK}
              refreshDeps={keyId()}
              heightClass="h-[560px]"
              storageKey="llmgw-grid:usage.recent"
            />
          </div>
        </Show>
      </Card>
    </div>
  );
}
