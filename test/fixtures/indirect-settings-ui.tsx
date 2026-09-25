import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createSettings } from "../../web/src/indirect-code/hooks/useSettings";
import { SettingsModal } from "../../web/src/indirect-code/modals/SettingsModal";
import { RemoteCodeProvider } from "../../web/src/indirect-code/ctx";
import type { RcConfig } from "../../web/src/indirect-code/store/sessions";

const api: any = { commands: [], notices: [], refreshes: 0 };
(window as any).settingsUI = api;
render(() => {
  const [host, setHost] = createSignal("host-a");
  const [online, setOnline] = createSignal(true);
  const [doc, setDoc] = createSignal<RcConfig | null>({
    id: "daemon",
    hostId: "host-a",
    revision: "v1",
    skills: {
      review: {
        name: "review",
        description: "Review",
        body: "Original instructions",
        enabled: true,
      },
    },
    mcpServers: {
      local: {
        command: "exe",
        args: ["path with spaces"],
        transport: "stdio",
        envKeys: ["TOKEN"],
      },
    },
  });
  const m = createSettings({
    send: (c) => api.commands.push(c),
    isOpen: online,
    isHostOnline: online,
    getHostId: host,
    getConfigDoc: doc,
    refreshConfig: async () => {
      api.refreshes++;
    },
    toast: (message) => api.notices.push(message),
  });
  Object.assign(api, { m, host, setHost, doc, setDoc, setOnline });
  return (
    <RemoteCodeProvider
      host={{ activeHost: () => ({ status: "online" }) } as any}
      session={{} as any}
      transcript={{} as any}
      turnChanges={{} as any}
      composer={{} as any}
      queue={{ queues: () => ({}), queueOf: () => [] } as any}
      background={{ jobs: () => [], sessionJobs: () => [], running: () => [], output: () => ({}), clock: () => 0 } as any}
      modal={m as any}
      ui={{
        appNotice: () => null,
        verboseChat: () => false,
        setVerboseChat: () => {},
        hideToolMessages: () => false,
        setHideToolMessages: () => {},
        convWidth: () => "default",
        setConvWidth: () => {},
        turnNotify: {
          notifyOn: () => false,
          setEnabled: () => {},
          soundOn: () => false,
          setSound: () => {},
          permission: () => "default",
          testNotify: () => {},
        },
        pushSub: {
          supported: () => false,
          state: () => "off",
          sync: async () => {},
        },
        daemonUpdate: {
          info: () => null,
          toggle: () => {},
          checkNow: () => {},
          applying: () => false,
          apply: () => {},
        },
      } as any}
    >
      <SettingsModal />
    </RemoteCodeProvider>
  );
}, document.getElementById("root")!);
