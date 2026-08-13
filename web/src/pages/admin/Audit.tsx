import { createResource, createSignal, For, Show } from "solid-js";

import { api } from "../../api";
import { PageTitle } from "../../index";
import { usalItems } from "../../motion";
import {
  Badge,
  Btn,
  Card,
  CardHeader,
  EmptyState,
  Icons,
  fmtDate,
} from "../../ui";

const PAGE = 50;

export default function AdminAuditPage() {
  const [offset, setOffset] = createSignal(0);
  const [data] = createResource(offset, async (o) => {
    const j = await api<{ entries: any[]; total: number }>(
      "GET",
      `/api/admin/audit?limit=${PAGE}&offset=${o}`,
    );
    return j;
  });

  const page = () => Math.floor(offset() / PAGE) + 1;
  const pages = () => Math.max(1, Math.ceil((data()?.total ?? 0) / PAGE));

  return (
    <div>
      <PageTitle
        title="Audit log"
        subtitle="Admin actions and security events"
      />

      <Card>
        <CardHeader
          title={`${data()?.total ?? 0} events`}
          right={
            <div class="flex items-center gap-2">
              <Btn
                variant="outline"
                size="sm"
                disabled={page() <= 1}
                onClick={() => setOffset(Math.max(0, offset() - PAGE))}
              >
                Prev
              </Btn>
              <span class="text-xs text-ink-400">
                {page()} / {pages()}
              </span>
              <Btn
                variant="outline"
                size="sm"
                disabled={page() >= pages()}
                onClick={() => setOffset(offset() + PAGE)}
              >
                Next
              </Btn>
            </div>
          }
        />
        <Show
          when={(data()?.entries.length ?? 0) > 0}
          fallback={<EmptyState icon={Icons.book} title="No audit entries" />}
        >
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="text-left text-[10px] uppercase tracking-wider text-ink-500 border-b border-line">
                  <th class="font-medium px-6 py-3">Time</th>
                  <th class="font-medium px-3 py-3">Action</th>
                  <th class="font-medium px-3 py-3">Actor</th>
                  <th class="font-medium px-3 py-3">Target</th>
                  <th class="font-medium px-3 py-3">IP</th>
                  <th class="font-medium px-3 py-3">Detail</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-line">
                <For each={data()?.entries}>
                  {(e) => (
                    <tr class="transition-colors hover:bg-ink-800/30">
                      <td class="px-6 py-3 text-ink-300 whitespace-nowrap">
                        {fmtDate(e.ts)}
                      </td>
                      <td class="px-3 py-3">
                        <Badge
                          tone={
                            e.action.includes("failed") ||
                            e.action.includes("exhausted") ||
                            e.action.includes("banned") ||
                            e.action.includes("deleted") ||
                            e.action.includes("revoked")
                              ? "red"
                              : e.action.includes("created") ||
                                  e.action.includes("success") ||
                                  e.action.includes("linked") ||
                                  e.action.includes("enabled")
                                ? "green"
                                : "zinc"
                          }
                        >
                          {e.action}
                        </Badge>
                      </td>
                      <td class="px-3 py-3 text-ink-300">
                        {e.actor_email ?? e.target ?? "—"}
                      </td>
                      <td class="px-3 py-3 text-ink-400 font-mono text-[11px]">
                        {e.target?.slice(0, 24) ?? "—"}
                      </td>
                      <td class="px-3 py-3 text-ink-400">{e.ip ?? "—"}</td>
                      <td
                        class="px-3 py-3 text-ink-500 max-w-48 truncate"
                        title={e.meta ?? ""}
                      >
                        {e.meta ?? "—"}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Card>
    </div>
  );
}
