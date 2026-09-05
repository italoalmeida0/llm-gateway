import { createResource, Show } from "solid-js";

import { api } from "../../api";
import { PageTitle } from "../../index";
import { Badge, Card, CardHeader, EmptyState, Icons, fmtNum } from "../../ui";
import { DateTimeFilter, DateTimeFloatingFilter, UsageGrid, serverDatasource, timeFormatter } from "../../aggrid";
import type { ColDef } from "ag-grid-community";

interface AuditEntry {
  id: number;
  ts: number;
  action: string;
  target?: string;
  meta?: string;
  ip?: string;
  actor_email?: string;
}

/** Tone heuristic — red for bad-outcome actions, green for creations. */
function ActionCell(props: { value?: string }) {
  const a = props.value ?? "";
  const tone =
    a.includes("failed") ||
    a.includes("exhausted") ||
    a.includes("banned") ||
    a.includes("deleted") ||
    a.includes("revoked")
      ? "red"
      : a.includes("created") ||
          a.includes("success") ||
          a.includes("linked") ||
          a.includes("enabled")
        ? "green"
        : "zinc";
  return <Badge tone={tone}>{a}</Badge>;
}

export default function AdminAuditPage() {
  const [auditCount] = createResource(async () => {
    const j = await api<{ total: number }>("GET", "/api/admin/audit?limit=1");
    return j.total;
  });
  /** Forward scrolling rides the keyset cursor of the previous block's last
   *  row (server O(page)); jumps and context changes (sort/filters) fall
   *  back to OFFSET, which stays correct either way. */
  const auditDatasource = serverDatasource<AuditEntry>((() => {
    const cursors = new Map<string, Map<number, { ts: number; id: number }>>();
    return async (params) => {
      const ctx = JSON.stringify([params.sortModel, params.filterModel]);
      let ctxCursors = cursors.get(ctx);
      if (!ctxCursors) {
        ctxCursors = new Map();
        cursors.set(ctx, ctxCursors);
      }
      const qs = new URLSearchParams({
        limit: String(Math.min(params.endRow - params.startRow, 500)),
        offset: String(params.startRow),
      });
      if (params.sortModel.length > 0) qs.set("sort", JSON.stringify(params.sortModel));
      if (Object.keys(params.filterModel).length > 0) qs.set("filters", JSON.stringify(params.filterModel));
      const cursor = params.startRow > 0 ? ctxCursors.get(params.startRow - 1) : undefined;
      // Keep `offset` in the query: the server only honors the cursor for the
      // DEFAULT (ts DESC) ordering — with a column sort or a malformed cursor
      // it falls back to OFFSET, which must still be the right one.
      if (cursor) qs.set("cursor", `${cursor.ts}:${cursor.id}`);
      const j = await api<{ entries: AuditEntry[]; total: number }>("GET", `/api/admin/audit?${qs}`);
      const last = j.entries[j.entries.length - 1];
      if (last) {
        ctxCursors.set(params.startRow + j.entries.length - 1, { ts: last.ts, id: last.id });
      }
      return { rows: j.entries, total: j.total };
    };
  })());

  const cols: ColDef[] = [
    {
      field: "ts",
      headerName: "Time",
      width: 170,
      filter: DateTimeFilter,
      floatingFilterComponent: DateTimeFloatingFilter,
      valueFormatter: timeFormatter,
    },
    { field: "action", headerName: "Action", width: 220, cellRenderer: ActionCell },
    {
      field: "actor_email",
      headerName: "Actor",
      flex: 1,
      minWidth: 160,
      valueGetter: (p) => p.data?.actor_email ?? p.data?.target ?? "—",
    },
    {
      field: "target",
      headerName: "Target",
      width: 200,
      cellRenderer: (p: { value?: string }) => (
        <span class="font-mono text-[11px] text-ink-400">{p.value?.slice(0, 24) ?? "—"}</span>
      ),
    },
    {
      field: "ip",
      headerName: "IP",
      width: 120,
      valueFormatter: (p) => p.value ?? "—",
    },
    {
      field: "meta",
      headerName: "Detail",
      flex: 1,
      minWidth: 200,
      cellRenderer: (p: { value?: string }) => (
        <span class="text-ink-500 truncate block" title={p.value ?? ""}>
          {p.value ?? "—"}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageTitle
        title="Audit log"
        subtitle="Admin actions and security events"
      />

      <Card>
        <CardHeader title={`${fmtNum(auditCount() ?? 0)} events`} />
        <Show
          when={(auditCount() ?? 0) > 0}
          fallback={<EmptyState icon={Icons.book} title="No audit entries" />}
        >
          <div class="p-2">
            <UsageGrid
              columnDefs={cols}
              datasource={auditDatasource}
              cacheBlockSize={100}
              heightClass="h-[560px]"
              storageKey="llmgw-grid:admin.audit"
            />
          </div>
        </Show>
      </Card>
    </div>
  );
}
