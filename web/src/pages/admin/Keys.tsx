import { createResource, createSignal, Show } from "solid-js";

import { api, type ApiKeyDto } from "../../api";
import { PageTitle } from "../../index";
import {
  Badge,
  Card,
  copyWithToast,
  EmptyState,
  IconBtn,
  Icons,
  Modal,
  ModalNotice,
  toast,
  fmtDate,
  fmtNum,
  timeUntil,
} from "../../ui";
import { EPOCH_DATE_FILTER_PARAMS, UsageGrid, serverDatasource } from "../../aggrid";
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
  zinc: { tone: "zinc", label: "Unknown" },
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
      filter: "agNumberColumnFilter",
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
      filter: "agNumberColumnFilter",
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
      filter: "agDateColumnFilter",
      filterParams: EPOCH_DATE_FILTER_PARAMS,
      valueFormatter: (p) =>
        p.value ? `${fmtDate(p.value)} (${timeUntil(p.value)})` : "Never",
    },
    {
      field: "lastUsedAt",
      headerName: "Last used",
      width: 160,
      filter: "agDateColumnFilter",
      filterParams: EPOCH_DATE_FILTER_PARAMS,
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
          <div class="p-2">
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
        title="Revoke user API key"
        subtitle="Administratively revoke this key across all gateway proxies."
        width="max-w-lg"
        footerLeft={
          <div class="text-xs text-rose-400 font-medium flex items-center gap-1.5">
            <span class="inline-block w-2 h-2 rounded-full bg-rose-500" />
            <span>Immediate deactivation</span>
          </div>
        }
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmRevoke(null)}
              class="border border-line bg-transparent hover:bg-elev text-ink-300 hover:text-ink-100 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={revoke}
              disabled={busy()}
              class="bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white px-4 py-1.5 rounded-lg text-xs font-medium shadow-sm transition-colors cursor-pointer"
            >
              {busy() ? "Revoking…" : "Revoke key"}
            </button>
          </>
        }
      >
        <div class="space-y-4">
          <ModalNotice tone="danger" title="Administrative key deactivation">
            Revoke <strong class="text-white">{confirmRevoke()?.name}</strong> belonging to{" "}
            <strong class="text-white">{confirmRevoke()?.userEmail}</strong>?
          </ModalNotice>
          <div class="rounded-xl border border-line bg-ink-950/40 p-3.5 space-y-2 text-xs text-ink-300">
            <div class="font-medium text-ink-100">Action consequences:</div>
            <ul class="list-disc list-inside space-y-1 text-ink-400 pl-1">
              <li>All client requests using this key will immediately return 401 Unauthorized.</li>
              <li>Active connections will not be renewed.</li>
              <li>Historical usage logs and aggregates will be preserved.</li>
            </ul>
          </div>
        </div>
      </Modal>

      <Modal
        open={!!confirmDelete()}
        onClose={() => setConfirmDelete(null)}
        title="Delete key permanently"
        subtitle="Permanently remove this key row from the gateway database."
        width="max-w-lg"
        footerLeft={
          <div class="text-xs text-rose-400 font-medium flex items-center gap-1.5">
            <span class="inline-block w-2 h-2 rounded-full bg-rose-500" />
            <span>Database purge</span>
          </div>
        }
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmDelete(null)}
              class="border border-line bg-transparent hover:bg-elev text-ink-300 hover:text-ink-100 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={hardDelete}
              disabled={busy()}
              class="bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white px-4 py-1.5 rounded-lg text-xs font-medium shadow-sm transition-colors cursor-pointer"
            >
              {busy() ? "Deleting…" : "Delete permanently"}
            </button>
          </>
        }
      >
        <div class="space-y-4">
          <ModalNotice tone="danger" title="Permanent database purge">
            Permanently delete{" "}
            <strong class="text-white">{confirmDelete()?.name}</strong> belonging to{" "}
            <strong class="text-white">{confirmDelete()?.userEmail}</strong>?
          </ModalNotice>
          <div class="rounded-xl border border-line bg-ink-950/40 p-3.5 space-y-2 text-xs text-ink-300">
            <div class="font-medium text-ink-100">Database purge consequences:</div>
            <ul class="list-disc list-inside space-y-1 text-ink-400 pl-1">
              <li>The API key record is completely erased from SQLite.</li>
              <li>Historical usage event logs and spend aggregates are safely preserved.</li>
              <li>This action cannot be reverted.</li>
            </ul>
          </div>
        </div>
      </Modal>
    </div>
  );
}
