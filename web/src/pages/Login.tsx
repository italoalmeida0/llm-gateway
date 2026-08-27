import { createSignal, onMount, Show } from "solid-js";

import { publicApi, setSession } from "../api";
import { LogoMark } from "../index";
import { usal, usalItems } from "../motion";
import { Btn, Input, Spinner, Card, Icon, Icons, ThemeToggle, capitalize } from "../ui";
import { renderGoogleButton } from "../google";

/**
 * Login: email+password, optional TOTP step, Google Sign-In for linked
 * accounts, and the "forgot password" request flow (always answers the same
 * message to avoid account enumeration).
 */

declare global {
  interface Window {
    google?: any;
  }
}

/** Persist the session and hard-reload into the app (guarantees a clean state). */
function enterApp(tokens: { accessToken: string; refreshToken: string; user: any }): void {
  setSession({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, user: tokens.user });
  location.hash = "/";
  location.reload();
}

export default function LoginPage() {
  const [mode, setMode] = createSignal<"login" | "2fa" | "forgot">("login");
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [code, setCode] = createSignal("");
  const [tempToken, setTempToken] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [info, setInfo] = createSignal("");
  const [googleClientId, setGoogleClientId] = createSignal<string | null>(null);

  let googleDiv: HTMLDivElement | undefined;

  onMount(async () => {
    try {
      const cfg = await publicApi<{ googleClientId: string | null; smtpConfigured: boolean }>(
        "GET",
        "/api/auth/config",
      );
      setGoogleClientId(cfg.googleClientId);
      if (cfg.googleClientId && googleDiv) {
        renderGoogleButton(googleDiv, cfg.googleClientId, async (idToken) => {
          setBusy(true);
          setError("");
          try {
            const j = await publicApi<any>("POST", "/api/auth/google", { idToken });
            if (j.needs2FA) {
              setTempToken(j.tempToken);
              setMode("2fa");
              return;
            }
            enterApp(j);
          } catch (e) {
            setError(e instanceof Error ? e.message : "Google sign-in failed");
          } finally {
            setBusy(false);
          }
        });
      }
    } catch {
      /* config failure leaves password login usable */
    }
  });

  const submitLogin = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const j = await publicApi<any>("POST", "/api/auth/login", {
        email: email().trim(),
        password: password(),
      });
      if (j.needs2FA) {
        setTempToken(j.tempToken);
        setMode("2fa");
        return;
      }
      enterApp(j);
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const submit2fa = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const j = await publicApi<any>("POST", "/api/auth/2fa", {
        tempToken: tempToken(),
        code: code().replace(/\s/g, ""),
      });
      enterApp(j);
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Invalid code");
    } finally {
      setBusy(false);
    }
  };

  const submitForgot = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const j = await publicApi<any>("POST", "/api/auth/password-reset/request", {
        email: email().trim(),
      });
      setInfo(j.message ?? "If the account exists, a reset email is on its way.");
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="relative min-h-screen flex items-center justify-center px-4 py-10 overflow-hidden">
      {/* soft brand glow on top */}
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
          <h1
            class="text-2xl font-semibold tracking-tight"
            {...usal("text-shimmer split-letter duration-2400 split-delay-80 loop threshold-60")}
          >
            LLM Gateway
          </h1>
          <p class="text-sm text-ink-500 mt-1.5">Sign in to your account</p>
        </div>

        <Card class="p-7 shadow-xl shadow-black/5" {...usal("zoomin-15 duration-600 delay-150")}>
          <Show when={error()}>
            <div class="mb-4 rounded-xl border border-rose-500/25 bg-rose-500/8 px-3.5 py-2.5 text-sm text-rose-500 anim-fade-in">
              {capitalize(error())}
            </div>
          </Show>
          <Show when={info()}>
            <div class="mb-4 rounded-xl border border-emerald-500/25 bg-emerald-500/8 px-3.5 py-2.5 text-sm text-emerald-500 anim-fade-in">
              {info()}
            </div>
          </Show>

          <Show when={mode() === "login"}>
            <form onSubmit={submitLogin} class="space-y-4" {...usalItems("fade-u", 80)}>
              <Input label="Email" type="email" value={email()} onInput={setEmail} autocomplete="email" required />
              <Input label="Password" type="password" value={password()} onInput={setPassword} autocomplete="current-password" required />
              <Btn type="submit" class="w-full" disabled={busy()}>
                {busy() ? <Spinner /> : "Sign in"}
              </Btn>
              <button
                type="button"
                class="w-full text-center text-xs text-ink-500 hover:text-ink-200 transition-colors cursor-pointer"
                onClick={() => { setMode("forgot"); setError(""); setInfo(""); }}
              >
                Forgot your password?
              </button>
            </form>
          </Show>

          <Show when={mode() === "2fa"}>
            <form onSubmit={submit2fa} class="space-y-4" {...usalItems("fade-u", 80)}>
              <div class="flex items-center gap-2 text-sm text-ink-300">
                <span class="text-brand-500">
                  <Icon name={Icons.shield} size={16} />
                </span>
                Enter the 6-digit code from your authenticator
              </div>
              <Input
                label="Authentication code"
                value={code()}
                onInput={setCode}
                placeholder="123456"
                autocomplete="one-time-code"
                required
              />
              <Btn type="submit" class="w-full" disabled={busy() || code().length !== 6}>
                {busy() ? <Spinner /> : "Verify"}
              </Btn>
              <button
                type="button"
                class="w-full text-center text-xs text-ink-500 hover:text-ink-200 cursor-pointer"
                onClick={() => { setMode("login"); setError(""); }}
              >
                Back
              </button>
            </form>
          </Show>

          <Show when={mode() === "forgot"}>
            <form onSubmit={submitForgot} class="space-y-4" {...usalItems("fade-u", 80)}>
              <p class="text-sm text-ink-300">We'll email you a link to reset your password.</p>
              <Input label="Email" type="email" value={email()} onInput={setEmail} autocomplete="email" required />
              <Btn type="submit" class="w-full" disabled={busy()}>
                {busy() ? <Spinner /> : "Send reset link"}
              </Btn>
              <button
                type="button"
                class="w-full text-center text-xs text-ink-500 hover:text-ink-200 cursor-pointer"
                onClick={() => { setMode("login"); setError(""); setInfo(""); }}
              >
                Back to sign in
              </button>
            </form>
          </Show>

          <Show when={googleClientId()}>
            <div class="mt-5 pt-5 border-t border-line flex justify-center">
              {/* overflow-hidden + rounded-full clips the GSI iframe's white
                  background that would otherwise peek past the pill corners. */}
              <div ref={googleDiv} class="inline-flex overflow-hidden rounded-full" />
            </div>
          </Show>
        </Card>

        <p class="text-center text-[11px] text-ink-500 mt-6">
          <a href="/terms.html" target="_blank" class="hover:text-ink-300 transition-colors">Terms of Service</a>
          {" · "}
          <a href="/privacy.html" target="_blank" class="hover:text-ink-300 transition-colors">Privacy Policy</a>
        </p>
      </div>
    </div>
  );
}
