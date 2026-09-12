import { createResource, createSignal, Show } from "solid-js";

import { api, currentSession, type AdminUserDto } from "../../api";
import { PageTitle } from "../../index";
import {
  Badge,
  Btn,
  Card,
  EmptyState,
  FilterChip,
  Icon,
  IconBtn,
  Icons,
  Modal,
  ModalField,
  ModalNotice,
  ModalSection,
  SwitchCard,
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
        subtitle="Provision a new user account with dedicated API keys and rate limits."
        width="max-w-lg"
        footerLeft={<span class="text-xs text-ink-400">Instant activation</span>}
        footer={
          <>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => setShowCreate(false)}
            >
              Cancel
            </Btn>
            <Btn
              size="sm"
              onClick={create}
              disabled={busy() || !email().trim() || !name().trim()}
            >
              {busy() ? "Creating…" : "Create user"}
            </Btn>
          </>
        }
      >
        <div class="space-y-6">
          <ModalSection
            title="User Credentials"
            subtitle="Account login email and display identity."
          >
            <div class="space-y-3.5">
              <ModalField label="Email address">
                <input
                  type="email"
                  value={email()}
                  onInput={(e) => setEmail(e.currentTarget.value)}
                  placeholder="name@example.com"
                  class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                />
              </ModalField>

              <ModalField label="Full name">
                <input
                  type="text"
                  value={name()}
                  onInput={(e) => setName(e.currentTarget.value)}
                  placeholder="e.g. Alice Smith"
                  class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                />
              </ModalField>

              <ModalField label="Gateway role" hint="Determines access to the admin dashboard and registry controls.">
                <div class="flex flex-wrap gap-2 pt-1">
                  <FilterChip
                    selected={role() === "user"}
                    onClick={() => setRole("user")}
                  >
                    User (Keys & budgets)
                  </FilterChip>
                  <FilterChip
                    selected={role() === "admin"}
                    onClick={() => setRole("admin")}
                  >
                    Admin (Full access)
                  </FilterChip>
                </div>
              </ModalField>
            </div>
          </ModalSection>

          <ModalSection
            title="Onboarding & Delivery"
            subtitle="Invitation link and initial credentials."
          >
            <SwitchCard
              checked={sendInvite()}
              onChange={setSendInvite}
              title="Send invitation email"
              description="Sends an invite with password-setup link. If SMTP is not configured, an action link is shown immediately after creation."
            />
          </ModalSection>
        </div>
      </Modal>

      {/* edit modal */}
      <Modal
        open={!!editing()}
        onClose={() => setEditing(null)}
        title={`Edit ${editing()?.email ?? ""}`}
        subtitle="Modify user display name, administrative role, and account authorization status."
        width="max-w-lg"
        footerLeft={
          <span class="text-xs text-ink-400 font-mono">
            Role: {editing()?.role}
          </span>
        }
        footer={
          <>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => setEditing(null)}
            >
              Cancel
            </Btn>
            <Btn
              size="sm"
              onClick={saveEdit}
              disabled={busy() || !editing()?.name.trim()}
            >
              {busy() ? "Saving…" : "Save changes"}
            </Btn>
          </>
        }
      >
        <Show when={editing()}>
          {(u) => (
            <div class="space-y-6">
              <ModalSection
                title="Account Information"
                subtitle="Primary identity and access privileges."
              >
                <div class="space-y-3.5">
                  <ModalField label="Display name">
                    <input
                      type="text"
                      value={u().name}
                      onInput={(e) => setEditing({ ...u(), name: e.currentTarget.value })}
                      class="w-full rounded-lg border border-line bg-ink-950/70 px-3 py-2 text-xs text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none transition-colors"
                    />
                  </ModalField>

                  <ModalField label="Gateway role">
                    <div class="flex flex-wrap gap-2 pt-1">
                      <FilterChip
                        selected={u().role === "user"}
                        onClick={() => setEditing({ ...u(), role: "user" })}
                      >
                        User
                      </FilterChip>
                      <FilterChip
                        selected={u().role === "admin"}
                        onClick={() => setEditing({ ...u(), role: "admin" })}
                      >
                        Admin
                      </FilterChip>
                    </div>
                  </ModalField>

                  <ModalField label="Account status" hint="Banning immediately revokes active sessions and blocks all proxy keys.">
                    <div class="flex flex-wrap gap-2 pt-1">
                      <FilterChip
                        selected={u().status === "active"}
                        onClick={() => setEditing({ ...u(), status: "active" })}
                      >
                        Active
                      </FilterChip>
                      <FilterChip
                        selected={u().status === "banned"}
                        onClick={() => setEditing({ ...u(), status: "banned" })}
                      >
                        Banned (all keys blocked)
                      </FilterChip>
                    </div>
                  </ModalField>
                </div>
              </ModalSection>
            </div>
          )}
        </Show>
      </Modal>

      {/* invite/reset link modal (SMTP absent) */}
      <Modal
        open={!!inviteLink()}
        onClose={() => setInviteLink("")}
        title="Account action link"
        subtitle="SMTP is not configured on this instance. Copy and share this secure one-time onboarding link."
        width="max-w-lg"
        footerLeft={
          <div class="text-xs text-amber-400 font-medium flex items-center gap-1.5">
            <span class="inline-block w-2 h-2 rounded-full bg-amber-500" />
            <span>Single-use link</span>
          </div>
        }
        footer={
          <>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => copyWithToast(inviteLink())}
            >
              <Icon name={Icons.copy} size={13} />
              <span>Copy link</span>
            </Btn>
            <Btn
              size="sm"
              onClick={() => setInviteLink("")}
            >
              Done
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <div class="rounded-xl border border-line bg-ink-950/80 p-3.5 space-y-2">
            <div class="text-xs text-ink-400 font-medium">One-time setup URL</div>
            <code class="block font-mono text-xs text-emerald-300 break-all select-all bg-ink-900/60 p-2.5 rounded-lg border border-line/40">
              {inviteLink()}
            </code>
          </div>

          <ModalNotice tone="info" title="Manual distribution required">
            Since outbound email is disabled, deliver this URL to the user securely. It will expire after first use.
          </ModalNotice>
        </div>
      </Modal>

      {/* reset-2FA confirm */}
      <Modal
        open={!!confirmReset2fa()}
        onClose={() => setConfirmReset2fa(null)}
        title="Reset 2FA"
        subtitle="Remove two-factor authentication requirement for this account."
        width="max-w-lg"
        footerLeft={
          <div class="text-xs text-amber-400 font-medium flex items-center gap-1.5">
            <Icon name={Icons.shield} size={13} />
            <span>Security reset</span>
          </div>
        }
        footer={
          <>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => setConfirmReset2fa(null)}
            >
              Cancel
            </Btn>
            <Btn
              variant="danger"
              size="sm"
              onClick={reset2fa}
              disabled={busy()}
            >
              Reset 2FA
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <ModalNotice tone="warn" title="Reset TOTP authentication">
            Reset two-factor authentication for <strong class="text-white">{confirmReset2fa()?.email}</strong>? Their existing authenticator app keys will be discarded.
          </ModalNotice>
          <div class="rounded-xl border border-line bg-ink-950/40 p-3.5 space-y-2 text-xs text-ink-300">
            <div class="font-medium text-ink-100">Security reset outcome:</div>
            <ul class="list-disc list-inside space-y-1 text-ink-400 pl-1">
              <li>TOTP secret will be wiped from the account.</li>
              <li>Active sessions will remain logged in.</li>
              <li>The user will be prompted to enroll a new authenticator upon their next login.</li>
            </ul>
          </div>
        </div>
      </Modal>

      {/* delete confirm */}
      <Modal
        open={!!confirmDelete()}
        onClose={() => setConfirmDelete(null)}
        title="Delete user"
        subtitle="Permanently delete this user account, their API keys, and active sessions."
        width="max-w-lg"
        footerLeft={
          <div class="text-xs text-rose-400 font-medium flex items-center gap-1.5">
            <Icon name={Icons.trash} size={13} />
            <span>Permanent deletion</span>
          </div>
        }
        footer={
          <>
            <Btn
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(null)}
            >
              Cancel
            </Btn>
            <Btn
              variant="danger"
              size="sm"
              onClick={remove}
              disabled={busy()}
            >
              Delete user
            </Btn>
          </>
        }
      >
        <div class="space-y-4">
          <ModalNotice tone="danger" title="Confirm account deletion">
            Delete <strong class="text-white">{confirmDelete()?.email}</strong>? All their active sessions,
            gateway API keys, and authentication credentials will be permanently erased.
          </ModalNotice>
          <div class="rounded-xl border border-line bg-ink-950/40 p-3.5 space-y-2 text-xs text-ink-300">
            <div class="font-medium text-ink-100">Permanent erasure details:</div>
            <ul class="list-disc list-inside space-y-1 text-ink-400 pl-1">
              <li>User row, password hashes, and TOTP secrets are permanently removed.</li>
              <li>All gateway API keys owned by this user are deleted.</li>
              <li>Historical usage records remain safely kept for audit and financial accounting.</li>
            </ul>
          </div>
        </div>
      </Modal>
    </div>
  );
}
