import { createResource, createSignal, For, Show } from "solid-js";

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
  const [keys, { refetch }] = createResource(async () => {
    const j = await api<{ keys: ApiKeyDto[] }>("GET", "/api/admin/keys");
    return j.keys;
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
      refetch();
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
      refetch();
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

  return (
    <div>
      <PageTitle
        title="All API keys"
        subtitle="Every user's keys — revoke any of them instantly"
      />

      <Card>
        <Show
          when={(keys() ?? []).length > 0}
          fallback={
            <EmptyState icon={Icons.key} title="No keys in the system" />
          }
        >
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="text-left text-[10px] uppercase tracking-wider text-ink-500 border-b border-line">
                  <th class="font-medium px-6 py-3">Key</th>
                  <th class="font-medium px-3 py-3">Owner</th>
                  <th class="font-medium px-3 py-3">Status</th>
                  <th class="font-medium px-3 py-3 text-right">Today</th>
                  <th class="font-medium px-3 py-3 text-right">Total</th>
                  <th class="font-medium px-3 py-3">Expires</th>
                  <th class="font-medium px-3 py-3">Last used</th>
                  <th class="font-medium px-3 py-3 text-right"></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-line">
                <For each={keys()}>
                  {(k) => {
                    const st = TONE[k.status] ?? TONE.zinc!;
                    return (
                      <tr class="transition-colors hover:bg-ink-800/30">
                        <td class="px-6 py-3">
                          <div class="text-sm text-ink-100">{k.name}</div>
                          <code class="text-ink-500">{k.prefix}…</code>
                        </td>
                        <td class="px-3 py-3 text-ink-300">
                          {k.userEmail ?? k.userId}
                        </td>
                        <td class="px-3 py-3">
                          <Badge tone={st.tone}>{st.label}</Badge>
                        </td>
                        <td class="px-3 py-3 text-right tabular-nums text-ink-300">
                          {fmtNum(k.usageToday)}
                          {k.dailyLimit ? `/${fmtNum(k.dailyLimit)}` : ""}
                        </td>
                        <td class="px-3 py-3 text-right tabular-nums text-ink-300">
                          {fmtNum(k.usageTotal)}
                          {k.totalLimit ? `/${fmtNum(k.totalLimit)}` : ""}
                        </td>
                        <td class="px-3 py-3 text-ink-400 whitespace-nowrap">
                          {k.expiresAt
                            ? `${fmtDate(k.expiresAt)} (${timeUntil(k.expiresAt)})`
                            : "Never"}
                        </td>
                        <td class="px-3 py-3 text-ink-400 whitespace-nowrap">
                          {k.lastUsedAt ? fmtDate(k.lastUsedAt) : "Never"}
                        </td>
                        <td class="px-3 py-3 text-right whitespace-nowrap">
                          <div class="flex items-center justify-end gap-1">
                            <IconBtn
                              icon={Icons.copy}
                              title={
                                k.revealable
                                  ? "Copy full token"
                                  : "Predates reveal support"
                              }
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
