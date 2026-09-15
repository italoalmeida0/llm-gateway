import { For } from "solid-js";
import { Icon as Iconify } from "../../components/icon";

import { useModal } from "../ctx";

export function SettingsSkillsSection() {
  const m = useModal();
  return (
    <>
      <div class="rounded-xl border border-line bg-elev/40 p-4 sm:p-5 space-y-4">
        <h3
          id="sec-skills"
          class="text-sm font-semibold text-ink-100 flex items-center gap-2 scroll-mt-2"
        >
          <Iconify icon="lucide:puzzle" size={15} class="text-ink-500" />
          <span>Skills</span>
          <span class="px-1.5 py-0.2 rounded-full bg-ink-800 text-[10px] text-ink-400">
            {Object.keys(m.skills()).length}
          </span>
        </h3>
        <div class="space-y-4 text-xs">
          <p class="text-ink-400">
            Save changes to store skills on this host, then select them in the
            session composer. Enabled skills apply only to sessions that select
            them, including Talk mode.
          </p>
          {/* Built-in Tools Summary */}
          <div class="p-3 rounded-xl bg-ink-900/60 border border-line/60">
            <div class="font-semibold text-ink-300 mb-1">
              Built-in Local Tools
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px] text-ink-400 font-mono">
              <div>• read (view files)</div>
              <div>• write (create files)</div>
              <div>• edit (modify files)</div>
              <div>• bash (shell runner, auto-background)</div>
              <div>• glob (file search)</div>
              <div>• todo (task checklist)</div>
              <div>• question (ask user)</div>
              <div>• python (python runner, auto-background)</div>
              <div>• sleep (bounded wait, wakes early)</div>
              <div>• bg_cancel (stop a background task)</div>
            </div>
          </div>

          {/* Add Custom Skill */}
          <div class="border border-line rounded-xl p-3 bg-ink-900/50 space-y-2">
            <div class="font-semibold text-ink-200">
              {m.editingSkill()
                ? "Edit skill instructions"
                : "Create skill instructions"}
            </div>
            <div class="grid grid-cols-2 gap-2">
              <input
                type="text"
                placeholder="Skill name (e.g. pr-reviewer)"
                class="bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100"
                aria-label="Skill name"
                disabled={!!m.editingSkill()}
                value={m.newSkillName()}
                onInput={(e) => m.setNewSkillName(e.currentTarget.value)}
              />
              <input
                type="text"
                placeholder="Description"
                class="bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100"
                aria-label="Skill description"
                value={m.newSkillDesc()}
                onInput={(e) => m.setNewSkillDesc(e.currentTarget.value)}
              />
            </div>
            <textarea
              placeholder="Instructions body for the agent..."
              class="w-full bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100 h-40 max-h-80 resize-y"
              aria-label="Skill instructions"
              value={m.newSkillBody()}
              onInput={(e) => m.setNewSkillBody(e.currentTarget.value)}
            />
            <div class="flex justify-end gap-2">
              <button class="px-3 text-ink-300" onClick={m.resetSkillEditor}>
                Cancel editor
              </button>
              <button
                onClick={m.handleAddSkill}
                class="px-4 py-1.5 rounded-lg bg-brand-500 text-white font-medium hover:bg-brand-600"
              >
                {m.editingSkill() ? "Apply skill edit" : "Add to changes"}
              </button>
            </div>
          </div>

          {/* Custom Skills List */}
          <div class="space-y-2">
            <div class="font-semibold text-ink-300">
              Custom Skills ({Object.keys(m.skills()).length})
            </div>
            <For
              each={Object.keys(m.skills()).sort()}
              fallback={
                <div class="text-ink-600 py-4 text-center">
                  No custom skills configured yet.
                </div>
              }
            >
              {(name) => (
                <div class="p-3 rounded-xl border border-line bg-ink-900 flex items-center justify-between">
                  <div>
                    <div class="font-semibold text-ink-100 flex items-center gap-2">
                      <span>{name}</span>
                      <span
                        class={`px-1.5 py-0.2 rounded text-[10px] ${
                          m.skills()[name].enabled
                            ? "bg-emerald-500/20 text-emerald-400"
                            : "bg-ink-800 text-ink-500"
                        }`}
                      >
                        {m.skills()[name].enabled ? "Enabled" : "Disabled"}
                      </span>
                    </div>
                    <div class="text-[11px] text-ink-400 mt-0.5">
                      {m.skills()[name].description}
                    </div>
                  </div>
                  <div class="flex items-center gap-2">
                    <button
                      class="px-2.5 py-1 text-ink-300"
                      onClick={() => m.editSkill(name)}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => m.toggleSkill(name)}
                      class="px-2.5 py-1 rounded-md bg-ink-800 hover:bg-ink-700 text-ink-300 text-[11px]"
                    >
                      {m.skills()[name].enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      aria-label={`Remove skill ${name}`}
                      onClick={() => m.handleDeleteSkill(name)}
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
