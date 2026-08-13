import { createSignal, onMount, Show, For, createResource } from "solid-js";

import { api, currentSession, setSession, type PublicUser } from "../api";
import { PageTitle, navigate } from "../index";
import { usalItems } from "../motion";
import { renderGoogleButton } from "../google";
import {
  Badge, Btn, Card, CardHeader, Icon, Icons, Input, Modal, Spinner, copyWithToast, fmtDate, toast,
} from "../ui";

export default function SettingsPage() {
  const me = () => currentSession()!.user;
  const [name, setName] = createSignal(me().name);
  const [busy, setBusy] = createSignal(false);

  // password section
  const [curPw, setCurPw] = createSignal("");
  const [newPw, setNewPw] = createSignal("");
  const [newPw2, setNewPw2] = createSignal("");

  // totp section
  const [totpSetup, setTotpSetup] = createSignal<{ secret: string; otpauthUri: string; qrDataUrl: string } | null>(null);
  const [totpCode, setTotpCode] = createSignal("");
  const [disableTotpOpen, setDisableTotpOpen] = createSignal(false);
  const [totpDisableCode, setTotpDisableCode] = createSignal("");

  // google link
  let googleDiv: HTMLDivElement | undefined;
  const [googleClientId, setGoogleClientId] = createSignal<string | null>(null);

  // session naming
  const [namingJti, setNamingJti] = createSignal<string | null>(null);
  const [sessionLabel, setSessionLabel] = createSignal("");

  // sessions
  const [sessions, { refetch: refetchSessions }] = createResource(async () => {
    const j = await api<{ sessions: any[] }>("GET", "/api/me/sessions");
    return j.sessions;
  });

  const refreshMe = (user: PublicUser) => {
    setSession({ ...currentSession()!, user });
  };

  onMount(async () => {
    if (me().googleLinked) return;
    try {
      const cfg = await api<{ googleClientId: string | null }>("GET", "/api/auth/config");
      setGoogleClientId(cfg.googleClientId);
      if (cfg.googleClientId && googleDiv) {
        renderGoogleButton(googleDiv, cfg.googleClientId, async (idToken) => {
          try {
            await api("POST", "/api/me/google/link", { idToken });
            toast("Google account linked");
            await reloadMe();
          } catch (e) {
            toast(e instanceof Error ? e.message : "link failed", "err");
          }
        });
      }
    } catch {}
  });

  const reloadMe = async () => {
    const j = await api<{ user: PublicUser }>("GET", "/api/me");
    refreshMe(j.user);
  };

  const saveName = async () => {
    setBusy(true);
    try {
      const j = await api<{ user: PublicUser }>("PATCH", "/api/me", { name: name().trim() });
      refreshMe(j.user);
      toast("Profile updated");
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const savePassword = async () => {
    if (newPw().length < 10) return toast("At least 10 characters", "err");
    if (newPw() !== newPw2()) return toast("Passwords do not match", "err");
    setBusy(true);
    try {
      await api("POST", "/api/me/password", {
        currentPassword: curPw() || undefined,
        newPassword: newPw(),
      });
      toast("Password updated");
      setCurPw("");
      setNewPw("");
      setNewPw2("");
      await reloadMe();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const startTotp = async () => {
    setBusy(true);
    try {
      const j = await api<{ secret: string; otpauthUri: string; qrDataUrl: string }>("POST", "/api/me/2fa/setup");
      setTotpSetup(j);
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const enableTotp = async () => {
    setBusy(true);
    try {
      await api("POST", "/api/me/2fa/enable", { code: totpCode() });
      toast("Two-factor authentication enabled");
      setTotpSetup(null);
      setTotpCode("");
      await reloadMe();
    } catch (e) {
      toast(e instanceof Error ? e.message : "invalid code", "err");
    } finally {
      setBusy(false);
    }
  };

  const disableTotp = async () => {
    setBusy(true);
    try {
      await api("POST", "/api/me/2fa/disable", { code: totpDisableCode() });
      toast("Two-factor authentication disabled");
      setDisableTotpOpen(false);
      setTotpDisableCode("");
      await reloadMe();
    } catch (e) {
      toast(e instanceof Error ? e.message : "invalid code", "err");
    } finally {
      setBusy(false);
    }
  };

  const unlinkGoogle = async () => {
    setBusy(true);
    try {
      await api("DELETE", "/api/me/google/link");
      toast("Google account unlinked");
      await reloadMe();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const revokeSession = async (jti: string) => {
    try {
      await api("DELETE", `/api/me/sessions/${jti}`);
      toast("Session revoked");
      refetchSessions();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    }
  };

  const saveSessionLabel = async () => {
    const jti = namingJti();
    if (!jti) return;
    try {
      await api("PATCH", `/api/me/sessions/${jti}`, { label: sessionLabel().trim() });
      toast("Session named");
      setNamingJti(null);
      refetchSessions();
    } catch (e) {
      toast(e instanceof Error ? e.message : "failed", "err");
    }
  };

  return (
    <div>
      <PageTitle title="Settings" subtitle="Profile, security and active sessions" />

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6" {...usalItems("fade-u", 90)}>
        <Card>
          <CardHeader title="Profile" />
          <div class="px-6 pb-6 space-y-4">
            <Input label="Display name" value={name()} onInput={setName} />
            <div>
              <span class="block text-xs font-medium text-ink-300 mb-1.5">Email</span>
              <div class="text-sm text-ink-400">{me().email}</div>
            </div>
            <div class="flex justify-end">
              <Btn onClick={saveName} disabled={busy() || !name().trim()}>Save</Btn>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Password" subtitle={me().hasPassword ? "Change your password" : "You don't have a password yet — set one"} />
          <div class="px-6 pb-6 space-y-4">
            <Show when={me().hasPassword}>
              <Input label="Current password" type="password" value={curPw()} onInput={setCurPw} autocomplete="current-password" />
            </Show>
            <Input label="New password" type="password" value={newPw()} onInput={setNewPw} autocomplete="new-password" hint="At least 10 characters" />
            <Input label="Confirm new password" type="password" value={newPw2()} onInput={setNewPw2} autocomplete="new-password" />
            <div class="flex justify-end">
              <Btn onClick={savePassword} disabled={busy() || !newPw()}>Update password</Btn>
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Two-factor authentication"
            subtitle="TOTP (Google Authenticator, Aegis, 1Password…)"
            right={
              <Badge tone={me().totpEnabled ? "green" : "zinc"}>{me().totpEnabled ? "Enabled" : "Disabled"}</Badge>
            }
          />
          <div class="px-6 pb-6 space-y-4">
            <Show
              when={me().totpEnabled}
              fallback={
                <Show
                  when={totpSetup()}
                  fallback={
                    <Btn variant="outline" onClick={startTotp} disabled={busy()}>
                      <Icon name={Icons.shield} /> Set up 2FA
                    </Btn>
                  }
                >
                  <div class="flex flex-col sm:flex-row gap-4 items-start">
                    <img src={totpSetup()!.qrDataUrl} alt="TOTP QR code" class="w-36 h-36 rounded-xl border border-line bg-white p-1.5 shadow-sm" />
                    <div class="flex-1 space-y-3 min-w-0">
                      <p class="text-xs text-ink-400">Scan with your authenticator, or enter this secret manually:</p>
                      <div class="flex items-center gap-2">
                        <code class="text-xs text-emerald-500 break-all select-all">{totpSetup()!.secret}</code>
                        <Btn variant="ghost" size="sm" onClick={() => copyWithToast(totpSetup()!.secret)}>
                          <Icon name={Icons.copy} />
                        </Btn>
                      </div>
                      <Input label="Enter the 6-digit code to confirm" value={totpCode()} onInput={setTotpCode}
                        placeholder="123456" autocomplete="one-time-code" />
                      <div class="flex gap-2">
                        <Btn variant="ghost" onClick={() => { setTotpSetup(null); setTotpCode(""); }}>Cancel</Btn>
                        <Btn onClick={enableTotp} disabled={busy() || totpCode().length !== 6}>
                          {busy() ? <Spinner /> : "Enable 2FA"}
                        </Btn>
                      </div>
                    </div>
                  </div>
                </Show>
              }
            >
              <p class="text-sm text-ink-300">Your account requires a 6-digit code at sign-in.</p>
              <Btn variant="ghost" class="text-rose-500 hover:bg-rose-500/10" onClick={() => setDisableTotpOpen(true)}>
                Disable 2FA
              </Btn>
            </Show>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Google account"
            subtitle="Sign in faster with a linked Google account"
            right={
              <Badge tone={me().googleLinked ? "green" : "zinc"}>{me().googleLinked ? "Linked" : "Not linked"}</Badge>
            }
          />
          <div class="px-6 pb-6 space-y-4">
            <Show
              when={me().googleLinked}
              fallback={
                <Show when={googleClientId()} fallback={<p class="text-xs text-ink-500">Google sign-in is not configured on this gateway.</p>}>
                  <p class="text-xs text-ink-400">Link any Google account to sign in with it — the email does not need to match:</p>
                  <div ref={googleDiv} class="inline-flex overflow-hidden rounded-full" />
                </Show>
              }
            >
              <p class="text-sm text-ink-300">You can sign in using your Google account.</p>
              <Btn variant="ghost" class="text-rose-500 hover:bg-rose-500/10" onClick={unlinkGoogle} disabled={busy()}>
                Unlink Google
              </Btn>
            </Show>
          </div>
        </Card>
      </div>

      <Card class="mt-6">
        <CardHeader title="Active sessions" subtitle="Devices currently signed in" />
        <div class="px-6 pb-6">
          <ul class="divide-y divide-line" {...usalItems("fade-u", 40)}>
            <For each={sessions() ?? []}>
              {(s) => (
                <li class="py-3 flex items-center justify-between gap-3">
                  <div class="min-w-0">
                    {s.current ? <Badge tone="indigo">This session</Badge> : null}
                    <div class="text-sm flex items-center gap-2">
                      <Show
                        when={namingJti() === s.jti}
                        fallback={
                            <span class="text-ink-200">{s.label || <span class="text-ink-500">Unnamed device</span>}</span>
                        }
                      >
                        <input
                          value={sessionLabel()}
                          onInput={(e) => setSessionLabel(e.currentTarget.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveSessionLabel();
                            if (e.key === "Escape") setNamingJti(null);
                          }}
                          placeholder="e.g. My laptop"
                          class="rounded-lg border border-line bg-elev px-2.5 py-1.5 text-xs text-ink-100 w-44 focus:border-ink-500 focus:outline-none focus:ring-2 focus:ring-ink-500/10"
                        />
                        <Btn size="sm" onClick={saveSessionLabel}>Save</Btn>
                        <Btn size="sm" variant="ghost" onClick={() => setNamingJti(null)}>Cancel</Btn>
                      </Show>
                    </div>
                     <div class="text-ink-500 mt-0.5 text-xs">
                      {s.ip ?? "unknown ip"}
                    </div>
                    <div class="text-[11px] text-ink-500 mt-0.5">
                      created {fmtDate(s.createdAt)} · last used {fmtDate(s.lastUsedAt)} · expires {fmtDate(s.expiresAt)}
                    </div>
                    <Show when={s.ua}>
                      <div class="text-[11px] text-ink-600 truncate max-w-md">{s.ua}</div>
                    </Show>
                  </div>
                  <div class="flex gap-1 shrink-0">
                    <Show when={namingJti() !== s.jti}>
                      <Btn
                        variant="ghost"
                        size="sm"
                        title={s.label ? "Rename" : "Name this device"}
                        onClick={() => { setNamingJti(s.jti); setSessionLabel(s.label ?? ""); }}
                      >
                        <Icon name={Icons.edit} />
                      </Btn>
                    </Show>
                    <Show when={!s.current}>
                      <Btn variant="ghost" size="sm" class="text-rose-400 hover:bg-rose-500/10" onClick={() => revokeSession(s.jti)}>
                        Revoke
                      </Btn>
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Card>

      <Modal open={disableTotpOpen()} onClose={() => setDisableTotpOpen(false)} title="Disable 2FA">
        <div class="space-y-4">
          <p class="text-sm text-ink-300">Enter a current code from your authenticator to confirm.</p>
          <Input label="Authentication code" value={totpDisableCode()} onInput={setTotpDisableCode} placeholder="123456" />
          <div class="flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setDisableTotpOpen(false)}>Cancel</Btn>
            <Btn variant="danger" onClick={disableTotp} disabled={busy() || totpDisableCode().length !== 6}>
              Disable
            </Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// keep the navigate import used (for future deep links)
void navigate;
