import { createSignal, Show } from "solid-js";
import { Modal } from "../../ui";
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
      title="Host & Agent Settings"
      subtitle="Appearance, chat preferences, Model Context Protocol servers, and custom skills on this host."
      width="max-w-2xl"
      onClose={m.cancelSettings}
      footerLeft={
        <div class="flex items-center gap-1.5 text-xs text-ink-400">
          <Iconify icon="lucide:hard-drive" size={13} />
          <span>Config stored on host daemon</span>
        </div>
      }
      footer={
        <>
          <button
            type="button"
            onClick={m.cancelSettings}
            class="border border-line bg-transparent hover:bg-elev text-ink-300 hover:text-ink-100 px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (m.saveDaemonConfig()) {
                m.setShowConfigModal(false);
                ui.toast("Settings sent to host", "ok");
              }
            }}
            class="bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded-lg text-xs font-medium shadow-sm transition-colors cursor-pointer"
          >
            Save changes
          </button>
        </>
      }
    >
      <div class="w-full space-y-5">
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
        <div class="flex items-center gap-1.5 p-1 rounded-xl bg-ink-950/70 border border-line overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab("general")}
            class={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer whitespace-nowrap ${
              activeTab() === "general"
                ? "bg-blue-600 text-white shadow-sm"
                : "text-ink-400 hover:text-ink-100 hover:bg-ink-900/50"
            }`}
          >
            <Iconify icon="lucide:sliders" size={13} />
            <span>General & Appearance</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("mcp")}
            class={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer whitespace-nowrap ${
              activeTab() === "mcp"
                ? "bg-blue-600 text-white shadow-sm"
                : "text-ink-400 hover:text-ink-100 hover:bg-ink-900/50"
            }`}
          >
            <Iconify icon="lucide:cpu" size={13} />
            <span>MCP Servers</span>
            <span
              class={`text-[10px] px-1.5 py-0.2 rounded-full ${
                activeTab() === "mcp"
                  ? "bg-white/20 text-white"
                  : "bg-ink-800 text-ink-400"
              }`}
            >
              {Object.keys(m.mcpServers()).length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("skills")}
            class={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer whitespace-nowrap ${
              activeTab() === "skills"
                ? "bg-blue-600 text-white shadow-sm"
                : "text-ink-400 hover:text-ink-100 hover:bg-ink-900/50"
            }`}
          >
            <Iconify icon="lucide:puzzle" size={13} />
            <span>Skills</span>
            <span
              class={`text-[10px] px-1.5 py-0.2 rounded-full ${
                activeTab() === "skills"
                  ? "bg-white/20 text-white"
                  : "bg-ink-800 text-ink-400"
              }`}
            >
              {Object.keys(m.skills()).length}
            </span>
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
