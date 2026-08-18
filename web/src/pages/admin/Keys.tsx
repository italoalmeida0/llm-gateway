import { createResource, createSignal, Show } from "solid-js";

import { api, type ApiKeyDto } from "../../api";
import { PageTitle } from "../../index";
import { usalItems } from "../../motion";
import {
  Badge,
  Btn,
  Card,
  copyWithToast,
  EmptyState,
  IconBtn,
  Icons,
  Modal,
  toast,
  fmtDate,
  fmtNum,
  timeUntil,
} from "../../ui";
import { UsageGrid, serverDatasource } from "../../aggrid";
import type { ColDef } from "ag-grid-community";

const TONE: Record<
  string,
  { tone: "green" | "red" | "amber" | "zinc"; label: string }
> = {
  active: { tone: "green", label: "Active" },
  revoked: { tone: "red", label: "Revoked" },
  exhausted: { tone: "red", label: "Exhausted" },
  expired: { tone: "zinc", label: "Expired" },
  daily_limit: { tone: "amber", label: "Daily spent" },
  total_limit: { tone: "red", label: "Total spent" },
};

export default function AdminKeysPage() {
  const [keyCount, { refetch: refetchKeyCount }] = createResource(async () => {
    const j = await api<{ total: number }>("GET", "/api/admin/keys?limit=1");
    return j.total;
  });
  const [gridVersion, setGridVersion] = createSignal(0);
  const refreshGrid = () => {
    setGridVersion((v) => v + 1);
    refetchKeyCount();
  };
  const keysDatasource = serverDatasource<ApiKeyDto>(async (params) => {
    const qs = new URLSearchParams({
      limit: String(Math.min(params.endRow - params.startRow, 500)),
      offset: String(params.startRow),
    });
    if (params.sortModel.length > 0) qs.set("sort", JSON.stringify(params.sortModel));
    if (Object.keys(params.filterModel).length > 0) qs.set("filters", JSON.stringify(params.filterModel));
    const j = await api<{ keys: ApiKeyDto[]; total: number }>("GET", `/api/admin/keys?${qs}`);
    return { rows: j.keys, total: j.total };
  });
  const [confirmRevoke, setConfirmRevoke] = createSignal<ApiKeyDto | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = createSignal<ApiKeyDto | null>(
    null,
  );
  const [busy, setBusy] = createSignal(false);

  const revoke = async () => {
    const k = confirmRevoke();
    if (!k) return;
    setBusy(true);
    try {
      await api("DELETE", `/api/admin/keys/${k.id}`);
      toast("Key revoked");
      setConfirmRevoke(null);
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const hardDelete = async () => {
    const k = confirmDelete();
    if (!k) return;
    setBusy(true);
    try {
      await api("DELETE", `/api/admin/keys/${k.id}?hard=true`);
      toast("Key permanently deleted");
      setConfirmDelete(null);
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const copyKey = async (k: ApiKeyDto) => {
    try {
      const j = await api<{ token: string }>(
        "GET",
        `/api/admin/keys/${k.id}/reveal`,
      );
      await copyWithToast(j.token);
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed to copy", "err");
    }
  };

  // ---- grid cells ----

  function KeyCell(props: { data?: ApiKeyDto }) {
    return (
      <div class="flex flex-col gap-0.5 py-1">
        <span class="text-sm text-ink-100 truncate">{props.data?.name}</span>
        <code class="text-ink-500">{props.data?.prefix}…</code>
      </div>
    );
  }

  function StatusCell(props: { value?: string }) {
    const st = TONE[props.value ?? ""] ?? TONE.zinc!;
    return <Badge tone={st.tone}>{st.label}</Badge>;
  }

  function ActionsCell(props: { data?: ApiKeyDto }) {
    const k = props.data;
    if (!k) return null;
    return (
      <div class="flex items-center justify-end gap-1">
        <IconBtn
          icon={Icons.copy}
          title={k.revealable ? "Copy full token" : "Predates reveal support"}
          disabled={!k.revealable}
          onClick={() => copyKey(k)}
        />
        <IconBtn
          icon={Icons.ban}
          title="Revoke key"
          danger
          disabled={k.status === "revoked"}
          onClick={() => setConfirmRevoke(k)}
        />
        <IconBtn
          icon={Icons.trash}
          title="Delete permanently"
          danger
          onClick={() => setConfirmDelete(k)}
        />
      </div>
    );
  }

  const cols: ColDef[] = [
    { field: "name", headerName: "Key", flex: 1.2, minWidth: 190, cellRenderer: KeyCell },
    {
      field: "userEmail",
      headerName: "Owner",
      flex: 1,
      minWidth: 160,
      valueGetter: (p) => p.data?.userEmail ?? p.data?.userId,
    },
    { field: "status", headerName: "Status", width: 130, cellRenderer: StatusCell },
    {
      field: "outputToday",
      headerName: "Out today",
      width: 130,
      type: "rightAligned",
      cellRenderer: (p: { data?: ApiKeyDto }) => (
        <span class="tabular-nums">
          {fmtNum(p.data?.outputToday)}
          {p.data?.dailyLimit ? `/${fmtNum(p.data.dailyLimit)}` : ""}
        </span>
      ),
    },
    {
      field: "outputTotal",
      headerName: "Out total",
      width: 130,
      type: "rightAligned",
      cellRenderer: (p: { data?: ApiKeyDto }) => (
        <span class="tabular-nums">
          {fmtNum(p.data?.outputTotal)}
          {p.data?.totalLimit ? `/${fmtNum(p.data.totalLimit)}` : ""}
        </span>
      ),
    },
    {
      field: "expiresAt",
      headerName: "Expires",
      width: 210,
      valueFormatter: (p) =>
        p.value ? `${fmtDate(p.value)} (${timeUntil(p.value)})` : "Never",
    },
    {
      field: "lastUsedAt",
      headerName: "Last used",
      width: 160,
      valueFormatter: (p) => (p.value ? fmtDate(p.value) : "Never"),
    },
    {
      colId: "actions",
      headerName: "",
      width: 130,
      cellRenderer: ActionsCell,
      sortable: false,
      filter: false,
      floatingFilter: false,
      resizable: false,
      pinned: "right",
    },
  ];

  return (
    <div>
      <PageTitle
        title="All API keys"
        subtitle="Every user's keys — revoke any of them instantly"
      />

      <Card>
        <Show
          when={(keyCount() ?? 0) > 0}
          fallback={
            <EmptyState icon={Icons.key} title="No keys in the system" />
          }
        >
          <div class="p-2" {...usalItems("fade-u", 60)}>
            <UsageGrid
              columnDefs={cols}
              datasource={keysDatasource}
              cacheBlockSize={100}
              refreshDeps={gridVersion()}
              storageKey="llmgw-grid:admin.keys"
            />
          </div>
        </Show>
      </Card>

      <Modal
        open={!!confirmRevoke()}
        onClose={() => setConfirmRevoke(null)}
        title="Revoke key (admin)"
      >
        <div class="space-y-4">
          <p class="text-sm text-ink-300">
            Revoke <strong class="text-ink-100">{confirmRevoke()?.name}</strong>{" "}
            belonging to{" "}
            <strong class="text-ink-100">{confirmRevoke()?.userEmail}</strong>?
            Immediate effect.
          </p>
          <div class="flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setConfirmRevoke(null)}>
              Cancel
            </Btn>
            <Btn variant="danger" onClick={revoke} disabled={busy()}>
              Revoke
            </Btn>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!confirmDelete()}
        onClose={() => setConfirmDelete(null)}
        title="Delete key permanently (admin)"
      >
        <div class="space-y-4">
          <p class="text-sm text-ink-300">
            Permanently delete{" "}
            <strong class="text-ink-100">{confirmDelete()?.name}</strong>{" "}
            belonging to{" "}
            <strong class="text-ink-100">{confirmDelete()?.userEmail}</strong>?
            The row is removed for good (usage history is kept). This cannot be
            undone.
          </p>
          <div class="flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Btn>
            <Btn variant="danger" onClick={hardDelete} disabled={busy()}>
              Delete permanently
            </Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}