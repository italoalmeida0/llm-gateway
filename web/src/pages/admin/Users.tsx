import { createResource, createSignal, For, Show } from "solid-js";

import { api, currentSession, type AdminUserDto } from "../../api";
import { PageTitle } from "../../index";
import { usalItems } from "../../motion";
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
  Select,
  copyWithToast,
  fmtDate,
  toast,
} from "../../ui";

export default function AdminUsersPage() {
  const [users, { refetch }] = createResource(async () => {
    const j = await api<{ users: AdminUserDto[] }>("GET", "/api/admin/users");
    return j.users;
  });

  const [showCreate, setShowCreate] = createSignal(false);
  const [editing, setEditing] = createSignal<AdminUserDto | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal<AdminUserDto | null>(
    null,
  );
  const [inviteLink, setInviteLink] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const [email, setEmail] = createSignal("");
  const [name, setName] = createSignal("");
  const [role, setRole] = createSignal("user");
  const [sendInvite, setSendInvite] = createSignal(true);

  const meId = () => currentSession()?.user.id;

  // Server returns an absolute link when PUBLIC_URL is configured, otherwise
  // a root-relative one — prefix our own origin only in the relative case.
  const fullLink = (l: string) =>
    l.startsWith("http")
      ? l
      : `${location.origin}${l.startsWith("/") ? l : `/${l}`}`;

  const create = async () => {
    setBusy(true);
    try {
      const j = await api<any>("POST", "/api/admin/users", {
        email: email().trim(),
        name: name().trim(),
        role: role(),
        sendInvite: sendInvite(),
      });
      setShowCreate(false);
      setEmail("");
      setName("");
      setRole("user");
      if (j.invite?.sent) {
        toast("User created — invite email sent");
      } else if (j.invite?.link) {
        setInviteLink(fullLink(j.invite.link));
      }
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    const u = editing();
    if (!u) return;
    setBusy(true);
    try {
      await api("PATCH", `/api/admin/users/${u.id}`, {
        name: u.name,
        role: u.role,
        status: u.status,
      });
      toast("User updated");
      setEditing(null);
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const quick = async (
    u: AdminUserDto,
    action: string,
    confirmMsg?: string,
  ) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    try {
      await api("POST", `/api/admin/users/${u.id}/${action}`);
      toast("Done");
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    }
  };

  const sendReset = async (u: AdminUserDto) => {
    try {
      const j = await api<{ sent: boolean; link: string | null }>(
        "POST",
        `/api/admin/users/${u.id}/send-reset`,
      );
      if (j.sent) toast("Reset email sent");
      else if (j.link) setInviteLink(fullLink(j.link));
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    }
  };

  const remove = async () => {
    const u = confirmDelete();
    if (!u) return;
    setBusy(true);
    try {
      await api("DELETE", `/api/admin/users/${u.id}`);
      toast("User deleted");
      setConfirmDelete(null);
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageTitle
        title="Users"
        subtitle="Only you can create accounts — people sign in with the invite you send"
        right={
          <Btn onClick={() => setShowCreate(true)}>
            <Icon name={Icons.plus} /> New user
          </Btn>
        }
      />

      <Card>
        <Show
          when={(users() ?? []).length > 0}
          fallback={<EmptyState icon={Icons.users} title="No users" />}
        >
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="text-left text-[10px] uppercase tracking-wider text-ink-500 border-b border-line">
                  <th class="font-medium px-6 py-3">User</th>
                  <th class="font-medium px-3 py-3">Role</th>
                  <th class="font-medium px-3 py-3">Security</th>
                  <th class="font-medium px-3 py-3">Keys</th>
                  <th class="font-medium px-3 py-3">Last login</th>
                  <th class="font-medium px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-line">
                <For each={users()}>
                  {(u) => (
                    <tr class="transition-colors hover:bg-ink-800/30">
                      <td class="px-6 py-3">
                        <div class="text-sm text-ink-100">
                          {u.name || u.email}
                        </div>
                        <div class="text-ink-500">{u.email}</div>
                      </td>
                      <td class="px-3 py-3">
                        <Badge tone={u.role === "admin" ? "indigo" : "zinc"}>
                          {u.role === "admin" ? "Admin" : "User"}
                        </Badge>{" "}
                        <Show when={u.status === "banned"}>
                          <Badge tone="red">Banned</Badge>
                        </Show>
                      </td>
                      <td class="px-3 py-3 text-ink-400 whitespace-nowrap">
                        <span title="password">
                          {u.hasPassword ? "*" : "·"}
                        </span>{" "}
                        <span title="2FA">{u.totpEnabled ? "2" : "·"}</span>{" "}
                        <span title="google">{u.googleLinked ? "G" : "·"}</span>
                      </td>
                      <td class="px-3 py-3 tabular-nums text-ink-300">
                        {u.keyCount}
                      </td>
                      <td class="px-3 py-3 text-ink-400 whitespace-nowrap">
                        {u.lastLoginAt ? fmtDate(u.lastLoginAt) : "Never"}
                      </td>
                      <td class="px-3 py-3">
                        <div class="flex items-center justify-end gap-1">
                          <IconBtn
                            icon={Icons.edit}
                            title="Edit"
                            onClick={() => setEditing({ ...u })}
                          />
                          <IconBtn
                            icon={Icons.key}
                            title="Send password reset link"
                            onClick={() => sendReset(u)}
                          />
                          <IconBtn
                            icon={Icons.logout}
                            title="Revoke all sessions"
                            onClick={() => quick(u, "revoke-sessions")}
                          />
                          <Show when={u.totpEnabled}>
                            <IconBtn
                              icon={Icons.shield}
                              title="Reset 2FA"
                              onClick={() =>
                                quick(u, "reset-2fa", "Reset this user's 2FA?")
                              }
                            />
                          </Show>
                          <Show when={u.id !== meId()}>
                            <IconBtn
                              icon={Icons.trash}
                              title="Delete user"
                              danger
                              onClick={() => setConfirmDelete(u)}
                            />
                          </Show>
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </Card>

      {/* create modal */}
      <Modal
        open={showCreate()}
        onClose={() => setShowCreate(false)}
        title="Create user"
      >
        <div class="space-y-4">
          <Input
            label="Email"
            type="email"
            value={email()}
            onInput={setEmail}
            placeholder="friend@example.com"
          />
          <Input
            label="Name"
            value={name()}
            onInput={setName}
            placeholder="Alice"
          />
          <Select
            label="Role"
            value={role()}
            onChange={setRole}
            options={[
              { value: "user", label: "User" },
              { value: "admin", label: "Admin" },
            ]}
          />
          <label class="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={sendInvite()}
              onChange={(e) => setSendInvite(e.currentTarget.checked)}
              class="w-4 h-4 rounded border-line bg-elev accent-brand-500"
            />
            <span class="text-sm">
              Send invite email with password-setup link
            </span>
          </label>
          <div class="flex justify-end gap-2 pt-2">
            <Btn variant="ghost" onClick={() => setShowCreate(false)}>
              Cancel
            </Btn>
            <Btn
              onClick={create}
              disabled={busy() || !email().trim() || !name().trim()}
            >
              {busy() ? "Creating…" : "Create user"}
            </Btn>
          </div>
        </div>
      </Modal>

      {/* edit modal */}
      <Modal
        open={!!editing()}
        onClose={() => setEditing(null)}
        title={`Edit ${editing()?.email ?? ""}`}
      >
        <Show when={editing()}>
          {(u) => (
            <div class="space-y-4">
              <Input
                label="Name"
                value={u().name}
                onInput={(v) => setEditing({ ...u(), name: v })}
              />
              <Select
                label="Role"
                value={u().role}
                onChange={(v) =>
                  setEditing({ ...u(), role: v as "admin" | "user" })
                }
                options={[
                  { value: "user", label: "User" },
                  { value: "admin", label: "Admin" },
                ]}
              />
              <Select
                label="Status"
                value={u().status}
                onChange={(v) =>
                  setEditing({ ...u(), status: v as "active" | "banned" })
                }
                options={[
                  { value: "active", label: "Active" },
                  { value: "banned", label: "Banned (all keys blocked)" },
                ]}
                hint="Banning immediately revokes sessions and blocks every key."
              />
              <div class="flex justify-end gap-2 pt-2">
                <Btn variant="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </Btn>
                <Btn onClick={saveEdit} disabled={busy() || !u().name.trim()}>
                  Save
                </Btn>
              </div>
            </div>
          )}
        </Show>
      </Modal>

      {/* invite/reset link modal (SMTP absent) */}
      <Modal
        open={!!inviteLink()}
        onClose={() => setInviteLink("")}
        title="Action link"
      >
        <div class="space-y-4">
          <p class="text-sm text-ink-300">
            SMTP is not configured, so no email went out. Send this link to the
            user manually:
          </p>
          <div class="flex items-center gap-2">
            <code class="flex-1 rounded-lg bg-ink-850 border border-line px-3 py-2 text-[11px] text-emerald-500 break-all select-all">
              {inviteLink()}
            </code>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => copyWithToast(inviteLink())}
            >
              <Icon name={Icons.copy} />
            </Btn>
          </div>
          <div class="flex justify-end">
            <Btn onClick={() => setInviteLink("")}>Done</Btn>
          </div>
        </div>
      </Modal>

      {/* delete confirm */}
      <Modal
        open={!!confirmDelete()}
        onClose={() => setConfirmDelete(null)}
        title="Delete user"
      >
        <div class="space-y-4">
          <p class="text-sm text-ink-300">
            Delete{" "}
            <strong class="text-ink-100">{confirmDelete()?.email}</strong>?
            Their sessions, API keys and 2FA are removed. Usage history is kept
            for accounting.
          </p>
          <div class="flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Btn>
            <Btn variant="danger" onClick={remove} disabled={busy()}>
              Delete
            </Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}
