import { createResource, createSignal, Show } from "solid-js";

import { api, type ApiKeyDto } from "../api";
import { PageTitle } from "../index";
import {
  Badge,
  Btn,
  Card,
  EmptyState,
  Icon,
  IconBtn,
  Icons,
  Input,
  Modal,
  ModalNotice,
  ModalSection,
  ProgressBar,
  Select,
  copyWithToast,
  fmtDate,
  fmtNum,
  timeUntil,
  toast,
} from "../ui";
import { EPOCH_DATE_FILTER_PARAMS, UsageGrid, serverDatasource } from "../aggrid";
import type { ColDef } from "ag-grid-community";

const STATUS_TONE: Record<
  string,
  { tone: "green" | "red" | "amber" | "zinc"; label: string }
> = {
  active: { tone: "green", label: "Active" },
  revoked: { tone: "red", label: "Revoked" },
  exhausted: { tone: "red", label: "Budget exhausted" },
  expired: { tone: "zinc", label: "Expired" },
  daily_limit: { tone: "amber", label: "Daily budget spent" },
  total_limit: { tone: "red", label: "Total budget spent" },
  zinc: { tone: "zinc", label: "Unknown" },
};

const EXPIRY_PRESETS = [
  { value: "never", label: "Permanent" },
  { value: "3600", label: "1 hour" },
  { value: "86400", label: "24 hours" },
  { value: "604800", label: "7 days" },
  { value: "2592000", label: "30 days" },
  { value: "custom", label: "Custom date…" },
];

interface KeyFormState {
  name: string;
  preset: string;
  customDate: string;
  dailyLimit: string;
  totalLimit: string;
  rpm: string;
}

function computeExpiresAt(f: KeyFormState): number | null {
  if (f.preset === "never") return null;
  if (f.preset === "custom") {
    const t = new Date(f.customDate).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return Date.now() + Number(f.preset) * 1000;
}

export default function KeysPage() {
  const [keyCount, { refetch: refetchKeyCount }] = createResource(async () => {
    const j = await api<{ total: number }>("GET", "/api/keys?limit=1");
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
    const j = await api<{ keys: ApiKeyDto[]; total: number }>("GET", `/api/keys?${qs}`);
    return { rows: j.keys, total: j.total };
  });

  const [showCreate, setShowCreate] = createSignal(false);
  const [editing, setEditing] = createSignal<ApiKeyDto | null>(null);
  const [newToken, setNewToken] = createSignal("");
  const [confirmRevoke, setConfirmRevoke] = createSignal<ApiKeyDto | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = createSignal<ApiKeyDto | null>(
    null,
  );
  const [busy, setBusy] = createSignal(false);

  const [form, setForm] = createSignal<KeyFormState>({
    name: "",
    preset: "never",
    customDate: "",
    dailyLimit: "",
    totalLimit: "",
    rpm: "",
  });

  const resetForm = () =>
    setForm({
      name: "",
      preset: "never",
      customDate: "",
      dailyLimit: "",
      totalLimit: "",
      rpm: "",
    });

  const num = (s: string) => (s.trim() === "" ? null : Number(s));

  const create = async () => {
    if (!form().name.trim()) return toast("Name is required", "err");
    setBusy(true);
    try {
      const expiresAt = computeExpiresAt(form());
      const j = await api<{ token: string }>("POST", "/api/keys", {
        name: form().name.trim(),
        expiresAt,
        dailyLimit: num(form().dailyLimit),
        totalLimit: num(form().totalLimit),
        rpm: num(form().rpm),
      });
      setNewToken(j.token);
      setShowCreate(false);
      resetForm();
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed to create key", "err");
    } finally {
      setBusy(false);
    }
  };

  const openEdit = (k: ApiKeyDto) => {
    setForm({
      name: k.name,
      preset: "never",
      customDate: "",
      dailyLimit: k.dailyLimit?.toString() ?? "",
      totalLimit: k.totalLimit?.toString() ?? "",
      rpm: k.rpm?.toString() ?? "",
    });
    setEditing(k);
  };

  const saveEdit = async () => {
    const k = editing();
    if (!k) return;
    setBusy(true);
    try {
      await api("PATCH", `/api/keys/${k.id}`, {
        name: form().name.trim(),
        dailyLimit: num(form().dailyLimit),
        totalLimit: num(form().totalLimit),
        rpm: num(form().rpm),
      });
      toast("Key updated");
      setEditing(null);
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed to update", "err");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    const k = confirmRevoke();
    if (!k) return;
    setBusy(true);
    try {
      await api("DELETE", `/api/keys/${k.id}`);
      toast("Key revoked");
      setConfirmRevoke(null);
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed to revoke", "err");
    } finally {
      setBusy(false);
    }
  };

  const copyKey = async (k: ApiKeyDto) => {
    try {
      const j = await api<{ token: string }>("GET", `/api/keys/${k.id}/reveal`);
      await copyWithToast(j.token);
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed to copy", "err");
    }
  };

  const hardDelete = async () => {
    const k = confirmDelete();
    if (!k) return;
    setBusy(true);
    try {
      await api("DELETE", `/api/keys/${k.id}?hard=true`);
      toast("Key permanently deleted");
      setConfirmDelete(null);
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed to delete", "err");
    } finally {
      setBusy(false);
    }
  };

  // ---- grid cells ----

  function KeyCell(props: { data?: ApiKeyDto }) {
    return (
      <div class="min-w-0 flex flex-col gap-0.5 py-1">
        <span class="text-sm font-medium text-ink-100 truncate">
          {props.data?.name}
        </span>
        <code class="text-[11px] text-ink-500">{props.data?.prefix}…</code>
      </div>
    );
  }

  function StatusBadgeCell(props: { value?: string }) {
    const st = STATUS_TONE[props.value ?? ""] ?? STATUS_TONE.zinc!;
    return <Badge tone={st.tone}>{st.label}</Badge>;
  }

  /** Output burn, with a mini progress bar when a budget is set. */
  function BudgetCell(props: { data?: ApiKeyDto; kind?: "today" | "total" }) {
    const k = props.data;
    if (!k) return null;
    const today = props.kind === "today";
    const used = today ? k.outputToday : k.outputTotal;
    const limit = today ? k.dailyLimit : k.totalLimit;
    return (
      <div class="flex flex-col items-end gap-1 py-1">
        <span class="tabular-nums">
          {fmtNum(used)}
          {limit ? <span class="text-ink-500"> / {fmtNum(limit)}</span> : ""}
        </span>
        {limit ? (
          <div class="w-20">
            <ProgressBar danger value={used} max={limit} />
          </div>
        ) : null}
      </div>
    );
  }

  function ActionsCell(props: { data?: ApiKeyDto }) {
    const k = props.data;
    if (!k) return null;
    return (
      <div class="flex items-center justify-end gap-1">
        <IconBtn
          icon={Icons.copy}
          title={
            k.revealable
              ? "Copy full token"
              : "Created before reveal support — rotate it to get a copyable token"
          }
          disabled={!k.revealable}
          onClick={() => copyKey(k)}
        />
        <IconBtn
          icon={Icons.edit}
          title="Edit"
          disabled={k.status === "revoked"}
          onClick={() => openEdit(k)}
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
    { field: "name", headerName: "Key", flex: 1.3, minWidth: 200, cellRenderer: KeyCell },
    { field: "status", headerName: "Status", width: 160, cellRenderer: StatusBadgeCell },
    {
      field: "outputToday",
      headerName: "Out today",
      width: 140,
      filter: "agNumberColumnFilter",
      cellRenderer: BudgetCell,
      cellRendererParams: { kind: "today" },
    },
    {
      field: "outputTotal",
      headerName: "Out total",
      width: 140,
      filter: "agNumberColumnFilter",
      cellRenderer: BudgetCell,
      cellRendererParams: { kind: "total" },
    },
    {
      field: "expiresAt",
      headerName: "Expires",
      width: 200,
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
      field: "rpm",
      headerName: "RPM",
      width: 100,
      filter: "agNumberColumnFilter",
      valueFormatter: (p) => (p.value ?? "default"),
    },
    {
      colId: "actions",
      headerName: "",
      width: 160,
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
        title="API Keys"
        subtitle="Keys authenticate your requests to the gateway endpoints"
        right={
          <Btn onClick={() => setShowCreate(true)}>
            <Icon name={Icons.plus} /> New key
          </Btn>
        }
      />

      <Card>
        <Show
          when={(keyCount() ?? 0) > 0}
          fallback={
            <EmptyState
              icon={Icons.key}
              title="No keys yet"
              hint="Create one to start calling the gateway."
            />
          }
        >
          <div class="p-2">
            <UsageGrid
              columnDefs={cols}
              datasource={keysDatasource}
              cacheBlockSize={100}
              refreshDeps={gridVersion()}
              storageKey="llmgw-grid:keys.user"
            />
          </div>
        </Show>
      </Card>

      {/* create modal */}
      <Modal
        open={showCreate()}
        onClose={() => setShowCreate(false)}
        title="Create API key"
        subtitle="Generate a new gateway token to authenticate your applications with OpenAI or Anthropic SDKs."
        width="max-w-xl"
        footerLeft={
          <div class="text-[11px] text-ink-500 flex items-center gap-1.5">
            <Icon name={Icons.shield} size={13} />
            <span>Encrypted at rest · SHA-256 lookup</span>
          </div>
        }
        footer={
          <>
            <Btn variant="ghost" onClick={() => setShowCreate(false)}>
              Cancel
            </Btn>
            <Btn onClick={create} disabled={busy()}>
              {busy() ? "Creating…" : "Create key"}
            </Btn>
          </>
        }
      >
        <div class="space-y-6">
          <ModalSection
            title="General Information"
            subtitle="Provide an identifier name and expiry schedule for this token."
          >
            <div class="space-y-3.5">
              <Input
                label="Name"
                value={form().name}
                onInput={(v) => setForm({ ...form(), name: v })}
                placeholder="e.g. alice-short-experiment"
                hint="Use a descriptive name to easily recognize where this key is deployed."
              />
              <Select
                label="Expiration"
                value={form().preset}
                onChange={(v) => setForm({ ...form(), preset: v })}
                options={EXPIRY_PRESETS}
                hint="When it expires, the key simply stops authenticating requests."
              />
              <Show when={form().preset === "custom"}>
                <Input
                  label="Expires at"
                  type="datetime-local"
                  value={form().customDate}
                  onInput={(v) => setForm({ ...form(), customDate: v })}
                />
              </Show>
            </div>
          </ModalSection>

          <ModalSection
            title="Budget & Rate Caps"
            subtitle="Key budgets limit output tokens only. Input and cached tokens are tracked for visibility."
          >
            <div class="rounded-2xl border border-line/70 bg-elev/30 p-4 space-y-4">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <Input
                  label="Daily output limit"
                  type="number"
                  min={1}
                  value={form().dailyLimit}
                  onInput={(v) => setForm({ ...form(), dailyLimit: v })}
                  placeholder="unlimited"
                  hint="Output tokens · resets 00:00 UTC"
                />
                <Input
                  label="Total output limit"
                  type="number"
                  min={1}
                  value={form().totalLimit}
                  onInput={(v) => setForm({ ...form(), totalLimit: v })}
                  placeholder="unlimited"
                  hint="Output tokens · permanent cap"
                />
              </div>
              <Input
                label="Requests per minute (RPM)"
                type="number"
                min={1}
                max={1000000}
                value={form().rpm}
                onInput={(v) => setForm({ ...form(), rpm: v })}
                placeholder="default (120)"
                hint="Sliding window per-key request concurrency guard."
              />
            </div>
          </ModalSection>
        </div>
      </Modal>

      {/* edit modal */}
      <Modal
        open={!!editing()}
        onClose={() => setEditing(null)}
        title={`Edit “${editing()?.name ?? ""}”`}
        subtitle="Adjust token budgets or rate limits. Raising the total limit reactivates exhausted keys immediately."
        width="max-w-xl"
        footerLeft={
          <div class="text-[11px] text-ink-500 font-mono">
            Prefix: {editing()?.prefix}…
          </div>
        }
        footer={
          <>
            <Btn variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Btn>
            <Btn onClick={saveEdit} disabled={busy()}>
              {busy() ? "Saving…" : "Save changes"}
            </Btn>
          </>
        }
      >
        <div class="space-y-6">
          <ModalSection
            title="Key Details"
            subtitle="Update the human-readable label for this key."
          >
            <Input
              label="Name"
              value={form().name}
              onInput={(v) => setForm({ ...form(), name: v })}
            />
          </ModalSection>

          <ModalSection
            title="Output Limits & Concurrency"
            subtitle="Budgets only cap output tokens; prompt and cache tokens are tracked separately."
          >
            <div class="rounded-2xl border border-line/70 bg-elev/30 p-4 space-y-4">
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <Input
                  label="Daily output limit"
                  type="number"
                  min={1}
                  value={form().dailyLimit}
                  onInput={(v) => setForm({ ...form(), dailyLimit: v })}
                  placeholder="unlimited"
                  hint="Output tokens · empty = unlimited"
                />
                <Input
                  label="Total output limit"
                  type="number"
                  min={1}
                  value={form().totalLimit}
                  onInput={(v) => setForm({ ...form(), totalLimit: v })}
                  placeholder="unlimited"
                  hint="Raising it reactivates an exhausted key"
                />
              </div>
              <Input
                label="Requests per minute"
                type="number"
                min={1}
                max={1000000}
                value={form().rpm}
                onInput={(v) => setForm({ ...form(), rpm: v })}
                placeholder="default (120)"
              />
            </div>
          </ModalSection>
        </div>
      </Modal>

      {/* token-once modal */}
      <Modal
        open={!!newToken()}
        onClose={() => setNewToken("")}
        title="API key generated successfully"
        subtitle="Copy your key and store it securely. For safety, this raw token is never shown again once you close this dialog."
        width="max-w-lg"
        footerLeft={<Badge tone="green">Ready for requests</Badge>}
        footer={
          <>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => copyWithToast(newToken())}
            >
              <Icon name={Icons.copy} /> Copy key
            </Btn>
            <Btn onClick={() => setNewToken("")}>Done</Btn>
          </>
        }
      >
        <div class="space-y-4">
          <div class="rounded-2xl border border-emerald-500/30 bg-ink-950/60 p-4 space-y-2">
            <div class="flex items-center justify-between text-xs text-ink-400">
              <span class="font-medium text-emerald-400">New Gateway Token</span>
              <button
                onClick={() => copyWithToast(newToken())}
                class="hover:text-ink-100 flex items-center gap-1 cursor-pointer"
              >
                <Icon name={Icons.copy} size={12} />
                <span>Copy</span>
              </button>
            </div>
            <code class="block font-mono text-xs text-emerald-400 break-all select-all pt-1">
              {newToken()}
            </code>
          </div>

          <ModalNotice tone="info" title="Security advisory">
            The gateway stores only the cryptographic SHA-256 hash of this key.
            If you misplace this secret, you will need to revoke it and generate a new key.
          </ModalNotice>
        </div>
      </Modal>

      {/* revoke confirm */}
      <Modal
        open={!!confirmRevoke()}
        onClose={() => setConfirmRevoke(null)}
        title="Revoke API key"
        subtitle="Immediately deactivate this key across all client applications and active agents."
        footerLeft={<Badge tone="red">Irreversible</Badge>}
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConfirmRevoke(null)}>
              Cancel
            </Btn>
            <Btn variant="danger" onClick={revoke} disabled={busy()}>
              Revoke key
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <ModalNotice tone="danger" title="Confirm key deactivation">
            Revoking will immediately cause all SDK and API requests using{" "}
            <strong>{confirmRevoke()?.name}</strong> (
            <code>{confirmRevoke()?.prefix}…</code>) to fail with 401 Unauthorized.
          </ModalNotice>
          <p class="text-xs text-ink-400 leading-relaxed">
            Historical usage metrics and audit logs associated with this key will remain intact for reporting.
          </p>
        </div>
      </Modal>

      {/* hard-delete confirm */}
      <Modal
        open={!!confirmDelete()}
        onClose={() => setConfirmDelete(null)}
        title="Delete key permanently"
        subtitle="Permanently remove this key record from the gateway database."
        footerLeft={<Badge tone="red">Permanent deletion</Badge>}
        footer={
          <>
            <Btn variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Btn>
            <Btn variant="danger" onClick={hardDelete} disabled={busy()}>
              Delete permanently
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <ModalNotice tone="danger" title="Purge database record">
            Permanently delete{" "}
            <strong>{confirmDelete()?.name}</strong> (
            <code>{confirmDelete()?.prefix}…</code>)? Unlike revoking, this key
            row will be completely purged from the registry.
          </ModalNotice>
          <p class="text-xs text-ink-400 leading-relaxed">
            All usage and audit logs are safely preserved. This action cannot be undone.
          </p>
        </div>
      </Modal>
    </div>
  );
}
