import { createResource, createSignal, For, Show } from "solid-js";

import { api, type DailyPoint } from "../../api";
import { PageTitle } from "../../index";
import { usalItems } from "../../motion";
import { DailyChart } from "../../charts";
import {
  Badge,
  Card,
  CardHeader,
  Icons,
  Segmented,
  StatCard,
  fmtNum,
} from "../../ui";

interface StatsDto {
  series: DailyPoint[];
  perUser: Array<{
    user_id: string;
    email: string;
    in_tok: number;
    out_tok: number;
    reqs: number;
  }>;
  perModel: Array<{
    model: string;
    proto: string;
    in_tok: number;
    out_tok: number;
    reqs: number;
  }>;
  totals: { in_tok: number; out_tok: number; reqs: number };
  today: { in_tok: number; out_tok: number; reqs: number };
  counts: {
    users: number;
    keys: number;
    activeKeys: number;
    providers: number;
  };
}

export default function AdminStatsPage() {
  const [days, setDays] = createSignal("14");
  const [stats] = createResource(days, async (d) => {
    const j = await api<StatsDto>("GET", `/api/admin/stats?days=${d}`);
    return j;
  });

  return (
    <div>
      <PageTitle
        title="Global overview"
        subtitle="All users, all keys"
        right={
          <Segmented
            value={days()}
            onChange={setDays}
            options={[
              { value: "7", label: "7D" },
              { value: "14", label: "14D" },
              { value: "30", label: "30D" },
              { value: "90", label: "90D" },
            ]}
          />
        }
      />

      <Show when={stats()}>
        <div
          class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6"
          {...usalItems("fade-u", 90)}
        >
          <StatCard
            icon={Icons.bolt}
            label="Tokens today"
            countValue={
              (stats()!.today.in_tok ?? 0) + (stats()!.today.out_tok ?? 0)
            }
            sub={<span>{fmtNum(stats()!.today.reqs)} requests</span>}
          />
          <StatCard
            icon={Icons.chart}
            label="Tokens all-time"
            countValue={
              (stats()!.totals.in_tok ?? 0) + (stats()!.totals.out_tok ?? 0)
            }
            sub={<span>{fmtNum(stats()!.totals.reqs)} requests</span>}
          />
          <StatCard
            icon={Icons.users}
            label="Users"
            countValue={stats()!.counts.users}
            sub={<span>{stats()!.counts.providers} provider(s)</span>}
          />
          <StatCard
            icon={Icons.key}
            label="API keys"
            value={`${stats()!.counts.activeKeys}/${stats()!.counts.keys}`}
            sub={<span>active / total</span>}
          />
        </div>

        <Card class="mb-6">
          <CardHeader
            title="Daily usage (global)"
            subtitle="Input + output tokens per day (UTC)"
          />
          <div class="px-4 pb-4">
            <DailyChart series={stats()!.series} />
          </div>
        </Card>

        <div
          class="grid grid-cols-1 lg:grid-cols-2 gap-6"
          {...usalItems("fade-u", 90)}
        >
          <Card>
            <CardHeader
              title="Top users"
              subtitle={`Tokens in the last ${days()} days`}
            />
            <div class="overflow-x-auto">
              <table class="w-full text-xs">
                <thead>
                  <tr class="text-left text-[10px] uppercase tracking-wider text-ink-500 border-b border-line">
                    <th class="font-medium px-6 py-3">User</th>
                    <th class="font-medium px-3 py-3 text-right">In</th>
                    <th class="font-medium px-3 py-3 text-right">Out</th>
                    <th class="font-medium px-3 py-3 text-right">Requests</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-line">
                  <For each={stats()!.perUser}>
                    {(u) => (
                      <tr class="transition-colors hover:bg-ink-800/30">
                        <td class="px-6 py-3 text-ink-200">{u.email}</td>
                        <td class="px-3 py-3 text-right tabular-nums">
                          {fmtNum(u.in_tok)}
                        </td>
                        <td class="px-3 py-3 text-right tabular-nums">
                          {fmtNum(u.out_tok)}
                        </td>
                        <td class="px-3 py-3 text-right tabular-nums text-ink-400">
                          {fmtNum(u.reqs)}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Top models"
              subtitle={`Requests + tokens in the last ${days()} days`}
            />
            <div class="overflow-x-auto">
              <table class="w-full text-xs">
                <thead>
                  <tr class="text-left text-[10px] uppercase tracking-wider text-ink-500 border-b border-line">
                    <th class="font-medium px-6 py-3">Model</th>
                    <th class="font-medium px-3 py-3">Proto</th>
                    <th class="font-medium px-3 py-3 text-right">Tokens</th>
                    <th class="font-medium px-3 py-3 text-right">Requests</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-line">
                  <For each={stats()!.perModel}>
                    {(m) => (
                      <tr class="transition-colors hover:bg-ink-800/30">
                        <td class="px-6 py-3 text-ink-200">{m.model || "—"}</td>
                        <td class="px-3 py-3">
                          <Badge
                            tone={m.proto === "openai" ? "blue" : "amber"}
                          >
                            {m.proto === "openai" ? "OpenAI" : "Anthropic"}
                          </Badge>
                        </td>
                        <td class="px-3 py-3 text-right tabular-nums">
                          {fmtNum(m.in_tok + m.out_tok)}
                        </td>
                        <td class="px-3 py-3 text-right tabular-nums text-ink-400">
                          {fmtNum(m.reqs)}
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </Show>
    </div>
  );
}
