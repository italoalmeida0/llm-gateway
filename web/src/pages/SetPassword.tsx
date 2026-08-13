import { createSignal, Show } from "solid-js";

import { publicApi } from "../api";
import { navigate, LogoMark } from "../index";
import { usal, usalItems } from "../motion";
import { Btn, Card, Input, Spinner, ThemeToggle, capitalize } from "../ui";

/** Landing page for invite + password-reset email links: `#/set-password?token=…` */
export default function SetPasswordPage(props: { query: URLSearchParams }) {
  const token = props.query.get("token") ?? "";
  const [password, setPassword] = createSignal("");
  const [confirm, setConfirm] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [done, setDone] = createSignal(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setError("");
    if (password() !== confirm()) return setError("Passwords do not match");
    if (password().length < 10) return setError("Password must be at least 10 characters");
    setBusy(true);
    try {
      await publicApi("POST", "/api/auth/password-reset/confirm", {
        token,
        password: password(),
      });
      setDone(true);
      setTimeout(() => navigate("/login"), 1800);
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "This link is invalid or has expired");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="relative min-h-screen flex items-center justify-center px-4 py-10 overflow-hidden">
      <div
        class="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(55% 45% at 50% -5%, var(--glow-brand), transparent 72%)",
        }}
      />
      <div class="absolute top-4 right-4 z-10">
        <ThemeToggle />
      </div>

      <div class="relative w-full max-w-sm">
        <div class="flex flex-col items-center mb-8" {...usal("fade-d duration-700")}>
          <div {...usal("zoomin-30 duration-700")}>
            <LogoMark class="w-14 h-14 rounded-2xl mb-5" />
          </div>
          <h1 class="text-2xl font-semibold tracking-tight">Set your password</h1>
        </div>

        <Card class="p-7 shadow-xl shadow-black/5" {...usal("zoomin-15 duration-600 delay-150")}>
          <Show
            when={token}
            fallback={<p class="text-sm text-rose-500">This link is missing its token. Ask for a new one.</p>}
          >
            <Show
              when={!done()}
              fallback={
                <p class="text-sm text-emerald-500">
                  Password set. Redirecting you to sign in…
                </p>
              }
            >
              <Show when={error()}>
                <div class="mb-4 rounded-xl border border-rose-500/25 bg-rose-500/8 px-3.5 py-2.5 text-sm text-rose-500 anim-fade-in">
                  {capitalize(error())}
                </div>
              </Show>
              <form onSubmit={submit} class="space-y-4" {...usalItems("fade-u", 80)}>
                <Input label="New password" type="password" value={password()} onInput={setPassword}
                  autocomplete="new-password" hint="At least 10 characters" required />
                <Input label="Confirm password" type="password" value={confirm()} onInput={setConfirm}
                  autocomplete="new-password" required />
                <Btn type="submit" class="w-full" disabled={busy()}>
                  {busy() ? <Spinner /> : "Save password"}
                </Btn>
              </form>
            </Show>
          </Show>
        </Card>
      </div>
    </div>
  );
}
