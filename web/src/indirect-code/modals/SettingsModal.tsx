import { createSignal, Show } from "solid-js";
import { Btn, Modal } from "../../ui";
import { Icon as Iconify } from "../../components/icon";
import { useModal, useUI } from "../ctx";

import { SettingsGeneralSection } from "./SettingsGeneral";
import { SettingsMcpSection } from "./SettingsMcp";
import { SettingsSkillsSection } from "./SettingsSkills";

export function SettingsModal() {
  const m = useModal();
  const ui = useUI();
  const [activeTab, setActiveTab] = createSignal<"general" | "mcp" | "skills">("general");

  return (
    <Modal
      open={m.showConfigModal()}
      title="Host & agent settings"
      subtitle="Customize your workspace and the agent on this host."
      width="max-w-2xl"
      onClose={m.cancelSettings}
      footer={
        <>
          <Btn
            variant="outline"
            size="sm"
            onClick={m.cancelSettings}
          >
            Cancel
          </Btn>
          <Btn
            size="sm"
            onClick={() => {
              if (m.saveDaemonConfig()) {
                m.setShowConfigModal(false);
                ui.toast("Settings sent to host", "ok");
              }
            }}
          >
            Save changes
          </Btn>
        </>
      }
    >
      <div class="w-full space-y-4">
        <Show when={ui.appNotice()}>
          {(notice) => (
            <div
              role={notice().kind === "err" ? "alert" : "status"}
              class="rounded-xl border border-line bg-ink-900/60 px-3.5 py-2.5 text-xs text-ink-300"
            >
              {notice().message}
            </div>
          )}
        </Show>

        {/* Tab switcher bar */}
        <div class="ui-segmented w-full overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab("general")}
            aria-pressed={activeTab() === "general"}
            class="ui-segment flex flex-1 items-center justify-center gap-1.5 px-2"
          >
            <Iconify icon="lucide:sliders" size={13} />
            <span>General</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("mcp")}
            aria-pressed={activeTab() === "mcp"}
            class="ui-segment flex flex-1 items-center justify-center gap-1.5 px-2"
          >
            <Iconify icon="lucide:cpu" size={13} />
            <span>MCP servers</span>
            <Show when={Object.keys(m.mcpServers()).length > 0}>
            <span
              class={`text-[10px] px-1.5 py-0.2 rounded-full ${
                activeTab() === "mcp"
                  ? "bg-ink-800 text-ink-200"
                  : "bg-ink-800 text-ink-400"
              }`}
            >
              {Object.keys(m.mcpServers()).length}
            </span>
            </Show>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("skills")}
            aria-pressed={activeTab() === "skills"}
            class="ui-segment flex flex-1 items-center justify-center gap-1.5 px-2"
          >
            <Iconify icon="lucide:puzzle" size={13} />
            <span>Skills</span>
            <Show when={Object.keys(m.skills()).length > 0}>
            <span
              class={`text-[10px] px-1.5 py-0.2 rounded-full ${
                activeTab() === "skills"
                  ? "bg-ink-800 text-ink-200"
                  : "bg-ink-800 text-ink-400"
              }`}
            >
              {Object.keys(m.skills()).length}
            </span>
            </Show>
          </button>
        </div>

        <Show when={activeTab() === "general"}>
          <SettingsGeneralSection />
        </Show>
        <Show when={activeTab() === "mcp"}>
          <SettingsMcpSection />
        </Show>
        <Show when={activeTab() === "skills"}>
          <SettingsSkillsSection />
        </Show>
      </div>
    </Modal>
  );
}
