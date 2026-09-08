import { For, Show } from "solid-js";
import { Icon as Iconify } from "../../components/icon";

import { useModal } from "../ctx";

export function SettingsMcpSection() {
  const m = useModal();
  return (
<>
<div class="rounded-xl border border-line bg-elev/40 p-4 sm:p-5 space-y-4">
  <h3 id="sec-mcp" class="text-sm font-semibold text-ink-100 flex items-center gap-2 scroll-mt-2">
    <Iconify icon="lucide:cpu" size={15} class="text-ink-500" />
    <span>MCP Servers</span>
    <span class="px-1.5 py-0.2 rounded-full bg-ink-800 text-[10px] text-ink-400">{Object.keys(m.mcpServers()).length}</span>
  </h3>
  <div class="space-y-4 text-xs">
    <div class="border border-line rounded-xl p-3 bg-ink-900/50 space-y-2">
      <div class="font-semibold text-ink-200 text-xs">
        Add Model Context Protocol (MCP) Server
      </div>
      <div class="grid grid-cols-2 gap-2">
        <input
          type="text"
          placeholder="Server name (e.g. github)"
          class="bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100"
          value={m.newMcpName()}
          onInput={(e) => m.setNewMcpName(e.currentTarget.value)}
        />
        <input
          type="text"
          placeholder="Command (e.g. npx, uvx)"
          class="bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100"
          value={m.newMcpCmd()}
          onInput={(e) => m.setNewMcpCmd(e.currentTarget.value)}
        />
      </div>
      <div class="grid grid-cols-3 gap-1 bg-ink-950 p-1 rounded-lg border border-line/60">
        <For each={[["stdio", "stdio"], ["sse", "SSE"], ["http", "HTTP"]] as const}>
          {([v, label]) => (
            <button
              onClick={() => m.setNewMcpTransport(v)}
              class={`py-1 rounded-md text-center font-medium cursor-pointer ${
                m.newMcpTransport() === v
                  ? "bg-ink-100 text-ink-950"
                  : "text-ink-400 hover:text-ink-200"
              }`}
            >
              {label}
            </button>
          )}
        </For>
      </div>
      <Show when={m.newMcpTransport() !== "stdio"}>
        <input
          type="text"
          placeholder="Server URL"
          class="w-full bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100"
          value={m.newMcpUrl()}
          onInput={(e) => m.setNewMcpUrl(e.currentTarget.value)}
        />
      </Show>
      <input
        type="text"
        placeholder="Arguments (e.g. -y @modelcontextprotocol/server-filesystem /path)"
        class="w-full bg-ink-900 border border-line rounded-lg px-2.5 py-1.5 text-ink-100"
        value={m.newMcpArgs()}
        onInput={(e) => m.setNewMcpArgs(e.currentTarget.value)}
      />
      <div class="flex justify-end">
        <button
          onClick={m.handleAddMcpServer}
          class="px-4 py-1.5 rounded-lg bg-accent-500 text-accent-fg font-medium hover:bg-accent-600 cursor-pointer"
        >
          Add MCP Server
        </button>
      </div>
    </div>

    {/* Configured MCP Servers List */}
    <div class="space-y-2">
      <div class="font-semibold text-ink-300">
        Active MCP Servers ({Object.keys(m.mcpServers()).length})
      </div>
      <For
        each={Object.entries(m.mcpServers())}
        fallback={
          <div class="text-ink-600 py-4 text-center">
            No MCP servers configured yet.
          </div>
        }
      >
        {([name, srv]) => (
          <div class="p-3 rounded-xl border border-line bg-ink-900 flex items-center justify-between">
            <div>
              <div class="font-semibold text-ink-100 flex items-center gap-2">
                <span>{name}</span>
                <span class="px-1.5 py-0.2 rounded bg-ink-800 text-[10px] text-ink-400">
                  {srv.transport}
                </span>
              </div>
              <div class="text-[11px] font-mono text-ink-400 mt-0.5">
                {srv.command} {srv.args?.join(" ")}
              </div>
            </div>
            <button
              onClick={() => m.handleDeleteMcpServer(name)}
              class="p-1.5 text-rose-400 hover:bg-rose-500/10 rounded-lg"
            >
              <Iconify icon="lucide:trash-2" size={14} />
            </button>
          </div>
        )}
      </For>
    </div>
  </div>
</div>
</>
  );
}
