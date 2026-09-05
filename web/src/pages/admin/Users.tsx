import { createResource, createSignal, Show } from "solid-js";

import { api, currentSession, type AdminUserDto } from "../../api";
import { PageTitle } from "../../index";
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
import { EPOCH_DATE_FILTER_PARAMS, UsageGrid, serverDatasource } from "../../aggrid";
import type { ColDef } from "ag-grid-community";

export default function AdminUsersPage() {
  const [userCount, { refetch: refetchUserCount }] = createResource(async () => {
    const j = await api<{ total: number }>("GET", "/api/admin/users?limit=1");
    return j.total;
  });
  const [gridVersion, setGridVersion] = createSignal(0);
  const refreshGrid = () => {
    setGridVersion((v) => v + 1);
    refetchUserCount();
  };
  const usersDatasource = serverDatasource<AdminUserDto>(async (params) => {
    const qs = new URLSearchParams({
      limit: String(Math.min(params.endRow - params.startRow, 500)),
      offset: String(params.startRow),
    });
    if (params.sortModel.length > 0) qs.set("sort", JSON.stringify(params.sortModel));
    if (Object.keys(params.filterModel).length > 0) qs.set("filters", JSON.stringify(params.filterModel));
    const j = await api<{ users: AdminUserDto[]; total: number }>("GET", `/api/admin/users?${qs}`);
    return { rows: j.users, total: j.total };
  });

  const [showCreate, setShowCreate] = createSignal(false);
  const [editing, setEditing] = createSignal<AdminUserDto | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal<AdminUserDto | null>(
    null,
  );
  const [confirmReset2fa, setConfirmReset2fa] =
    createSignal<AdminUserDto | null>(null);
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
      refreshGrid();
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
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const quick = async (u: AdminUserDto, action: string) => {
    try {
      await api("POST", `/api/admin/users/${u.id}/${action}`);
      toast("Done");
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    }
  };

  const reset2fa = async () => {
    const u = confirmReset2fa();
    if (!u) return;
    setBusy(true);
    try {
      await api("POST", `/api/admin/users/${u.id}/reset-2fa`);
      toast("2FA reset");
      setConfirmReset2fa(null);
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
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
      refreshGrid();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  // ---- grid cells ----

  function UserCell(props: { data?: AdminUserDto }) {
    return (
      <div class="flex flex-col gap-0.5 py-1">
        <span class="text-sm text-ink-100 truncate">
          {props.data?.name || props.data?.email}
        </span>
        <span class="text-ink-500 truncate">{props.data?.email}</span>
      </div>
    );
  }

  function RoleCell(props: { data?: AdminUserDto }) {
    const u = props.data;
    if (!u) return null;
    return (
      <>
        <Badge tone={u.role === "admin" ? "indigo" : "zinc"}>
          {u.role === "admin" ? "Admin" : "User"}
        </Badge>
        <Show when={u.status === "banned"}>
          <Badge tone="red">Banned</Badge>
        </Show>
      </>
    );
  }

  function SecurityCell(props: { data?: AdminUserDto }) {
    const u = props.data;
    if (!u) return null;
    return (
      <span class="text-ink-400 whitespace-nowrap">
        <span title="password" class={u.hasPassword ? "" : "opacity-40"}>*</span>{" "}
        <span title="2FA" class={u.totpEnabled ? "" : "opacity-40"}>2</span>{" "}
        <span title="google" class={u.googleLinked ? "" : "opacity-40"}>G</span>
      </span>
    );
  }

  function ActionsCell(props: { data?: AdminUserDto }) {
    const u = props.data;
    if (!u) return null;
    return (
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
            onClick={() => setConfirmReset2fa(u)}
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
    );
  }

  const cols: ColDef[] = [
    { field: "email", headerName: "User", flex: 1.4, minWidth: 220, cellRenderer: UserCell },
    { field: "role", headerName: "Role", width: 150, cellRenderer: RoleCell },
    {
      colId: "security",
      headerName: "Security",
      width: 110,
      cellRenderer: SecurityCell,
      filter: false,
      floatingFilter: false,
    },
    { field: "keyCount", headerName: "Keys", width: 90, type: "rightAligned", filter: "agNumberColumnFilter" },
    {
      field: "lastLoginAt",
      headerName: "Last login",
      width: 170,
      filter: "agDateColumnFilter",
      filterParams: EPOCH_DATE_FILTER_PARAMS,
      valueFormatter: (p) => (p.value ? fmtDate(p.value) : "Never"),
    },
    {
      colId: "actions",
      headerName: "",
      width: 180,
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
          when={(userCount() ?? 0) > 0}
          fallback={<EmptyState icon={Icons.users} title="No users" />}
        >
          <div class="p-2">
            <UsageGrid
              columnDefs={cols}
              datasource={usersDatasource}
              cacheBlockSize={100}
              refreshDeps={gridVersion()}
              storageKey="llmgw-grid:admin.users.list"
            />
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

      {/* reset-2FA confirm */}
      <Modal
        open={!!confirmReset2fa()}
        onClose={() => setConfirmReset2fa(null)}
        title="Reset 2FA"
      >
        <div class="space-y-4">
          <p class="text-sm text-ink-300">
            Reset two-factor authentication for{" "}
            <strong class="text-ink-100">{confirmReset2fa()?.email}</strong>?
            They'll need to set a new TOTP secret on next login.
          </p>
          <div class="flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setConfirmReset2fa(null)}>
              Cancel
            </Btn>
            <Btn variant="danger" onClick={reset2fa} disabled={busy()}>
              Reset 2FA
            </Btn>
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
