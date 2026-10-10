import type { DaemonCommand, DaemonMessage } from "../daemon-protocol";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import type { AgentSettings, SkillConfig } from "../types";
import type { RcConfig } from "../store/sessions";

const defaults: AgentSettings = {
  temperature: 0.7,
  autoCompactPercent: 80,
  noAutoTitle: false,
  jailByDefault: false,
  insecureTls: false,
  httpProxy: "",
};

/** Settings edits are local drafts. Only the daemon mirror feeds the composer. */
export function createSettings(opts: {
  send: (payload: DaemonCommand) => void;
  isOpen: () => boolean;
  isHostOnline: () => boolean;
  getHostId: () => string;
  toast: (message: string, kind?: "ok" | "err") => void;
  getConfigDoc: () => RcConfig | null;
  refreshConfig: () => Promise<void>;
}) {
  const [showConfigModal, setShowConfigModal] = createSignal(false);
  const [settingsTab, setSettingsTab] = createSignal<"general">("general");
  const [daemonSettings, setDaemonSettings] = createSignal<AgentSettings>({
    ...defaults,
  });
  const [savingSettings, setSavingSettings] = createSignal(false);
  const [settingsError, setSettingsError] = createSignal("");
  const [baseRevision, setBaseRevision] = createSignal<string>();
  const configDoc = () => {
    const doc = opts.getConfigDoc();
    return doc?.hostId === opts.getHostId() ? doc : null;
  };

  // Skills remain in the config mirror for existing hosts and are consumed by
  // the composer. They are no longer editable through host settings.
  const savedSkills = createMemo<Record<string, SkillConfig>>(
    () => configDoc()?.skills || {},
  );
  const settingsChanged = createMemo(
    () =>
      !!(
        showConfigModal() &&
        !savingSettings() &&
        baseRevision() &&
        configDoc()?.revision &&
        baseRevision() !== configDoc()?.revision
      ),
  );
  let saveRequest: { id: string; host: string; revision?: string } | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  function readMirror() {
    const doc = configDoc();
    const s = doc?.settings || {};
    batch(() => {
      setDaemonSettings({
        temperature: typeof s.temperature === "number" ? s.temperature : 0.7,
        autoCompactPercent:
          s.autoCompactPercent ??
          s.autoCompactThreshold ??
          s.auto_compact_threshold ??
          80,
        noAutoTitle: s.noAutoTitle ?? s.no_auto_title ?? false,
        jailByDefault: s.jailByDefault ?? s.jail_by_default ?? false,
        insecureTls: s.insecureTls ?? s.insecure ?? false,
        httpProxy: s.httpProxy ?? s.http_proxy ?? "",
      });
      setBaseRevision(doc?.revision);
    });
  }

  createEffect(() => {
    if (!showConfigModal()) readMirror();
  });

  function stopPending() {
    clearTimeout(saveTimer);
    saveRequest = undefined;
    setSavingSettings(false);
  }

  createEffect(
    on(
      opts.getHostId,
      () => {
        stopPending();
        setSettingsError("");
        setShowConfigModal(false);
      },
      { defer: true },
    ),
  );
  onCleanup(stopPending);

  function openSettings(_sectionId?: string) {
    if (!configDoc()) {
      opts.toast("Wait for the host settings to load", "err");
      return;
    }
    readMirror();
    setSettingsError("");
    setSettingsTab("general");
    setShowConfigModal(true);
  }

  function cancelSettings() {
    if (savingSettings()) return;
    stopPending();
    setSettingsError("");
    setShowConfigModal(false);
  }

  function reloadSettings() {
    if (savingSettings()) return;
    const host = opts.getHostId();
    void opts
      .refreshConfig()
      .then(() => {
        if (host !== opts.getHostId()) return;
        readMirror();
        setSettingsError("");
      })
      .catch(() => {
        if (host === opts.getHostId())
          setSettingsError(
            "Could not reload settings. Reconnect the host and try again.",
          );
      });
  }

  function failSave(message: string) {
    clearTimeout(saveTimer);
    saveRequest = undefined;
    setSavingSettings(false);
    setSettingsError(message);
  }

  // A save is complete only after the authoritative config mirror reports the
  // revision returned by the daemon.
  createEffect(() => {
    const revision = configDoc()?.revision;
    if (
      !savingSettings() ||
      !saveRequest?.revision ||
      revision !== saveRequest.revision
    )
      return;
    clearTimeout(saveTimer);
    saveRequest = undefined;
    setSavingSettings(false);
    setShowConfigModal(false);
    opts.toast("Settings saved on the host", "ok");
  });

  function saveDaemonConfig() {
    if (savingSettings()) return false;
    if (!opts.isOpen() || !opts.isHostOnline()) {
      setSettingsError("Reconnect the host before saving settings");
      return false;
    }
    if (settingsChanged()) {
      setSettingsError(
        "Settings changed on another client. Reload the latest settings before saving.",
      );
      return false;
    }
    const s = daemonSettings();
    saveRequest = { id: crypto.randomUUID(), host: opts.getHostId() };
    setSettingsError("");
    setSavingSettings(true);
    saveTimer = setTimeout(
      () =>
        failSave(
          "Save confirmation did not arrive. Reload settings to check whether the host saved your changes.",
        ),
      15000,
    );
    opts.send({
      type: "update_config",
      requestId: saveRequest.id,
      expectedRevision: baseRevision(),
      settings: {
        temperature: s.temperature,
        auto_compact_threshold: s.autoCompactPercent,
        no_auto_title: s.noAutoTitle,
        jail_by_default: s.jailByDefault,
        insecure: s.insecureTls,
        http_proxy: s.httpProxy,
      },
    });
    return true;
  }

  function handleSettingsMessage(msg: DaemonMessage): boolean {
    if (msg.hostId !== opts.getHostId()) return false;
    if (
      msg.type === "config_updated" &&
      saveRequest &&
      saveRequest.host === opts.getHostId() &&
      saveRequest.id === msg.requestId
    ) {
      if (!msg.success || !msg.revision) {
        failSave(
          msg.error ||
            "The host did not confirm the save. Update the daemon and reload settings.",
        );
        return true;
      }
      saveRequest.revision = msg.revision;
      const id = saveRequest.id;
      void opts
        .refreshConfig()
        .then(() => {
          if (saveRequest?.id !== id) return;
          // The mirror may already have this revision (a no-op save).
          if (configDoc()?.revision === saveRequest.revision) {
            clearTimeout(saveTimer);
            saveRequest = undefined;
            setSavingSettings(false);
            setShowConfigModal(false);
            opts.toast("Settings saved on the host", "ok");
          }
        })
        .catch(() => {
          if (saveRequest?.id === id)
            failSave(
              "Settings were saved, but the refreshed configuration could not be loaded.",
            );
        });
      return true;
    }
    if (
      msg.type === "error" &&
      saveRequest &&
      saveRequest.host === opts.getHostId() &&
      saveRequest.id === msg.requestId
    ) {
      failSave(msg.message || "Settings could not be saved.");
      return true;
    }
    return false;
  }

  return {
    showConfigModal,
    settingsTab,
    setSettingsTab,
    savingSettings,
    settingsError,
    settingsChanged,
    daemonSettings,
    setDaemonSettings,
    savedSkills,
    openSettings,
    cancelSettings,
    reloadSettings,
    saveDaemonConfig,
    handleSettingsMessage,
  };
}

export type Settings = ReturnType<typeof createSettings>;
