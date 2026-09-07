import { Show } from "solid-js";
import { Modal, Btn } from "../../ui";

export interface SettingsModalCtx {
  showConfigModal: () => boolean;
  setShowConfigModal: (v: boolean) => void;
  cancelSettings: () => void;
  saveDaemonConfig: () => boolean;
  toast: (msg: string, kind?: string) => void;
  appNotice: () => { kind: string; message: string } | null;
  convWidth: () => string;
  setConvWidth: (v: string) => void;
  daemonSettings: () => Record<string, any>;
  setDaemonSettings: (v: Record<string, any> | ((p: Record<string, any>) => Record<string, any>)) => void;
  verboseChat: () => boolean;
  setVerboseChat: (v: boolean) => void;
  mcpServers: () => Record<string, { command?: string; args?: string[]; url?: string; transport?: string }>;
  newMcpName: () => string; setNewMcpName: (v: string) => void;
  newMcpCmd: () => string; setNewMcpCmd: (v: string) => void;
  newMcpArgs: () => string; setNewMcpArgs: (v: string) => void;
  newMcpUrl: () => string; setNewMcpUrl: (v: string) => void;
  newMcpTransport: () => string; setNewMcpTransport: (v: string) => void;
  handleAddMcpServer: () => void;
  handleDeleteMcpServer: (name: string) => void;
  newSkillName: () => string; setNewSkillName: (v: string) => void;
  newSkillDesc: () => string; setNewSkillDesc: (v: string) => void;
  newSkillBody: () => string; setNewSkillBody: (v: string) => void;
  handleAddSkill: () => void;
  handleDeleteSkill: (name: string) => void;
  toggleSkill: (name: string) => void;
  skills: () => Array<{ name: string; description: string; enabled: boolean }>;
}

import { SettingsGeneralSection } from "./SettingsGeneral";
import { SettingsMcpSection } from "./SettingsMcp";
import { SettingsSkillsSection } from "./SettingsSkills";

export function SettingsModal(ctx: SettingsModalCtx) {
  return (
<>
<Modal
  open={ctx.showConfigModal()}
  title="Settings"
  width="max-w-2xl"
  fullOnMobile
  onClose={ctx.cancelSettings}
  description="Appearance and agent preferences for this host."
  footer={<><Btn variant="ghost" onClick={ctx.cancelSettings}>Cancel</Btn><Btn onClick={() => {
    if (ctx.saveDaemonConfig()) { ctx.setShowConfigModal(false); ctx.toast("Settings sent to host", "ok"); }
  }}>Save changes</Btn></>}
>
    <div class="w-full space-y-6">
      <Show when={ctx.appNotice()}>{(notice) => <div role={notice().kind === "err" ? "alert" : "status"} class="rounded-xl border border-line bg-elev px-3 py-2.5 text-xs text-ink-300">{notice().message}</div>}</Show>
        <SettingsGeneralSection {...ctx} />
        <SettingsMcpSection {...ctx} />
        <SettingsSkillsSection {...ctx} />
  </div>
</Modal>
</>
  );
}
