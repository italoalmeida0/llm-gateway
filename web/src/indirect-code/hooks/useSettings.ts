import type { DaemonCommand, DaemonMessage } from "../daemon-protocol";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import type { AgentSettings, MCPServerConfig, SkillConfig } from "../types";
import type { RcConfig } from "../store/sessions";
import {
  parseMcpArgs,
  parseMcpVariables,
  validConfigName,
  validateMcp,
} from "../utils/settingsValidation";

const defaults: AgentSettings = {
  temperature: 0.7,
  autoCompactPercent: 80,
  noAutoTitle: false,
  jailByDefault: false,
  autoSwarmEnabled: false,
  insecureTls: false,
  httpProxy: "",
  maxExecutionTimeSec: 600,
};
type ConnectionTest = {
  fingerprint: string;
  status: string;
  toolCount?: number;
  message?: string;
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
  const [settingsTab, setSettingsTab] = createSignal<
    "general" | "mcp" | "skills"
  >("general");
  const [daemonSettings, setDaemonSettings] = createSignal<AgentSettings>({
    ...defaults,
  });
  const [mcpServers, setMcpServers] = createSignal<
    Record<string, MCPServerConfig>
  >({});
  const [skills, setSkills] = createSignal<Record<string, SkillConfig>>({});
  const [savingSettings, setSavingSettings] = createSignal(false);
  const [settingsError, setSettingsError] = createSignal("");
  const [baseRevision, setBaseRevision] = createSignal<string>();
  const configDoc = () => {
    const doc = opts.getConfigDoc();
    return doc?.hostId === opts.getHostId() ? doc : null;
  };
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
  let testRequest:
    | { id: string; host: string; name: string; fingerprint: string }
    | undefined;
  let testTimer: ReturnType<typeof setTimeout> | undefined;
  const [testingMcp, setTestingMcp] = createSignal("");
  const [mcpTests, setMcpTests] = createSignal<Record<string, ConnectionTest>>(
    {},
  );

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
        autoSwarmEnabled: s.autoSwarmEnabled ?? s.auto_swarm_enabled ?? false,
        insecureTls: s.insecureTls ?? s.insecure ?? false,
        httpProxy: s.httpProxy ?? s.http_proxy ?? "",
        maxExecutionTimeSec: 600,
      });
      setMcpServers(doc?.mcpServers || {});
      setSkills(doc?.skills || {});
      setBaseRevision(doc?.revision);
    });
  }
  createEffect(() => {
    if (!showConfigModal()) readMirror();
  });
  function stopPending() {
    clearTimeout(saveTimer);
    clearTimeout(testTimer);
    saveRequest = undefined;
    testRequest = undefined;
    setSavingSettings(false);
    setTestingMcp("");
  }
  createEffect(
    on(
      opts.getHostId,
      () => {
        stopPending();
        resetMcpEditor();
        resetSkillEditor();
        setMcpTests({});
        setSettingsError("");
        setShowConfigModal(false);
      },
      { defer: true },
    ),
  );
  onCleanup(stopPending);

  function openSettings(sectionId?: string) {
    if (!configDoc()) {
      opts.toast("Wait for the host settings to load", "err");
      return;
    }
    readMirror();
    setSettingsError("");
    resetMcpEditor();
    resetSkillEditor();
    setSettingsTab(
      sectionId?.includes("mcp")
        ? "mcp"
        : sectionId?.includes("skill")
          ? "skills"
          : "general",
    );
    setShowConfigModal(true);
  }
  function cancelSettings() {
    if (savingSettings()) return;
    stopPending();
    resetMcpEditor();
    resetSkillEditor();
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
        resetMcpEditor();
        resetSkillEditor();
        setSettingsError("");
        setMcpTests({});
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
    resetMcpEditor();
    resetSkillEditor();
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
    if (
      newMcpName() ||
      newMcpCmd() ||
      newMcpUrl() ||
      newMcpArgs().trim() !== "[]" ||
      newMcpEnv() ||
      newMcpHeaders() ||
      newMcpTransport() !== "stdio" ||
      newSkillName() ||
      newSkillDesc() ||
      newSkillBody()
    ) {
      setSettingsError(
        "Apply or cancel the open server or skill editor before saving settings.",
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
        auto_swarm_enabled: s.autoSwarmEnabled,
        insecure: s.insecureTls,
        http_proxy: s.httpProxy,
      },
      mcpServers: mcpServers(),
      skills: skills(),
    });
    return true;
  }

  const [editingMcp, setEditingMcp] = createSignal("");
  const [newMcpName, setNewMcpName] = createSignal("");
  const [newMcpCmd, setNewMcpCmd] = createSignal("");
  const [newMcpArgs, setNewMcpArgs] = createSignal("[]");
  const [newMcpTransport, setNewMcpTransport] = createSignal("stdio");
  const [newMcpUrl, setNewMcpUrl] = createSignal("");
  const [newMcpEnv, setNewMcpEnv] = createSignal("");
  const [newMcpHeaders, setNewMcpHeaders] = createSignal("");
  function resetMcpEditor() {
    setEditingMcp("");
    setNewMcpName("");
    setNewMcpCmd("");
    setNewMcpArgs("[]");
    setNewMcpTransport("stdio");
    setNewMcpUrl("");
    setNewMcpEnv("");
    setNewMcpHeaders("");
  }
  function editMcpServer(name: string) {
    const server = mcpServers()[name];
    if (!server) return;
    setEditingMcp(name);
    setNewMcpName(name);
    setNewMcpCmd(server.command || "");
    setNewMcpArgs(JSON.stringify(server.args || []));
    setNewMcpTransport(
      server.transport === "streamable-http"
        ? "http"
        : server.transport || "stdio",
    );
    setNewMcpUrl(server.url || "");
    setNewMcpEnv(server.env ? JSON.stringify(server.env, null, 2) : "");
    setNewMcpHeaders(
      server.headers ? JSON.stringify(server.headers, null, 2) : "",
    );
  }
  function handleAddMcpServer() {
    const name = newMcpName().trim();
    try {
      if (!validConfigName(name))
        throw new Error(
          "Use a server name of 1–64 letters, digits, dots, underscores or hyphens, starting with a letter or digit.",
        );
      if (name !== editingMcp() && Object.hasOwn(mcpServers(), name))
        throw new Error("A server with this name already exists.");
      if (!editingMcp() && Object.keys(mcpServers()).length >= 32)
        throw new Error("At most 32 MCP servers are supported.");
      const server: MCPServerConfig = {
        ...mcpServers()[editingMcp()],
        command: newMcpCmd().trim(),
        args: parseMcpArgs(newMcpArgs()),
        transport: newMcpTransport(),
        url: newMcpUrl().trim(),
        env: parseMcpVariables(newMcpEnv()),
        headers: parseMcpVariables(newMcpHeaders(), true),
      };
      validateMcp(server);
      setMcpServers((current) => ({ ...current, [name]: server }));
      resetMcpEditor();
      setSettingsError("");
    } catch (error) {
      setSettingsError((error as Error).message);
    }
  }
  function handleDeleteMcpServer(name: string) {
    setMcpServers((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    if (editingMcp() === name) resetMcpEditor();
  }
  function toggleMcp(name: string) {
    setMcpServers((prev) => ({
      ...prev,
      [name]: { ...prev[name], disabled: !prev[name].disabled },
    }));
  }
  function testMcpServer(name: string) {
    if (testingMcp()) return;
    if (!opts.isOpen() || !opts.isHostOnline()) {
      setSettingsError("Reconnect the host before testing an MCP connection.");
      return;
    }
    if (settingsChanged()) {
      setSettingsError(
        "Settings changed on another client. Reload them before testing this connection.",
      );
      return;
    }
    const server = mcpServers()[name];
    if (!server) return;
    testRequest = {
      id: crypto.randomUUID(),
      host: opts.getHostId(),
      name,
      fingerprint: JSON.stringify(server),
    };
    setTestingMcp(name);
    testTimer = setTimeout(() => {
      if (testRequest)
        setMcpTests((prev) => ({
          ...prev,
          [name]: {
            fingerprint: testRequest!.fingerprint,
            status: "error",
            message:
              "Connection test timed out. Reconnect the host and try again.",
          },
        }));
      testRequest = undefined;
      setTestingMcp("");
    }, 25000);
    opts.send({ type: "test_mcp", requestId: testRequest.id, expectedRevision: baseRevision(), name, server });
  }
  function mcpTest(name: string) {
    const test = mcpTests()[name];
    return test?.fingerprint === JSON.stringify(mcpServers()[name])
      ? test
      : undefined;
  }

  const [editingSkill, setEditingSkill] = createSignal("");
  const [newSkillName, setNewSkillName] = createSignal("");
  const [newSkillDesc, setNewSkillDesc] = createSignal("");
  const [newSkillBody, setNewSkillBody] = createSignal("");
  function resetSkillEditor() {
    setEditingSkill("");
    setNewSkillName("");
    setNewSkillDesc("");
    setNewSkillBody("");
  }
  function editSkill(name: string) {
    const skill = skills()[name];
    if (!skill) return;
    setEditingSkill(name);
    setNewSkillName(name);
    setNewSkillDesc(skill.description);
    setNewSkillBody(skill.body);
  }
  function handleAddSkill() {
    const name = newSkillName().trim(),
      description = newSkillDesc().trim(),
      body = newSkillBody().trim();
    if (!validConfigName(name) || !body) {
      setSettingsError("A valid skill name and instruction body are required.");
      return;
    }
    if (name !== editingSkill() && Object.hasOwn(skills(), name)) {
      setSettingsError("A skill with this name already exists.");
      return;
    }
    if (
      (!editingSkill() && Object.keys(skills()).length >= 128) ||
      new TextEncoder().encode(body).length > 65536 ||
      new TextEncoder().encode(description).length > 1024
    ) {
      setSettingsError(
        "At most 128 skills are supported, with a 64 KiB body and 1 KiB description each.",
      );
      return;
    }
    setSkills((prev) => ({
      ...prev,
      [name]: {
        name,
        description,
        body,
        enabled: prev[editingSkill()]?.enabled ?? true,
      },
    }));
    resetSkillEditor();
    setSettingsError("");
  }
  function toggleSkill(name: string) {
    setSkills((prev) => ({
      ...prev,
      [name]: { ...prev[name], enabled: !prev[name].enabled },
    }));
  }
  function handleDeleteSkill(name: string) {
    setSkills((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    if (editingSkill() === name) resetSkillEditor();
  }

  function handleSettingsMessage(msg: DaemonMessage): boolean {
    if (msg.hostId !== opts.getHostId()) return false;
    if (
      msg.type === "config_updated" &&
      saveRequest &&
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
            resetMcpEditor();
            resetSkillEditor();
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
      msg.type === "mcp_status" &&
      testRequest &&
      testRequest.id === msg.requestId &&
      msg.name === testRequest.name
    ) {
      const request = testRequest;
      clearTimeout(testTimer);
      testRequest = undefined;
      setTestingMcp("");
      setMcpTests((prev) => ({
        ...prev,
        [request.name]: {
          fingerprint: request.fingerprint,
          status: msg.status,
          toolCount: msg.toolCount,
          message: msg.message,
        },
      }));
      return true;
    }
    if (
      msg.type === "error" &&
      saveRequest &&
      saveRequest.id === msg.requestId
    ) {
      failSave(msg.message || "Settings could not be saved.");
      return true;
    }
    if (
      msg.type === "error" &&
      testRequest &&
      testRequest.id === msg.requestId
    ) {
      const request = testRequest;
      clearTimeout(testTimer);
      testRequest = undefined;
      setTestingMcp("");
      setMcpTests((prev) => ({
        ...prev,
        [request.name]: {
          fingerprint: request.fingerprint,
          status: "error",
          message: msg.message || "MCP connection test failed.",
        },
      }));
      return true;
    }
    return false;
  }
  return {
    showConfigModal,
    setShowConfigModal,
    settingsTab,
    setSettingsTab,
    savingSettings,
    settingsError,
    settingsChanged,
    daemonSettings,
    setDaemonSettings,
    mcpServers,
    setMcpServers,
    skills,
    setSkills,
    savedSkills,
    openSettings,
    cancelSettings,
    reloadSettings,
    saveDaemonConfig,
    handleSettingsMessage,
    newMcpName,
    setNewMcpName,
    newMcpCmd,
    setNewMcpCmd,
    newMcpArgs,
    setNewMcpArgs,
    newMcpTransport,
    setNewMcpTransport,
    newMcpUrl,
    setNewMcpUrl,
    newMcpEnv,
    setNewMcpEnv,
    newMcpHeaders,
    setNewMcpHeaders,
    editingMcp,
    editMcpServer,
    resetMcpEditor,
    handleAddMcpServer,
    handleDeleteMcpServer,
    toggleMcp,
    testMcpServer,
    testingMcp,
    mcpTest,
    editingSkill,
    editSkill,
    resetSkillEditor,
    newSkillName,
    setNewSkillName,
    newSkillDesc,
    setNewSkillDesc,
    newSkillBody,
    setNewSkillBody,
    handleAddSkill,
    toggleSkill,
    handleDeleteSkill,
  };
}
export type Settings = ReturnType<typeof createSettings>;
