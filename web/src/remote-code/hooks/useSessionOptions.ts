import type { DaemonCommand } from "../daemon-protocol";
import { createSignal } from "solid-js";

/** Opções de sessão (model/effort/mode/skills/access) + reconciliação com o
 * daemon (extraído de RemoteCodePage verbatim). */
export function createSessionOptions(opts: {
  send: (payload: DaemonCommand) => void;
  getSessionId: () => string;
}) {
  const [effort, setEffort] = createSignal("medium");
  const [agentMode, setAgentMode] = createSignal("build");
  const [selectedSkills, setSelectedSkills] = createSignal<string[]>([]);
  const [activeModel, setActiveModel] = createSignal("");
  const [yoloMode, setYoloMode] = createSignal(true);
  const [modeMenuOpen, setModeMenuOpen] = createSignal(false);
  const [accessMenuOpen, setAccessMenuOpen] = createSignal(false);
  let modeBtn: HTMLButtonElement | undefined;
  let accessBtn: HTMLButtonElement | undefined;
  function sessionOptions() { return { effort: effort(), mode: agentMode(), skills: selectedSkills(), access: yoloMode() ? "full" : "ask" }; }
  let lastLocalSelection: ReturnType<typeof sessionOptions> & { model: string } | undefined;
  let pendingSessionChoice: { sessionId: string; choice: ReturnType<typeof sessionOptions> & { model: string } } | undefined;
  function matchesChoice(a: any, b: any) {
    return a?.model === b?.model && a?.effort === b?.effort && a?.mode === b?.mode && a?.access === b?.access && JSON.stringify(a?.skills || []) === JSON.stringify(b?.skills || []);
  }
  function configureSession() {
    lastLocalSelection = { model: activeModel(), ...sessionOptions() };
    pendingSessionChoice = opts.getSessionId() ? { sessionId: opts.getSessionId(), choice: lastLocalSelection } : undefined;
    if (opts.getSessionId()) opts.send({ type: "configure_session", sessionId: opts.getSessionId(), model: activeModel(), options: sessionOptions() });
  }

  function applyOptions(options: any) {
    setEffort(options?.effort || "medium");
    setAgentMode(options?.mode || "build");
    setSelectedSkills(Array.isArray(options?.skills) ? options.skills : []);
    setYoloMode(options?.access !== "ask");
  }

  /** Reconcilia a seleção vinda do daemon (session_data): acks de configure
   * mais antigos não esmagam uma escolha local mais recente. */
  function reconcileServerSelection(sid: string, model: string | undefined, options: any, knownModelIds: string[], fallbackModelId: string) {
    // Older configure acknowledgements must not overwrite a newer choice
    // while multiple changes are travelling to/from the daemon.
    const pending = pendingSessionChoice?.sessionId === sid ? pendingSessionChoice : undefined;
    if (!pending || matchesChoice({ model, ...options }, pending.choice)) {
      pendingSessionChoice = undefined;
      if (model) setActiveModel(knownModelIds.some((m) => m === model) ? model : fallbackModelId);
      applyOptions(options);
    }
  }

  /** Troca de sessão/host: esquece escolhas locais pendentes. */
  function resetPending() {
    lastLocalSelection = undefined;
    pendingSessionChoice = undefined;
  }
  /** Socket fechado: esquece só o ack pendente (a seleção local sobrevive). */
  function resetPendingChoice() {
    pendingSessionChoice = undefined;
  }
  function getLastLocalSelection() {
    return lastLocalSelection;
  }
  function clearLastLocalSelection() {
    lastLocalSelection = undefined;
  }

  return {
    effort, setEffort, agentMode, setAgentMode, selectedSkills, setSelectedSkills,
    activeModel, setActiveModel, yoloMode, setYoloMode,
    modeMenuOpen, setModeMenuOpen, accessMenuOpen, setAccessMenuOpen,
    modeBtn, accessBtn,
    sessionOptions, matchesChoice, configureSession, applyOptions,
    reconcileServerSelection, resetPending, resetPendingChoice, getLastLocalSelection, clearLastLocalSelection,
  };
}

export type SessionOptions = ReturnType<typeof createSessionOptions>;
