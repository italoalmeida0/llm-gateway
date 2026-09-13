import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";

import { render } from "solid-js/web";
import {
  createSignal,
  createEffect,
  createMemo,
  createResource,
  onCleanup,
  onMount,
  Show,
  For,
  type JSX,
} from "solid-js";

import {
  currentSession,
  onSessionChange,
  setSession,
  api,
  type ApiKeyDto,
} from "./api";
import {
  Icon,
  Icons,
  ThemeToggle,
  Toasts,
  Tooltip,
  toast,
  watchSystemTheme,
} from "./ui";
import LoginPage from "./pages/Login";
import SetPasswordPage from "./pages/SetPassword";
import DashboardPage from "./pages/Dashboard";
import IndirectCodePage from "./indirect-code/IndirectCodePage";
import KeysPage from "./pages/Keys";
import UsagePage from "./pages/Usage";
import SettingsPage from "./pages/Settings";
import AdminProvidersPage from "./pages/admin/Providers";
import AdminModelsPage from "./pages/admin/Models";
import AdminUsersPage from "./pages/admin/Users";
import AdminKeysPage from "./pages/admin/Keys";
import AdminStatsPage from "./pages/admin/Stats";
import AdminAuditPage from "./pages/admin/Audit";

/**
 * Hash router. All app routes live under `#/…` so the static server never
 * has to think about deep links.
 */

const [route, setRoute] = createSignal(parseHash());

function parseHash(): { path: string; query: URLSearchParams } {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, qs] = raw.split("?");
  return { path: path || "/", query: new URLSearchParams(qs ?? "") };
}

export function navigate(to: string): void {
  location.hash = to;
}

window.addEventListener("hashchange", () => setRoute(parseHash()));

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

const USER_NAV: NavItem[] = [
  { path: "/", label: "Overview", icon: Icons.home },
  { path: "/code", label: "Indirect Code", icon: "indirect-code" },
  { path: "/keys", label: "API Keys", icon: Icons.key },
  { path: "/usage", label: "Usage", icon: Icons.chart },
  { path: "/settings", label: "Settings", icon: Icons.cog },
];

const ADMIN_NAV: NavItem[] = [
  { path: "/admin", label: "Global stats", icon: Icons.bolt },
  { path: "/admin/providers", label: "Providers", icon: Icons.server },
  { path: "/admin/models", label: "Models", icon: Icons.layers },
  { path: "/admin/users", label: "Users", icon: Icons.users },
  { path: "/admin/keys", label: "All Keys", icon: Icons.key },
  { path: "/admin/audit", label: "Audit Log", icon: Icons.book },
];

function pageInfo(path: string): NavItem {
  const all = [...USER_NAV, ...ADMIN_NAV];
  return (
    all.find((i) =>
      i.path === "/" || i.path === "/admin"
        ? path === i.path || (i.path === "/admin" && path === "/admin/stats")
        : path.startsWith(i.path),
    ) ?? USER_NAV[0]!
  );
}

function isActive(item: NavItem, current: string): boolean {
  return item.path === "/"
    ? current === "/"
    : item.path === "/admin"
      ? current === "/admin" || current === "/admin/stats"
      : current.startsWith(item.path);
}

function LogoMark(props: { class?: string }) {
  return (
    <div
      class={`rounded-lg bg-brand-500 text-ink-950 flex items-center justify-center border border-brand-600/30 shadow-sm ${props.class ?? "w-8 h-8"}`}
    >
      <svg viewBox="0 0 32 32" class="w-[62%] h-[62%]" aria-hidden="true">
        <path
          d="M16 7l7 4v8l-7 4-7-4v-8z"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
        />
        <circle cx="16" cy="15" r="2.5" fill="currentColor" />
      </svg>
    </div>
  );
}

export { LogoMark };

/** Icon-rail button with hover tooltip (desktop rail). */
function RailItem(props: { item: NavItem; current: string; badge?: number }) {
  const active = () => isActive(props.item, props.current);
  return (
    <Tooltip content={props.item.label} placement="right" delay={50}>
      <a
        href={`#${props.item.path}`}
        class={`gateway-nav relative flex h-9 w-9 lg:w-60 items-center justify-center lg:justify-start lg:px-2.5 gap-2.5 rounded-lg transition-colors duration-150 ${
          active()
            ? "text-ink-100"
            : "text-ink-400 hover:text-ink-100 hover:bg-ink-800/60"
        }`}
        aria-label={props.item.label}
        aria-current={active() ? "page" : undefined}
      >
        <Show when={props.item.icon == "indirect-code"} fallback={
          <Icon name={props.item.icon} size={17} />
        }>
          <img
            src="/indirect-icon.svg"
            alt="Indirect"
            class="w-[17px] h-[17px] shrink-0 object-contain rounded"
          />
        </Show>
        <span class="hidden lg:block text-xs font-medium truncate">{props.item.label}</span>
        <Show when={(props.badge ?? 0) > 0}>
          <span class="absolute top-0.5 right-0.5 lg:static lg:ml-auto min-w-4 h-4 px-1 rounded-md bg-brand-500/10 text-brand-500 text-[9px] font-medium leading-4 text-center tabular-nums">
            {props.badge}
          </span>
        </Show>
      </a>
    </Tooltip>
  );
}

function AppShell(props: { children: JSX.Element }) {
  const user = () => currentSession()!.user;
  const [mobileNav, setMobileNav] = createSignal(false);

  const [keys] = createResource(async () => {
    try {
      const j = await api<{ keys: ApiKeyDto[] }>("GET", "/api/keys");
      return j.keys;
    } catch {
      return [] as ApiKeyDto[];
    }
  });

  const activeKeyCount = createMemo(
    () => (keys() ?? []).filter((k) => k.status === "active").length,
  );
  const info = createMemo(() => pageInfo(route().path));

  const logout = async () => {
    try {
      await api("POST", "/api/auth/logout");
    } catch {}
    setSession(null);
    toast("Signed out");
  };

  // Close the mobile drawer on navigation.
  createEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions -- read inside the effect so route changes re-trigger
    route().path;
    setMobileNav(false);
  });

  const mobileLink = (item: NavItem) => (
    <a
      href={`#${item.path}`}
      class={`flex items-center gap-3 rounded-xl px-4 py-3 text-sm transition-colors ${
        isActive(item, route().path)
          ? "bg-brand-500/10 text-brand-500 font-semibold"
          : "text-ink-300 hover:bg-ink-800/60 hover:text-ink-100"
      }`}
    >
      <Show when={item.icon == "indirect-code"} fallback={
         <Icon name={item.icon} size={20} />
        }>
          <img
            src="/indirect-icon.svg"
            alt="Indirect"
            class="w-[20px] h-[20px] shrink-0 object-contain rounded"
          />
      </Show>
      {item.label}
    </a>
  );

  return (
    <div class="min-h-screen">
      {/* ===== desktop icon rail ===== */}
      <aside class="gateway-rail hidden md:flex fixed inset-y-0 left-0 w-16 lg:w-64 flex-col items-center py-4 border-r border-line z-30">
        <a href="#/" class="flex items-center gap-2.5 lg:w-60 lg:px-2" aria-label="LLM Gateway home">
          <LogoMark />
          <span class="hidden lg:block text-[13px] font-semibold tracking-tight">LLM Gateway</span>
        </a>
        <nav
          class="flex-1 min-h-0 overflow-y-auto flex flex-col items-center gap-1 mt-6"
          aria-label="Main navigation"
        >
          <For each={USER_NAV}>
            {(item) => (
              <RailItem
                item={item}
                current={route().path}
                badge={item.path === "/keys" ? activeKeyCount() : 0}
              />
            )}
          </For>
          <Show when={user().role === "admin"}>
            <span class="w-6 lg:w-56 h-px bg-line mt-4 mb-2 shrink-0" />
            <span class="hidden lg:block w-60 px-2.5 pb-1 text-[10px] font-medium text-ink-500">Administration</span>
            <For each={ADMIN_NAV}>
              {(item) => <RailItem item={item} current={route().path} />}
            </For>
          </Show>
        </nav>
        <div class="flex flex-col lg:flex-row items-center lg:justify-between lg:w-60 lg:px-1 gap-1.5 pt-3">
          <ThemeToggle tooltipPlacement="right" />
          <Tooltip content="Sign out" placement="right" delay={50}>
            <button
              onClick={logout}
              class="flex h-9 w-9 items-center justify-center rounded-lg text-ink-400 hover:text-rose-500 hover:bg-rose-500/10 transition-colors cursor-pointer"
              aria-label="Sign out"
            >
              <Icon name={Icons.logout} size={17} />
            </button>
          </Tooltip>
        </div>
      </aside>

      {/* ===== mobile top bar ===== */}
      <div class="md:hidden sticky top-0 z-40 border-b border-line bg-ink-950/90 backdrop-blur">
        <div class="flex items-center justify-between h-14 px-4">
          <a href="#/" class="flex items-center gap-2.5">
            <LogoMark class="w-8 h-8 rounded-lg" />
            <span class="text-sm font-semibold tracking-tight">
              LLM Gateway
            </span>
          </a>
          <div class="flex items-center gap-1">
            <ThemeToggle />
            <button
              class="flex h-10 w-10 items-center justify-center rounded-xl text-ink-300 hover:bg-ink-800/60 transition-colors cursor-pointer"
              onClick={() => setMobileNav(!mobileNav())}
              aria-label="Menu"
            >
              <Icon name={mobileNav() ? Icons.x : Icons.menu} size={20} />
            </button>
          </div>
        </div>
        <Show when={mobileNav()}>
          <div class="border-t border-line anim-fade-in px-3 py-3 space-y-0.5 max-h-[70vh] overflow-y-auto">
            <For each={USER_NAV}>{mobileLink}</For>
            <Show when={user().role === "admin"}>
              <div class="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-500">
                Admin
              </div>
              <For each={ADMIN_NAV}>{mobileLink}</For>
            </Show>
            <button
              onClick={logout}
              class="w-full flex items-center gap-3 rounded-xl px-4 py-3 text-sm text-rose-500 hover:bg-rose-500/10 transition-colors cursor-pointer"
            >
              <Icon name={Icons.logout} size={20} />
              Sign out
            </button>
          </div>
        </Show>
      </div>

      <main class="md:pl-16 lg:pl-64">
        {/* ===== desktop header ===== */}
        <header
          class="hidden md:flex sticky top-0 z-20 h-14 items-center justify-between gap-4 border-b border-line bg-ink-950/95 backdrop-blur px-6"
        >
          <div class="flex items-center gap-2.5 min-w-0 text-xs">
            <span class="text-ink-500">{route().path.startsWith("/admin") ? "Administration" : "Workspace"}</span>
            <span class="text-ink-600" aria-hidden="true">/</span>
            <span class="text-ink-200 font-medium truncate">{info().label}</span>
          </div>
          <div class="flex items-center gap-3 shrink-0">
            <div class="hidden lg:block text-right mr-1">
              <div class="text-xs font-semibold truncate max-w-44">
                {user().name || user().email}
              </div>
              <div class="text-[11px] text-ink-500 truncate max-w-44">
                {user().email}
              </div>
            </div>
            <div class="w-8 h-8 rounded-lg border border-line bg-card text-ink-300 flex items-center justify-center text-xs font-medium">
              {(user().name || user().email).slice(0, 1).toUpperCase()}
            </div>
          </div>
        </header>

        <div class="mx-auto max-w-7xl px-4 sm:px-6 py-6">
          {props.children}
        </div>
      </main>
    </div>
  );
}

function PageTitle(props: {
  title: string;
  subtitle?: string;
  right?: JSX.Element;
}) {
  return (
    <div
      class="relative flex flex-wrap items-end justify-between gap-3 mb-5"
    >
      <div>
        <h1
          class="text-2xl leading-tight font-semibold tracking-tight"
        >
          {props.title}
        </h1>
        <Show when={props.subtitle}>
          <p class="text-xs leading-relaxed text-ink-400 mt-1.5">{props.subtitle}</p>
        </Show>
      </div>
      {props.right}
    </div>
  );
}

export { PageTitle };

function Root() {
  const [tick, setTick] = createSignal(0);
  const off = onSessionChange(() => setTick((t) => t + 1));
  onCleanup(off);
  onMount(() => watchSystemTheme());

  // Per-page title + favicon (must live in Root: /code renders OUTSIDE
  // AppShell, so an effect there would unmount on exactly the page that
  // needs it). The init script in index.html honors window.__pageIcon.
  createEffect(() => {
    const p = route().path;
    try {
      if (p.startsWith("/code")) {
        document.title = "Indirect Code";
        (window as any).__pageIcon = "/indirect-icon.svg";
      } else {
        document.title = "LLM Gateway";
        delete (window as any).__pageIcon;
      }
      // Re-run the init-script sync (theme observer keeps working after).
      (window as any).__syncFavicon?.();
    } catch {}
  });

  const current = () => {
    void tick();
    return { r: route(), s: currentSession() };
  };

  return (
    <>
      <Show
        when={
          current().s || ["/login", "/set-password"].includes(current().r.path)
        }
        fallback={<LoginPage />}
      >
        <Show
          when={!["/login", "/set-password"].includes(current().r.path)}
          fallback={
            current().r.path === "/set-password" ? (
              <SetPasswordPage query={current().r.query} />
            ) : (
              <LoginPage />
            )
          }
        >
          {(() => {
            const p = route().path;
            if (p.startsWith("/code")) {
              return <IndirectCodePage />;
            }
            return (
              <AppShell>
                {(() => {
                  const isAdmin = currentSession()?.user.role === "admin";
                  if (p === "/") return <DashboardPage />;
                  if (p === "/keys") return <KeysPage />;
                  if (p === "/usage") return <UsagePage />;
                  if (p === "/settings") return <SettingsPage />;
                  if (p.startsWith("/admin") && isAdmin) {
                    if (p === "/admin" || p === "/admin/stats")
                      return <AdminStatsPage />;
                    if (p === "/admin/providers") return <AdminProvidersPage />;
                    if (p === "/admin/models") return <AdminModelsPage />;
                    if (p === "/admin/users") return <AdminUsersPage />;
                    if (p === "/admin/keys") return <AdminKeysPage />;
                    if (p === "/admin/audit") return <AdminAuditPage />;
                  }
                  return <DashboardPage />;
                })()}
              </AppShell>
            );
          })()}
        </Show>
      </Show>
      <Toasts />
    </>
  );
}

// Boot hook: after a fresh login, route away from /login.
createEffect(() => {
  if (currentSession() && ["/login", "/set-password"].includes(route().path)) {
    navigate("/");
  }
});

render(() => <Root />, document.getElementById("app")!);
