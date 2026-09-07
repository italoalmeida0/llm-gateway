import { createMemo, createSignal } from "solid-js";
import { api, type RemoteHostDto } from "../../api";

/** Hosts + pairing indireto (extraído de RemoteCodePage verbatim). */
export function createHosts(opts: {
  toast: (message: string, kind?: "ok" | "err") => void;
  showConfirm: (o: { title?: string; message?: string; confirmText?: string; cancelText?: string; danger?: boolean }) => Promise<boolean>;
  /** Após remoção bem-sucedida: a página liberta o espelho do host. */
  onHostRemoved?: (id: string) => void;
}) {
  const [hosts, setHosts] = createSignal<RemoteHostDto[]>([]);
  const [activeHostId, setActiveHostId] = createSignal<string>("");
  const [hostMenuOpen, setHostMenuOpen] = createSignal(false);
  let hostBtn: HTMLButtonElement | undefined;

  const activeHost = createMemo(() => {
    const list = hosts();
    if (!Array.isArray(list) || list.length === 0) return null;
    return list.find((h) => h.id === activeHostId()) ?? list[0] ?? null;
  });

  async function loadHosts() {
    try {
      const res = await api<{ success: boolean; hosts: RemoteHostDto[] }>(
        "GET",
        "/api/remote/hosts",
      );
      const list = Array.isArray(res?.hosts) ? res.hosts : [];
      setHosts(list);
      if (list.length > 0) {
        if (!activeHostId() || !list.some((h) => h.id === activeHostId())) {
          const online = list.find((h) => h.status === "online");
          setActiveHostId(online ? online.id : list[0].id);
        }
      } else {
        setActiveHostId("");
      }
    } catch (e: any) {
      console.warn("Failed to load remote hosts:", e);
      opts.toast("Failed to load remote hosts: " + (e?.message || e), "err");
    }
  }

  async function removeHost() {
    const host = activeHost();
    if (!host) return;
    setHostMenuOpen(false);
    const confirmed = await opts.showConfirm({
      title: `Remove ${host.name || host.hostname || "host"}?`,
      message: "This disconnects the host and revokes its gateway access. Conversations and project files remain on that machine. Pair the daemon again to reconnect.",
      confirmText: "Remove host", danger: true,
    });
    if (!confirmed) return;
    try {
      await api("DELETE", `/api/remote/hosts/${encodeURIComponent(host.id)}`);
      await loadHosts();
      opts.onHostRemoved?.(host.id);
      opts.toast("Host removed", "ok");
    } catch (error: any) { opts.toast(error?.message || "Could not remove host", "err"); }
  }

  function noteHostStatus(hostId: string | undefined, status: string | undefined) {
    if (hostId && status) {
      setHosts((prev) =>
        prev.map((h) => (h.id === hostId ? { ...h, status: status as RemoteHostDto["status"] } : h)),
      );
    }
  }
  function markActiveHostOffline() {
    setHosts((prev) => prev.map((h) => h.id === activeHostId() ? { ...h, status: "offline" as const } : h));
  }

  return {
    hosts, setHosts, activeHostId, setActiveHostId, activeHost,
    hostMenuOpen, setHostMenuOpen, hostBtn,
    loadHosts, removeHost, noteHostStatus, markActiveHostOffline,
  };
}

export type Hosts = ReturnType<typeof createHosts>;
