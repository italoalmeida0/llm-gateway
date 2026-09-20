import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";
import { useHost, useModal, useUI } from "../ctx";
import { FloatMenu } from "./FloatMenu";

/** Host selector card + floating menu, shared by the sidebar bottom and
 * the full-screen update overlay (UpdateFreezeOverlay).
 *
 * One card instance = one anchor: each HostCard owns its trigger ref
 * LOCALLY (never a shared `hosts.hostBtn` variable). The old shared ref
 * was assigned by whichever card rendered last — sidebar vs overlay
 * fought over it, and the open menu anchored to the hidden card so it
 * appeared "lá em cima" after update/switch. Here the menu renders only
 * when THIS card is the opener (hostMenuAnchor match), so a stale open
 * flag or a hidden card can never misposition it.
 *
 * `id` must be unique per mount site ("sidebar" | "overlay"). */
export function HostCard(props: { id: "sidebar" | "overlay" }) {
  const h = useHost();
  const m = useModal();
  const ui = useUI();
  let btn: HTMLButtonElement | undefined;
  const mine = () => h.hostMenuOpen() && h.hostMenuAnchor() === props.id;
  return (
    <>
      <button
        ref={btn}
        data-menubtn
        aria-label="Select host"
        aria-haspopup="menu"
        aria-expanded={h.hostMenuOpen()}
        onClick={() => {
          // Same instance re-clicked while open -> close. A stale open
          // from the OTHER card -> steal it (switch anchor here).
          const next = h.hostMenuAnchor() === props.id ? !h.hostMenuOpen() : true;
          ui.closeMenus();
          h.setHostMenuAnchor(props.id);
          h.setHostMenuOpen(next);
        }}
        class="w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-elev transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 cursor-pointer"
      >
        <span class="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-card text-ink-400 shrink-0">
          <Iconify icon="lucide:monitor" size={16} />
        </span>
        <span class="flex-1 min-w-0">
          <span class="block truncate text-xs font-medium text-ink-200">{h.activeHost()?.name || h.activeHost()?.hostname || "Select host"}</span>
          <span class="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-500">
            <span class={`h-1.5 w-1.5 rounded-full ${h.connectionState() === "connected" && h.activeHost()?.status === "online" ? "bg-accent-500" : "bg-ink-600"}`} />
            {h.connectionState() !== "connected" ? "Reconnecting…" : h.activeHost()?.status === "online" ? "Connected" : "Offline"}
          </span>
        </span>
        <Iconify icon="lucide:chevrons-up-down" size={13} class="text-ink-500 shrink-0" />
      </button>
      <FloatMenu anchor={() => (btn?.isConnected ? btn : undefined)} open={mine()} placement="top-start" width="18rem">
        <div class="px-2.5 py-2 text-[10px] uppercase tracking-wider font-semibold text-ink-500">Your hosts</div>
        <div role="menu" aria-label="Hosts" class="space-y-0.5">
          <For each={h.hosts()}>{(host) => (
            <button role="menuitemradio" aria-checked={host.id === h.activeHostId()}
              class="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-elev focus-visible:bg-elev cursor-pointer"
              onClick={() => { h.setHostMenuOpen(false); h.setActiveHostId(host.id); }}>
              <Iconify icon="lucide:monitor" size={15} class="text-ink-500 shrink-0" />
              <span class="flex-1 min-w-0"><span class="block truncate text-xs text-ink-200">{host.name || host.hostname || host.id}</span>
                <span class="block text-[11px] text-ink-500">{host.status === "online" ? "Online" : "Offline"}{host.os ? ` · ${host.os}` : ""}</span></span>
              <Show when={host.id === h.activeHostId()}><Iconify icon="lucide:check" size={14} /></Show>
            </button>
          )}</For>
        </div>
        <div class="mt-1 border-t border-line pt-1 space-y-0.5">
          <button class="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-ink-400 hover:bg-elev cursor-pointer"
            onClick={() => { h.setHostMenuOpen(false); void h.loadHosts(); }}><Iconify icon="lucide:refresh-cw" size={13} />Refresh hosts</button>
          <button class="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-ink-200 hover:bg-elev cursor-pointer"
            onClick={() => { h.setHostMenuOpen(false); void m.generatePairingToken(); }}><Iconify icon="lucide:plus" size={13} />Connect another host</button>
          <button class="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-brand-500 hover:bg-elev cursor-pointer" onClick={() => { h.setHostMenuOpen(false); void h.removeHost(); }}>
            <Iconify icon="lucide:trash-2" size={13} />Remove current host
          </button>
        </div>
      </FloatMenu>
    </>
  );
}
