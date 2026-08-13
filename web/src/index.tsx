import "@fontsource-variable/inter";

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
  IconTile,
  Icons,
  ThemeToggle,
  Toasts,
  toast,
  watchSystemTheme,
} from "./ui";
import { usal, usalItems } from "./motion";
import LoginPage from "./pages/Login";
import SetPasswordPage from "./pages/SetPassword";
import DashboardPage from "./pages/Dashboard";
import KeysPage from "./pages/Keys";
import UsagePage from "./pages/Usage";
import SettingsPage from "./pages/Settings";
import AdminProvidersPage from "./pages/admin/Providers";
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
  { path: "/keys", label: "API Keys", icon: Icons.key },
  { path: "/usage", label: "Usage", icon: Icons.chart },
  { path: "/settings", label: "Settings", icon: Icons.cog },
];

const ADMIN_NAV: NavItem[] = [
  { path: "/admin", label: "Global stats", icon: Icons.bolt },
  { path: "/admin/providers", label: "Providers", icon: Icons.server },
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
      class={`rounded-xl bg-brand-500 flex items-center justify-center shadow-lg shadow-brand-500/25 ${props.class ?? "w-10 h-10"}`}
    >
      <svg viewBox="0 0 32 32" class="w-[62%] h-[62%]" aria-hidden="true">
        <path
          d="M16 7l7 4v8l-7 4-7-4v-8z"
          fill="none"
          stroke="white"
          stroke-width="2"
        />
        <circle cx="16" cy="15" r="2.5" fill="white" />
      </svg>
    </div>
  );
}

export { LogoMark };

/** Icon-rail button with hover tooltip (desktop rail). */
function RailItem(props: { item: NavItem; current: string; badge?: number }) {
  const active = () => isActive(props.item, props.current);
  return (
    <a
      href={`#${props.item.path}`}
      class={`group relative flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-200 ${
        active()
          ? "bg-brand-500/10 text-brand-500"
          : "text-ink-400 hover:text-ink-100 hover:bg-ink-800/60"
      }`}
      aria-label={props.item.label}
      aria-current={active() ? "page" : undefined}
    >
      <Icon name={props.item.icon} size={22} />
      <Show when={(props.badge ?? 0) > 0}>
        <span class="absolute top-1 right-1 min-w-4 h-4 px-1 rounded-full bg-brand-500 text-white text-[9px] font-bold leading-4 text-center tabular-nums">
          {props.badge}
        </span>
      </Show>
      {/* tooltip */}
      <span class="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-4 whitespace-nowrap rounded-lg border border-line bg-elev px-2.5 py-1.5 text-xs font-medium text-ink-100 shadow-xl shadow-black/10 opacity-0 translate-x-1 transition-all duration-200 group-hover:opacity-100 group-hover:translate-x-0 z-50">
        {props.item.label}
      </span>
    </a>
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
      <Icon name={item.icon} size={20} />
      {item.label}
    </a>
  );

  return (
    <div class="min-h-screen">
      {/* ===== desktop icon rail ===== */}
      <aside class="hidden md:flex fixed inset-y-0 left-0 w-20 flex-col items-center py-5 border-r border-line bg-ink-950 z-30">
        <a href="#/" {...usal("zoomin-25 duration-500")}>
          <LogoMark />
        </a>
        <nav
          class="flex-1 flex flex-col items-center gap-1.5 mt-9"
          {...usalItems("fade-r", 70)}
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
            <span class="w-6 h-px bg-line my-2" />
            <For each={ADMIN_NAV}>
              {(item) => <RailItem item={item} current={route().path} />}
            </For>
          </Show>
        </nav>
        <div class="flex flex-col items-center gap-1.5">
          <ThemeToggle />
          <button
            onClick={logout}
            class="group relative flex h-10 w-10 items-center justify-center rounded-xl text-ink-400 hover:text-rose-500 hover:bg-rose-500/10 transition-all duration-200 cursor-pointer"
            aria-label="Sign out"
          >
            <Icon name={Icons.logout} size={22} />
            <span class="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-4 whitespace-nowrap rounded-lg border border-line bg-elev px-2.5 py-1.5 text-xs font-medium text-ink-100 shadow-xl shadow-black/10 opacity-0 translate-x-1 transition-all duration-200 group-hover:opacity-100 group-hover:translate-x-0 z-50">
              Sign out
            </span>
          </button>
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

      <main class="md:pl-20">
        {/* ===== desktop header ===== */}
        <header
          class="hidden md:flex sticky top-0 z-20 h-[72px] items-center justify-between gap-4 border-b border-line bg-ink-950/85 backdrop-blur px-8"
          {...usal("fade-d duration-500")}
        >
          <div class="flex items-center gap-3.5 min-w-0">
            <IconTile icon={info().icon} class="w-10 h-10" />
            <div class="min-w-0">
              <div class="text-[15px] font-semibold truncate leading-tight">
                {info().label}
              </div>
              <div class="text-xs text-ink-500 truncate leading-tight mt-0.5">
                {user().role === "admin"
                  ? "Admin console"
                  : "Your gateway workspace"}
              </div>
            </div>
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
            <div class="w-9 h-9 rounded-full bg-accent-500 text-accent-fg flex items-center justify-center text-[13px] font-bold shadow-sm">
              {(user().name || user().email).slice(0, 1).toUpperCase()}
            </div>
          </div>
        </header>

        <div class="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-8">
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
      class="flex flex-wrap items-end justify-between gap-4 mb-8"
      {...usal("fade-d duration-500 threshold-20")}
    >
      <div>
        <h1
          class="text-[2rem] leading-tight font-semibold tracking-tight"
          {...usal("fade-d blur")}
        >
          {props.title}
        </h1>
        <Show when={props.subtitle}>
          <p class="text-sm text-ink-500 mt-1">{props.subtitle}</p>
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
          <AppShell>
            {(() => {
              const p = route().path;
              const isAdmin = currentSession()?.user.role === "admin";
              if (p === "/") return <DashboardPage />;
              if (p === "/keys") return <KeysPage />;
              if (p === "/usage") return <UsagePage />;
              if (p === "/settings") return <SettingsPage />;
              if (p.startsWith("/admin") && isAdmin) {
                if (p === "/admin" || p === "/admin/stats")
                  return <AdminStatsPage />;
                if (p === "/admin/providers") return <AdminProvidersPage />;
                if (p === "/admin/users") return <AdminUsersPage />;
                if (p === "/admin/keys") return <AdminKeysPage />;
                if (p === "/admin/audit") return <AdminAuditPage />;
              }
              return <DashboardPage />;
            })()}
          </AppShell>
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
