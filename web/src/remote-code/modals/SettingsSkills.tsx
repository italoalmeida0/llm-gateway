import { For } from "solid-js";
import { Icon as Iconify } from "../../components/icon";

import type { SettingsModalCtx } from "./SettingsModal";

export function SettingsSkillsSection(ctx: SettingsModalCtx) {
  return (
<>
<div class="rounded-xl border border-line bg-elev/40 p-4 sm:p-5 space-y-4">
  <h3 id="sec-skills" class="text-sm font-semibold text-ink-100 flex items-center gap-2 scroll-mt-2">
    <Iconify icon="lucide:puzzle" size={15} class="text-ink-500" />
    <span>Skills</span>
    <span class="px-1.5 py-0.2 rounded-full bg-ink-800 text-[10px] text-ink-400">{Object.keys(ctx.skills()).length}</span>
  </h3>
  <div class="space-y-4 text-xs">
    {/* Built-in Tools Summary */}
    <div class="p-3 rounded-xl bg-ink-900/60 border border-line/60">
      <div class="font-semibold text-ink-300 mb-1">
        Built-in Local Tools
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px] text-ink-400 font-mono">
        <div>• read (view files)</div>
        <div>• write (create files)</div>
        <div>• edit (modify files)</div>
        <div>• bash (shell runner)</div>
        <div>• glob (file search)</div>
        <div>• todo (task checklist)</div>
        <div>• question (ask user)</div>
      </div>
    </div>

    {/* Add Custom Skill */}
    <div class="border border-line rounded-xl p-3 bg-ink-900/50 space-y-2">
      <div class="font-semibold text-ink-200">
        Create Custom Skill / Prompt Instruction
      </div>
      <div class="grid grid-cols-2 gap-2">
        <input
          type="text"
          placeholder="Skill name (e.g. pr-reviewer)"
          class="bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100"
          value={ctx.newSkillName()}
          onInput={(e) => ctx.setNewSkillName(e.currentTarget.value)}
        />
        <input
          type="text"
          placeholder="Description"
          class="bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100"
          value={ctx.newSkillDesc()}
          onInput={(e) => ctx.setNewSkillDesc(e.currentTarget.value)}
        />
      </div>
      <textarea
        placeholder="Instructions body for the agent..."
        class="w-full bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100 h-20 resize-none"
        value={ctx.newSkillBody()}
        onInput={(e) => ctx.setNewSkillBody(e.currentTarget.value)}
      />
      <div class="flex justify-end">
        <button
          onClick={ctx.handleAddSkill}
          class="px-4 py-1.5 rounded-lg bg-brand-500 text-white font-medium hover:bg-brand-600"
        >
          Save Skill
        </button>
      </div>
    </div>

    {/* Custom Skills List */}
    <div class="space-y-2">
      <div class="font-semibold text-ink-300">
        Custom Skills ({Object.keys(ctx.skills()).length})
      </div>
      <For
        each={Object.entries(ctx.skills())}
        fallback={
          <div class="text-ink-600 py-4 text-center">
            No custom skills configured yet.
          </div>
        }
      >
        {([name, sk]) => (
          <div class="p-3 rounded-xl border border-line bg-ink-900 flex items-center justify-between">
            <div>
              <div class="font-semibold text-ink-100 flex items-center gap-2">
                <span>{name}</span>
                <span
                  class={`px-1.5 py-0.2 rounded text-[10px] ${
                    sk.enabled
                      ? "bg-emerald-500/20 text-emerald-400"
                      : "bg-ink-800 text-ink-500"
                  }`}
                >
                  {sk.enabled ? "Active" : "Disabled"}
                </span>
              </div>
              <div class="text-[11px] text-ink-400 mt-0.5">
                {sk.description}
              </div>
            </div>
            <div class="flex items-center gap-2">
              <button
                onClick={() => ctx.toggleSkill(name)}
                class="px-2.5 py-1 rounded-md bg-ink-800 hover:bg-ink-700 text-ink-300 text-[11px]"
              >
                {sk.enabled ? "Disable" : "Enable"}
              </button>
              <button
                onClick={() => ctx.handleDeleteSkill(name)}
                class="p-1.5 text-rose-400 hover:bg-rose-500/10 rounded-lg"
              >
                <Iconify icon="lucide:trash-2" size={14} />
              </button>
            </div>
          </div>
        )}
      </For>
    </div>
  </div>
</div>
</>
  );
}
