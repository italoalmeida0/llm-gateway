import { createResource, createSignal, For, Show } from "solid-js";

import { api, type ApiKeyDto } from "../api";
import { PageTitle } from "../index";
import { usalItems } from "../motion";
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
  ProgressBar,
  Select,
  copyWithToast,
  fmtDate,
  fmtNum,
  timeUntil,
  toast,
} from "../ui";

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
  const [keys, { refetch }] = createResource(async () => {
    const j = await api<{ keys: ApiKeyDto[] }>("GET", "/api/keys");
    return j.keys;
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
      refetch();
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
      refetch();
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
      refetch();
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
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed to delete", "err");
    } finally {
      setBusy(false);
    }
  };

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
          when={(keys() ?? []).length > 0}
          fallback={
            <EmptyState
              icon={Icons.key}
              title="No keys yet"
              hint="Create one to start calling the gateway."
            />
          }
        >
          <ul class="divide-y divide-line">
            <For each={keys()}>
              {(k) => {
                const st = STATUS_TONE[k.status] ?? STATUS_TONE.zinc!;
                return (
                  <li class="px-6 py-4.5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between transition-colors hover:bg-ink-800/25 first:rounded-t-[1.75rem] last:rounded-b-[1.75rem]">
                    <div class="min-w-0">
                      <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-sm font-medium">{k.name}</span>
                        <Badge tone={st.tone}>{st.label}</Badge>
                        <code class="text-[11px] text-ink-500">
                          {k.prefix}…
                        </code>
                      </div>
                      <div class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-400">
                        <span>
                          Output today {fmtNum(k.outputToday)}
                          {k.dailyLimit ? ` / ${fmtNum(k.dailyLimit)}` : ""}
                        </span>
                        <span>
                          Output total {fmtNum(k.outputTotal)}
                          {k.totalLimit ? ` / ${fmtNum(k.totalLimit)}` : ""}
                        </span>
                        <span>
                          Expires:{" "}
                          {k.expiresAt
                            ? `${fmtDate(k.expiresAt)} (${timeUntil(k.expiresAt)})`
                            : "Never"}
                        </span>
                        <span>{k.rpm ? `${k.rpm} rpm` : "Default rpm"}</span>
                        <span>
                          Last used:{" "}
                          {k.lastUsedAt ? fmtDate(k.lastUsedAt) : "Never"}
                        </span>
                      </div>
                      <Show when={k.dailyLimit || k.totalLimit}>
                        <div class="mt-2 max-w-xs">
                          <ProgressBar
                            danger
                            value={k.dailyLimit ? k.outputToday : k.outputTotal}
                            max={(k.dailyLimit ?? k.totalLimit) || 1}
                          />
                        </div>
                      </Show>
                    </div>
                    <div class="flex items-center gap-1 shrink-0">
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
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
      </Card>

      {/* create modal */}
      <Modal
        open={showCreate()}
        onClose={() => setShowCreate(false)}
        title="Create API key"
      >
        <div class="space-y-4">
          <Input
            label="Name"
            value={form().name}
            onInput={(v) => setForm({ ...form(), name: v })}
            placeholder="e.g. alice-short-experiment"
          />
          <Select
            label="Expiration"
            value={form().preset}
            onChange={(v) => setForm({ ...form(), preset: v })}
            options={EXPIRY_PRESETS}
            hint="When it expires, the key simply stops working."
          />
          <Show when={form().preset === "custom"}>
            <Input
              label="Expires at"
              type="datetime-local"
              value={form().customDate}
              onInput={(v) => setForm({ ...form(), customDate: v })}
            />
          </Show>
          <div class="grid grid-cols-2 gap-3">
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
            label="Requests per minute"
            type="number"
            min={1}
            max={3600}
            value={form().rpm}
            onInput={(v) => setForm({ ...form(), rpm: v })}
            placeholder="default (120)"
          />
          <div class="flex justify-end gap-2 pt-2">
            <Btn variant="ghost" onClick={() => setShowCreate(false)}>
              Cancel
            </Btn>
            <Btn onClick={create} disabled={busy()}>
              {busy() ? "Creating…" : "Create key"}
            </Btn>
          </div>
        </div>
      </Modal>

      {/* edit modal */}
      <Modal
        open={!!editing()}
        onClose={() => setEditing(null)}
        title={`Edit “${editing()?.name ?? ""}”`}
      >
        <div class="space-y-4">
          <Input
            label="Name"
            value={form().name}
            onInput={(v) => setForm({ ...form(), name: v })}
          />
          <div class="grid grid-cols-2 gap-3">
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
              hint="Output tokens · raising it reactivates an exhausted key"
            />
          </div>
          <Input
            label="Requests per minute"
            type="number"
            min={1}
            max={3600}
            value={form().rpm}
            onInput={(v) => setForm({ ...form(), rpm: v })}
            placeholder="default (120)"
          />
          <div class="flex justify-end gap-2 pt-2">
            <Btn variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Btn>
            <Btn onClick={saveEdit} disabled={busy()}>
              {busy() ? "Saving…" : "Save"}
            </Btn>
          </div>
        </div>
      </Modal>

      {/* token-once modal */}
      <Modal
        open={!!newToken()}
        onClose={() => setNewToken("")}
        title="Key created — copy it now"
      >
        <div class="space-y-4">
          <p class="text-sm text-ink-300">
            This is the <strong class="text-ink-100">only time</strong> the full
            token is shown. Store it like a password — we only keep its hash.
          </p>
          <div class="flex items-center gap-2">
            <code class="flex-1 rounded-xl bg-ink-900 border border-line px-3.5 py-2.5 text-xs text-emerald-500 break-all select-all">
              {newToken()}
            </code>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => copyWithToast(newToken())}
            >
              <Icon name={Icons.copy} /> Copy
            </Btn>
          </div>
          <div class="flex justify-end">
            <Btn onClick={() => setNewToken("")}>Done</Btn>
          </div>
        </div>
      </Modal>

      {/* revoke confirm */}
      <Modal
        open={!!confirmRevoke()}
        onClose={() => setConfirmRevoke(null)}
        title="Revoke key"
      >
        <div class="space-y-4">
          <p class="text-sm text-ink-300">
            Revoke <strong class="text-ink-100">{confirmRevoke()?.name}</strong>{" "}
            ({confirmRevoke()?.prefix}…)? Any client using it stops working
            immediately. This cannot be undone.
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

      {/* hard-delete confirm */}
      <Modal
        open={!!confirmDelete()}
        onClose={() => setConfirmDelete(null)}
        title="Delete key permanently"
      >
        <div class="space-y-4">
          <p class="text-sm text-ink-300">
            Permanently delete{" "}
            <strong class="text-ink-100">{confirmDelete()?.name}</strong> (
            {confirmDelete()?.prefix}…)? The key row is removed for good —
            unlike revoke, it disappears from this list. Usage history is kept
            for accounting. This cannot be undone.
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
