import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../../components/icon";
import type { RemoteCodeViewCtx } from "../../viewCtx";
import { FloatMenu } from "../FloatMenu";

export function ToolbarContext(ctx: RemoteCodeViewCtx) {
  return (
<>
{/* Add Context (+) — Antigravity-style */}
<div>
  <button
    ref={ctx.addBtn}
    data-menubtn
    onClick={(e) => {
      e.stopPropagation();
      ctx.setAddContextOpen(!ctx.addContextOpen());
      ctx.setModelMenuOpen(false);
    }}
    class="w-6 h-6 rounded-full hover:bg-ink-800 flex items-center justify-center cursor-pointer"
    data-rc-tip="Add context" aria-label="Add context"
  >
    <Iconify icon="lucide:plus" size={14} />
  </button>
  <FloatMenu anchor={() => ctx.addBtn} open={ctx.addContextOpen()} placement="top-start" width="12rem">
      <div class="px-2 py-1 text-[10px] uppercase font-bold text-ink-600 tracking-wider">
        Add context
      </div>
      <button
        onClick={() => {
          ctx.setAddContextOpen(false);
          document.querySelector<HTMLInputElement>("#rc-file-input")?.click();
        }}
        class="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-ink-300 hover:bg-ink-800/60 flex items-center gap-2 cursor-pointer"
      >
        <Iconify icon="lucide:paperclip" size={13} />
        <span>Attach files</span>
      </button>
      <button
        onClick={() => {
          ctx.setAddContextOpen(false);
          ctx.setInputPrompt((p) => p + "@");
          try {
            document.querySelector<HTMLTextAreaElement>("#rc-composer")?.focus();
          } catch {}
        }}
        class="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-ink-300 hover:bg-ink-800/60 flex items-center gap-2 cursor-pointer"
      >
        <Iconify icon="lucide:at-sign" size={13} />
        <span>Mentions</span>
      </button>
      <button
        onClick={() => {
          ctx.setAddContextOpen(false);
          ctx.setInputPrompt("/");
          try {
            document.querySelector<HTMLTextAreaElement>("#rc-composer")?.focus();
          } catch {}
        }}
        class="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-ink-300 hover:bg-ink-800/60 flex items-center gap-2 cursor-pointer"
      >
        <Iconify icon="lucide:slash" size={13} />
        <span>Actions</span>
      </button>
    </FloatMenu>
</div>
<div>
  <button ref={ctx.modeBtn} data-menubtn aria-label="Agent mode and skills" aria-expanded={ctx.modeMenuOpen()}
    onClick={() => { const next = !ctx.modeMenuOpen(); ctx.closeMenus(); ctx.setModeMenuOpen(next); }}
    class="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs hover:bg-elev cursor-pointer">
    <Iconify icon={ctx.agentMode() === "plan" ? "lucide:list-checks" : ctx.agentMode() === "learning" ? "lucide:graduation-cap" : ctx.agentMode() === "talk" ? "lucide:messages-square" : "lucide:hammer"} size={14} />
    <span class="capitalize">{ctx.agentMode()}</span><Show when={ctx.selectedSkills().length}><span class="text-ink-500">+{ctx.selectedSkills().length}</span></Show>
    <Iconify icon="lucide:chevron-down" size={11} />
  </button>
  <FloatMenu anchor={() => ctx.modeBtn} open={ctx.modeMenuOpen()} placement="top-start" width="20rem">
    <p class="px-2 py-1.5 font-medium text-ink-400">Mode</p>
    <For each={[{id:"build", label:"Build", description:"Implement and validate changes", icon:"lucide:hammer"}, {id:"plan", label:"Plan", description:"Explore and plan without editing files", icon:"lucide:list-checks"}, {id:"talk", label:"Talk", description:"Conversational agent with web research, no workspace access", icon:"lucide:messages-square"}, {id:"learning", label:"Learning", description:"Learn through hints and guiding questions", icon:"lucide:graduation-cap"}]}>{(mode) =>
      <button role="menuitemradio" aria-checked={ctx.agentMode() === mode.id} onClick={() => { ctx.setAgentMode(mode.id); ctx.configureSession(); }} class="w-full flex items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-elev cursor-pointer">
        <Iconify icon={mode.icon} size={16} /><span class="flex-1"><span class="font-medium text-ink-100">{mode.label}</span><span class="block text-[11px] text-ink-500 mt-0.5">{mode.description}</span></span><Show when={ctx.agentMode() === mode.id}><Iconify icon="lucide:check" size={14} /></Show>
      </button>
    }</For>
    <div class="mt-1 border-t border-line pt-2"><p class="px-2 pb-1 font-medium text-ink-400">Additional skills</p>
      <For each={Object.entries(ctx.skills()).filter(([,skill]) => skill.enabled)} fallback={<p class="p-2 text-ink-500">Create custom skills in Settings.</p>}>{([name, skill]) =>
        <button role="menuitemcheckbox" aria-checked={ctx.selectedSkills().includes(name)} onClick={() => { ctx.setSelectedSkills((prev) => prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]); ctx.configureSession(); }} class="w-full rounded-lg px-2 py-2 flex items-center gap-2 text-left hover:bg-elev cursor-pointer">
          <Iconify icon="lucide:puzzle" size={14} /><span class="flex-1"><span class="text-ink-200">{name}</span><span class="block text-[11px] text-ink-500">{skill.description}</span></span><Show when={ctx.selectedSkills().includes(name)}><Iconify icon="lucide:check" size={14} /></Show>
        </button>
      }</For>
    </div>
  </FloatMenu>
</div>
<div>
  <button ref={ctx.accessBtn} data-menubtn aria-label="Agent permissions" aria-expanded={ctx.accessMenuOpen()}
    onClick={() => { const next = !ctx.accessMenuOpen(); ctx.closeMenus(); ctx.setAccessMenuOpen(next); }}
    class={`flex items-center gap-1.5 rounded-full px-2 py-1 text-xs hover:bg-elev cursor-pointer transition-colors ${
      ctx.yoloMode() ? "text-amber-800 dark:text-amber-200" : ""
    }`}>
    <Iconify icon={ctx.yoloMode() ? "lucide:shield-alert" : "lucide:hand"} size={14} class={ctx.yoloMode() ? "text-amber-800 dark:text-amber-200" : ""} /><span class={`hidden sm:inline ${ctx.yoloMode() ? "text-amber-800 dark:text-amber-200" : ""}`}>{ctx.yoloMode() ? "Full access" : "Ask for approval"}</span>
  </button>
  <FloatMenu anchor={() => ctx.accessBtn} open={ctx.accessMenuOpen()} placement="top-start" width="22rem">
    <p class="px-2 py-2 text-ink-400">How should actions be approved?</p>
    <For each={[{full:false, label:"Ask for approval", description:"Ask before every tool call, including reads and commands.", icon:"lucide:hand"}, {full:true, label:"Full access", description:"Allow all tool calls without asking (YOLO).", icon:"lucide:shield-alert"}]}>{(access) =>
      <button role="menuitemradio" aria-checked={ctx.yoloMode() === access.full} onClick={() => { ctx.setYoloMode(access.full); ctx.configureSession(); ctx.setAccessMenuOpen(false); }} class="w-full flex items-center gap-3 px-2 py-3 text-left rounded-lg hover:bg-elev cursor-pointer">
        <Iconify icon={access.icon} size={19} class={access.full ? "text-amber-800 dark:text-amber-200" : ""} /><span class="flex-1"><span class={`font-medium ${access.full ? "text-amber-800 dark:text-amber-200" : "text-ink-100"}`}>{access.label}</span><span class={`block mt-1 text-[11px] ${access.full ? "text-amber-800/80 dark:text-amber-200/80" : "text-ink-500"}`}>{access.description}</span></span><Show when={ctx.yoloMode() === access.full}><Iconify icon="lucide:check" size={14} class={access.full ? "text-amber-800 dark:text-amber-200" : ""} /></Show>
      </button>
    }</For>
    <Show when={ctx.agentMode() !== "build"}>
      <div class="px-2 py-2">
        <p class="text-[11px] text-ink-500">{ctx.agentMode() === "plan" ? "Plan explores freely but never mutates. Edit, create and patch are disabled." : ctx.agentMode() === "talk" ? "Talk chats with web research. No workspace access at all." : "Learning observes read-only. Edit, create, patch and code execution are disabled."}</p>
        <div class="mt-1.5 flex flex-wrap gap-1">
          <For each={ctx.agentMode() === "plan"
            ? ["read", "search", "inspect", "bash", "glob", "question", "todo", "search_web", "fetch_url"]
            : ctx.agentMode() === "talk"
            ? ["question", "search_web", "fetch_url", "todo"]
            : ["read", "search", "inspect", "glob", "question", "todo", "search_web", "fetch_url"]}>
            {(cap) => <span class="rounded-md bg-ink-700/60 px-1.5 py-px font-mono text-[10px] text-ink-300">{cap}</span>}
          </For>
          <For each={ctx.agentMode() === "plan" ? ["write", "edit", "patch"] : ctx.agentMode() === "talk" ? ["read", "write", "edit", "patch", "search", "inspect", "bash", "python", "glob"] : ["write", "edit", "patch", "bash", "python"]}>
            {(cap) => <span class="rounded-md border border-line/60 px-1.5 py-px font-mono text-[10px] text-ink-600 line-through">{cap}</span>}
          </For>
        </div>
      </div>
    </Show>
  </FloatMenu>
</div>
</>
  );
}
