import type { DaemonCommand } from "../daemon-protocol";
import { createEffect, createSignal } from "solid-js";
import type { AgentSettings, MCPServerConfig, SkillConfig } from "../types";
import type { RcConfig } from "../store/sessions";

/** Agent configuration + MCP + skills (extracted verbatim from RemoteCodePage). */
export function createSettings(opts: {
  send: (payload: DaemonCommand) => void;
  isOpen: () => boolean;
  isHostOnline: () => boolean;
  toast: (message: string, kind?: "ok" | "err") => void;
  getConfigDoc: () => RcConfig | null;
}) {
  const [showConfigModal, setShowConfigModal] = createSignal(false);
  const [daemonSettings, setDaemonSettings] = createSignal<AgentSettings>({
    temperature: 0.7,
    autoCompactPercent: 80,
    noAutoTitle: false,
    jailByDefault: false,
    autoSwarmEnabled: false,
    insecureTls: false,
    httpProxy: "",
    maxExecutionTimeSec: 600,
  });
  const [mcpServers, setMcpServers] = createSignal<Record<string, MCPServerConfig>>({});
  const [skills, setSkills] = createSignal<Record<string, SkillConfig>>({});

  // Daemon config mirror → local settings signals. Never clobbers an open
  // Settings modal (that would fight the user's in-flight edits). Model and
  // effort are restored separately from each session's own options.
  createEffect(() => {
    const doc = opts.getConfigDoc();
    if (!doc || showConfigModal()) return;
    const s: any = doc.settings || {};
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
      maxExecutionTimeSec: s.maxExecutionTimeSec ?? 600,
    });

    if (doc.mcpServers && typeof doc.mcpServers === "object") setMcpServers(doc.mcpServers);
    if (doc.skills && typeof doc.skills === "object") setSkills(doc.skills);
  });

  // Settings revert snapshot (chatbot backupForRevert): Cancel restores.
  const [settingsSnapshot, setSettingsSnapshot] = createSignal<string | null>(null);
  function openSettings(sectionId?: string) {
    try {
      setSettingsSnapshot(
        JSON.stringify({
          settings: daemonSettings(),
          mcp: mcpServers(),
          skills: skills(),
        }),
      );
    } catch {}
    setShowConfigModal(true);
    if (sectionId) {
      setTimeout(() => {
        try {
          document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch {}
      }, 80);
    }
  }
  function cancelSettings() {
    try {
      const raw = settingsSnapshot();
      if (raw) {
        const s = JSON.parse(raw);
        if (s.settings) setDaemonSettings(s.settings);
        if (s.mcp) setMcpServers(s.mcp);
        if (s.skills) setSkills(s.skills);
      }
    } catch {}
    setShowConfigModal(false);
  }

  // Save Settings to Daemon (translate UI keys to the daemon's Go keys).
  function saveDaemonConfig() {
    if (!opts.isOpen() || !opts.isHostOnline()) { opts.toast("Reconnect the host before saving settings", "err"); return false; }
    const s = daemonSettings();
    opts.send({
      type: "update_config",
      requestId: "upd_" + Date.now(),
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

  // Add MCP Server
  const [newMcpName, setNewMcpName] = createSignal("");
  const [newMcpCmd, setNewMcpCmd] = createSignal("");
  const [newMcpArgs, setNewMcpArgs] = createSignal("");
  const [newMcpTransport, setNewMcpTransport] = createSignal("stdio");
  const [newMcpUrl, setNewMcpUrl] = createSignal("");

  function handleAddMcpServer() {
    const name = newMcpName().trim();
    const cmd = newMcpCmd().trim();
    if (!name || (!cmd && newMcpTransport() === "stdio")) {
      opts.toast("Name and command are required", "err");
      return;
    }
    const current = { ...mcpServers() };
    current[name] = {
      command: cmd,
      args: newMcpArgs().trim() ? newMcpArgs().trim().split(/\s+/) : [],
      transport: newMcpTransport(),
      url: newMcpUrl().trim(),
    };
    setMcpServers(current);
    setNewMcpName("");
    setNewMcpCmd("");
    setNewMcpArgs("");
    setNewMcpUrl("");
    opts.toast(`MCP Server '${name}' added`, "ok");
  }

  function handleDeleteMcpServer(name: string) {
    const current = { ...mcpServers() };
    delete current[name];
    setMcpServers(current);
    opts.toast(`MCP Server '${name}' removed`, "ok");
  }

  // Add Skill
  const [newSkillName, setNewSkillName] = createSignal("");
  const [newSkillDesc, setNewSkillDesc] = createSignal("");
  const [newSkillBody, setNewSkillBody] = createSignal("");

  function handleAddSkill() {
    const name = newSkillName().trim();
    if (!name || !newSkillBody().trim()) {
      opts.toast("Skill name and instruction prompt body are required", "err");
      return;
    }
    if (skills()[name]) { opts.toast("A skill with this name already exists. Choose a different name.", "err"); return; }
    const current = { ...skills() };
    current[name] = {
      name,
      description: newSkillDesc().trim(),
      body: newSkillBody().trim(),
      enabled: true,
    };
    setSkills(current);
    setNewSkillName("");
    setNewSkillDesc("");
    setNewSkillBody("");
    opts.toast(`Skill '${name}' created`, "ok");
  }

  function toggleSkill(name: string) {
    const current = { ...skills() };
    if (current[name]) {
      current[name] = { ...current[name], enabled: !current[name].enabled };
      setSkills(current);
    }
  }

  function handleDeleteSkill(name: string) {
    const current = { ...skills() };
    delete current[name];
    setSkills(current);
    opts.toast(`Skill '${name}' removed`, "ok");
  }

  return {
    showConfigModal, setShowConfigModal,
    daemonSettings, setDaemonSettings, mcpServers, setMcpServers, skills, setSkills,
    openSettings, cancelSettings, saveDaemonConfig,
    newMcpName, setNewMcpName, newMcpCmd, setNewMcpCmd, newMcpArgs, setNewMcpArgs,
    newMcpTransport, setNewMcpTransport, newMcpUrl, setNewMcpUrl,
    handleAddMcpServer, handleDeleteMcpServer,
    newSkillName, setNewSkillName, newSkillDesc, setNewSkillDesc, newSkillBody, setNewSkillBody,
    handleAddSkill, toggleSkill, handleDeleteSkill,
  };
}

export type Settings = ReturnType<typeof createSettings>;
