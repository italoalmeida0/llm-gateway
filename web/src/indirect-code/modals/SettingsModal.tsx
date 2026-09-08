import { Show } from "solid-js";
import { Modal, Btn } from "../../ui";
import { useModal, useUI } from "../ctx";

import { SettingsGeneralSection } from "./SettingsGeneral";
import { SettingsMcpSection } from "./SettingsMcp";
import { SettingsSkillsSection } from "./SettingsSkills";

export function SettingsModal() {
  const m = useModal();
  const ui = useUI();
  return (
<>
<Modal
  open={m.showConfigModal()}
  title="Settings"
  width="max-w-2xl"
  fullOnMobile
  onClose={m.cancelSettings}
  description="Appearance and agent preferences for this host."
  footer={<><Btn variant="ghost" onClick={m.cancelSettings}>Cancel</Btn><Btn onClick={() => {
    if (m.saveDaemonConfig()) { m.setShowConfigModal(false); ui.toast("Settings sent to host", "ok"); }
  }}>Save changes</Btn></>}
>
    <div class="w-full space-y-6">
      <Show when={ui.appNotice()}>{(notice) => <div role={notice().kind === "err" ? "alert" : "status"} class="rounded-xl border border-line bg-elev px-3 py-2.5 text-xs text-ink-300">{notice().message}</div>}</Show>
        <SettingsGeneralSection />
        <SettingsMcpSection />
        <SettingsSkillsSection />
  </div>
</Modal>
</>
  );
}
