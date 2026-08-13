import { createMemo, createResource, createSignal, For, Show } from "solid-js";

import { api, type ApiKeyDto, type UsageEventDto } from "../api";
import { PageTitle } from "../index";
import { usalItems } from "../motion";
import { DailyChart } from "../charts";
import {
  Badge,
  Btn,
  Card,
  CardHeader,
  EmptyState,
  Icons,
  Segmented,
  Select,
  fmtDate,
  fmtNum,
} from "../ui";

const PAGE_SIZE = 25;

export default function UsagePage() {
  const [keyId, setKeyId] = createSignal("");
  const [offset, setOffset] = createSignal(0);
  const [days, setDays] = createSignal("14");
  const [chartMetric, setChartMetric] = createSignal<"tokens" | "requests">(
    "tokens",
  );

  const [keys] = createResource(async () => {
    const j = await api<{ keys: ApiKeyDto[] }>("GET", "/api/keys");
    return j.keys;
  });

  const query = createMemo(() => ({ k: keyId(), d: days(), o: offset() }));

  const [series] = createResource(query, async (q) => {
    const j = await api<{ series: any[] }>(
      "GET",
      `/api/usage/daily?days=${q.d}${q.k ? `&key_id=${q.k}` : ""}`,
    );
    return j.series;
  });

  interface ModelRow {
    model: string;
    proto: string;
    in_tok: number;
    out_tok: number;
    reqs: number;
  }
  const [byModel] = createResource(query, async (q) => {
    const j = await api<{ models: ModelRow[] }>(
      "GET",
      `/api/usage/by-model?days=${q.d}${q.k ? `&key_id=${q.k}` : ""}`,
    );
    return j.models;
  });
  const byModelSorted = createMemo(() =>
    [...(byModel() ?? [])]
      .sort((a, b) => b.in_tok + b.out_tok - (a.in_tok + a.out_tok))
      .slice(0, 10),
  );

  const [events] = createResource(query, async (q) => {
    const j = await api<{ events: UsageEventDto[]; total: number }>(
      "GET",
      `/api/usage/events?limit=${PAGE_SIZE}&offset=${q.o}${q.k ? `&key_id=${q.k}` : ""}`,
    );
    return j;
  });

  const keyOptions = createMemo(() => [
    { value: "", label: "All keys" },
    ...(keys() ?? []).map((k) => ({
      value: k.id,
      label: `${k.name} (${k.prefix}…)`,
    })),
  ]);

  const totalPages = createMemo(() =>
    Math.max(1, Math.ceil((events()?.total ?? 0) / PAGE_SIZE)),
  );
  const page = createMemo(() => Math.floor(offset() / PAGE_SIZE) + 1);

  return (
    <div>
      <PageTitle
        title="Usage"
        subtitle="Inspect consumption per key, model and request"
      />

      <Card class="mb-6">
        <div class="flex flex-wrap gap-3 items-end justify-between px-6 pt-5">
          <div class="w-full sm:w-64">
            <Select
              label="Key"
              value={keyId()}
              onChange={(v) => {
                setKeyId(v);
                setOffset(0);
              }}
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
                { value: "7", label: "7D" },
                { value: "14", label: "14D" },
                { value: "30", label: "30D" },
                { value: "90", label: "90D" },
              ]}
            />
          </div>
        </div>
        <div class="px-4 pb-4 pt-2">
          <Show when={series()} fallback={<div class="h-32" />}>
            <DailyChart series={series()!} metric={chartMetric()} />
          </Show>
        </div>
      </Card>

      <Card class="mb-6">
        <CardHeader
          title="By model"
          subtitle={`Top models in the last ${days()} days`}
        />
        <Show
          when={(byModelSorted().length ?? 0) > 0}
          fallback={
            <EmptyState
              icon={Icons.chart}
              title="No model data in this window"
            />
          }
        >
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="text-left text-[10px] uppercase tracking-wider text-ink-500 border-b border-line">
                  <th class="font-medium px-6 py-3">Model</th>
                  <th class="font-medium px-3 py-3">Proto</th>
                  <th class="font-medium px-3 py-3 text-right">Requests</th>
                  <th class="font-medium px-3 py-3 text-right">In</th>
                  <th class="font-medium px-3 py-3 text-right">Out</th>
                  <th class="font-medium px-3 py-3 text-right">Tokens</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-line">
                <For each={byModelSorted()}>
                  {(m) => (
                    <tr class="transition-colors hover:bg-ink-800/30">
                      <td class="px-6 py-3 text-ink-200">{m.model}</td>
                      <td class="px-3 py-2.5">
                        <Badge tone={m.proto === "openai" ? "blue" : "amber"}>
                          {m.proto === "openai" ? "OpenAI" : "Anthropic"}
                        </Badge>
                      </td>
                      <td class="px-3 py-2.5 text-right tabular-nums text-ink-400">
                        {fmtNum(m.reqs)}
                      </td>
                      <td class="px-3 py-2.5 text-right tabular-nums">
                        {fmtNum(m.in_tok)}
                      </td>
                      <td class="px-3 py-2.5 text-right tabular-nums">
                        {fmtNum(m.out_tok)}
                      </td>
                      <td class="px-3 py-2.5 text-right tabular-nums">
                        {fmtNum(m.in_tok + m.out_tok)}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Card>

      <Card>
        <CardHeader
          title="Recent requests"
          subtitle={`${fmtNum(events()?.total ?? 0)} events`}
          right={
            <div class="flex items-center gap-2">
              <Btn
                variant="outline"
                size="sm"
                disabled={page() <= 1}
                onClick={() => setOffset(Math.max(0, offset() - PAGE_SIZE))}
              >
                Prev
              </Btn>
              <span class="text-xs text-ink-400">
                {page()} / {totalPages()}
              </span>
              <Btn
                variant="outline"
                size="sm"
                disabled={page() >= totalPages()}
                onClick={() => setOffset(offset() + PAGE_SIZE)}
              >
                Next
              </Btn>
            </div>
          }
        />
        <Show
          when={(events()?.events.length ?? 0) > 0}
          fallback={
            <EmptyState icon={Icons.chart} title="No requests in this window" />
          }
        >
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="text-left text-[10px] uppercase tracking-wider text-ink-500 border-b border-line">
                  <th class="font-medium px-6 py-3">Time</th>
                  <th class="font-medium px-3 py-3">Key</th>
                  <th class="font-medium px-3 py-3">Protocol</th>
                  <th class="font-medium px-3 py-3">Model</th>
                  <th class="font-medium px-3 py-3 text-right">In</th>
                  <th class="font-medium px-3 py-3 text-right">Out</th>
                  <th class="font-medium px-3 py-3 text-right">Latency</th>
                  <th class="font-medium px-3 py-3 text-right">Status</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-line">
                <For each={events()?.events}>
                  {(e) => {
                    const keyName = createMemo(
                      () =>
                        (keys() ?? []).find((k) => k.id === e.key_id)?.name ??
                        e.key_id.slice(0, 8),
                    );
                    return (
                      <tr class="transition-colors hover:bg-ink-800/30">
                        <td class="px-6 py-3 text-ink-300 whitespace-nowrap">
                          {fmtDate(e.ts)}
                        </td>
                        <td class="px-3 py-2.5 text-ink-300">{keyName()}</td>
                        <td class="px-3 py-2.5">
                          <Badge
                            tone={e.proto === "openai" ? "blue" : "amber"}
                          >
                            {e.proto === "openai" ? "OpenAI" : "Anthropic"}
                          </Badge>
                          <Show when={e.stream === 1}>
                            <span class="ml-1 text-ink-500">SSE</span>
                          </Show>
                        </td>
                        <td class="px-3 py-2.5 text-ink-300">
                          {e.model || "—"}
                        </td>
                        <td class="px-3 py-2.5 text-right tabular-nums">
                          {fmtNum(e.in_tok)}
                        </td>
                        <td class="px-3 py-2.5 text-right tabular-nums">
                          {fmtNum(e.out_tok)}
                        </td>
                        <td class="px-3 py-2.5 text-right tabular-nums text-ink-400">
                          {e.latency_ms}ms
                        </td>
                        <td class="px-3 py-2.5 text-right">
                          <Badge
                            tone={
                              e.status < 400
                                ? "green"
                                : e.status < 500
                                  ? "amber"
                                  : "red"
                            }
                          >
                            {e.status}
                          </Badge>
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Card>
    </div>
  );
}
