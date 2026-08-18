import { createResource, Show } from "solid-js";

import { api } from "../../api";
import { PageTitle } from "../../index";
import { usalItems } from "../../motion";
import { Badge, Card, CardHeader, EmptyState, Icons, fmtNum } from "../../ui";
import { UsageGrid, timeFormatter } from "../../aggrid";
import type { ColDef } from "ag-grid-community";

const FETCH = 500;
const PAGE_SIZE = 50;

interface AuditEntry {
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
  const [data] = createResource(async () => {
    const j = await api<{ entries: AuditEntry[]; total: number }>(
      "GET",
      `/api/admin/audit?limit=${FETCH}`,
    );
    return j;
  });

  const cols: ColDef[] = [
    { field: "ts", headerName: "Time", width: 160, valueFormatter: timeFormatter },
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
        <CardHeader
          title={`${fmtNum(data()?.total ?? 0)} events · latest ${FETCH}`}
        />
        <Show
          when={(data()?.entries.length ?? 0) > 0}
          fallback={<EmptyState icon={Icons.book} title="No audit entries" />}
        >
          <div class="p-2" {...usalItems("fade-u", 60)}>
            <UsageGrid
              columnDefs={cols}
              rowData={data()?.entries}
              pageSize={PAGE_SIZE}
              heightClass="h-[560px]"
              storageKey="llmgw-grid:admin.audit"
            />
          </div>
        </Show>
      </Card>
    </div>
  );
}