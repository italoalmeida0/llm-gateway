import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createComposer } from "../../web/src/indirect-code/hooks/useComposer";
import { createTranscript } from "../../web/src/indirect-code/hooks/useTranscript";
import { createReview } from "../../web/src/indirect-code/hooks/useReview";
import { ComposerInput } from "../../web/src/indirect-code/components/composer/ComposerInput";
import { ToolbarSend } from "../../web/src/indirect-code/components/composer/ToolbarSend";
import { ScrollOverlays } from "../../web/src/indirect-code/components/composer/ScrollOverlays";
import { RemoteCodeProvider } from "../../web/src/indirect-code/ctx";

const api: any = { commands: [], notices: [] };
(window as any).composerUI = api;
render(() => {
  const [sid, setSid] = createSignal("session-a"),
    [host, setHost] = createSignal("host-a"),
    [online, setOnline] = createSignal(true);
  const send = (command: any) => api.commands.push(command),
    toast = (message: string) => api.notices.push(message);
  const opts = {
    send,
    toast,
    isOpen: online,
    getSessionId: sid,
    getHostId: host,
    getProjectId: () => "project",
    isHostOnline: online,
  };
  const t = createTranscript({
    ...opts,
    showChoice: async () => "resend",
    showConfirm: async () => true,
    onTurnIdle: () => {},
    onUsageContext: () => {},
  });
  const review = createReview({
    ...opts,
    isSessionRunning: () => t.sessionStatus() === "running",
    showConfirm: async () => true,
  });
  const c = createComposer({
    ...opts,
    isDisposed: () => false,
    getModel: () => "m",
    getOptions: () => ({
      effort: "high",
      mode: "build",
      skills: [],
      access: "full",
    }),
    isSessionRunning: () => t.sessionStatus() === "running",
    isWorkspaceBlocked: () => false,
    checkWorkspace: () => {},
    t,
    o: {
      configureSession: () => {},
      setActiveModel: () => {},
      setEffort: () => {},
    },
    onClearConversation: () => setSid(""),
    onBeginConversation: () => {},
    isCreatingSession: () => false,
  });
  Object.assign(api, { c, t, review, setOnline, setHost, setSid, sid });
  return (
    <RemoteCodeProvider
      host={{} as any}
      session={
        {
          creatingSession: () => false,
          activeSessionId: sid,
          activeProject: () => ({ id: "project" }),
        } as any
      }
      transcript={t as any}
      turnChanges={{} as any}
      composer={{ ...c, activeModel: () => "m" } as any}
      modal={review as any}
      ui={{ isMobile: () => false } as any}
    >
      <ScrollOverlays />
      <ComposerInput />
      <ToolbarSend />
    </RemoteCodeProvider>
  );
}, document.getElementById("root")!);
