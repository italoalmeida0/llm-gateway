import { For, Show } from "solid-js";
import { useModal } from "../ctx";

const inputClass =
  "w-full rounded-lg border border-line bg-card px-3 py-2 text-ink-100";
const buttonClass =
  "rounded-lg border border-line px-3 py-1.5 text-ink-200 hover:bg-elev disabled:opacity-50";
export function SettingsMcpSection() {
  const m = useModal();
  return (
    <section id="sec-mcp" class="space-y-4 text-xs">
      <p class="text-ink-400">
        Enabled servers connect during Build turns when jail is off. Tool calls
        follow the session access policy. Test checks connection and tool
        discovery without invoking tools.
      </p>
      <div class="space-y-3 rounded-xl border border-line bg-elev/40 p-4">
        <h3 class="font-semibold text-ink-100">
          {m.editingMcp() ? "Edit MCP server" : "Add MCP server"}
        </h3>
        <label class="block space-y-1">
          <span>Server name</span>
          <input
            aria-label="Server name"
            class={inputClass}
            value={m.newMcpName()}
            disabled={!!m.editingMcp()}
            onInput={(e) => m.setNewMcpName(e.currentTarget.value)}
            placeholder="github"
          />
        </label>
        <div class="ui-segmented grid grid-cols-3">
          <For
            each={[
              ["stdio", "stdio"],
              ["http", "Streamable HTTP"],
              ["sse", "Legacy SSE"],
            ]}
          >
            {([value, label]) => (
              <button
                type="button"
                class="ui-segment"
                aria-pressed={m.newMcpTransport() === value}
                onClick={() => m.setNewMcpTransport(value)}
              >
                {label}
              </button>
            )}
          </For>
        </div>
        <Show
          when={m.newMcpTransport() === "stdio"}
          fallback={
            <label class="block space-y-1">
              <span>Server URL</span>
              <input
                aria-label="Server URL"
                class={inputClass}
                value={m.newMcpUrl()}
                onInput={(e) => m.setNewMcpUrl(e.currentTarget.value)}
                placeholder="https://example.com/mcp"
              />
            </label>
          }
        >
          <label class="block space-y-1">
            <span>Executable command</span>
            <input
              aria-label="Executable command"
              class={inputClass}
              value={m.newMcpCmd()}
              onInput={(e) => m.setNewMcpCmd(e.currentTarget.value)}
              placeholder="npx"
            />
          </label>
          <label class="block space-y-1">
            <span>Arguments (JSON array)</span>
            <textarea
              aria-label="Arguments"
              class={`${inputClass} max-h-40 font-mono`}
              rows={2}
              value={m.newMcpArgs()}
              onInput={(e) => m.setNewMcpArgs(e.currentTarget.value)}
              placeholder={'["-y", "package", "/path with spaces"]'}
            />
          </label>
        </Show>
        <details class="rounded-lg border border-line p-3">
          <summary class="cursor-pointer text-ink-300">
            Environment and authentication
          </summary>
          <p class="my-2 text-ink-500">
            Saved values stay on the host. Leave a field blank to keep them, use{" "}
            {"{}"} to clear them, or enter a JSON object to replace them.
          </p>
          <Show when={m.editingMcp()}>
            <p class="mb-2 break-all text-ink-400">
              Saved environment keys:{" "}
              {(m.mcpServers()[m.editingMcp()]?.envKeys || []).join(", ") ||
                "none"}
              . Saved header names:{" "}
              {(m.mcpServers()[m.editingMcp()]?.headerKeys || []).join(", ") ||
                "none"}
              .
            </p>
          </Show>
          <Show
            when={m.newMcpTransport() === "stdio"}
            fallback={
              <label class="block space-y-1">
                <span>HTTP headers (JSON object)</span>
                <textarea
                  aria-label="HTTP headers"
                  autocomplete="off"
                  spellcheck={false}
                  class={`${inputClass} max-h-40 font-mono`}
                  rows={3}
                  value={m.newMcpHeaders()}
                  onInput={(e) => m.setNewMcpHeaders(e.currentTarget.value)}
                  placeholder={'{"Authorization": "Bearer ..."}'}
                />
              </label>
            }
          >
            <label class="block space-y-1">
              <span>Environment variables (JSON object)</span>
              <textarea
                aria-label="Environment variables"
                autocomplete="off"
                spellcheck={false}
                class={`${inputClass} max-h-40 font-mono`}
                rows={3}
                value={m.newMcpEnv()}
                onInput={(e) => m.setNewMcpEnv(e.currentTarget.value)}
                placeholder={'{"API_TOKEN": "..."}'}
              />
            </label>
          </Show>
        </details>
        <div class="flex justify-end gap-2">
          <button class={buttonClass} onClick={m.resetMcpEditor}>
            Cancel editor
          </button>
          <button class={buttonClass} onClick={m.handleAddMcpServer}>
            {m.editingMcp() ? "Apply server edit" : "Add to changes"}
          </button>
        </div>
      </div>
      <p class="text-ink-500">
        Apply edits here, then use Save changes to persist them on the host.
      </p>
      <For
        each={Object.keys(m.mcpServers()).sort()}
        fallback={
          <p class="py-4 text-center text-ink-500">
            No MCP servers configured.
          </p>
        }
      >
        {(name) => {
          const server = () => m.mcpServers()[name];
          return (
            <div
              class="space-y-2 rounded-xl border border-line p-3"
              data-mcp-server={name}
            >
              <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="break-all font-semibold text-ink-100">{name}</span>
                <span class="text-ink-400">
                  {server().disabled ? "Disabled" : "Enabled"} ·{" "}
                  {server().transport || "stdio"}
                </span>
              </div>
              <div class="flex flex-wrap gap-2">
                <button
                  class={buttonClass}
                  onClick={() => m.editMcpServer(name)}
                >
                  Edit
                </button>
                <button class={buttonClass} onClick={() => m.toggleMcp(name)}>
                  {server().disabled ? "Enable" : "Disable"}
                </button>
                <button
                  class={buttonClass}
                  disabled={!!m.testingMcp()}
                  onClick={() => m.testMcpServer(name)}
                >
                  {m.testingMcp() === name ? "Testing…" : "Test connection"}
                </button>
                <button
                  class={buttonClass}
                  onClick={() => m.handleDeleteMcpServer(name)}
                >
                  Remove
                </button>
              </div>
              <Show when={m.mcpTest(name)}>
                {(test) => (
                  <p role="status" class="break-words text-ink-400">
                    {test().status === "tested"
                      ? `Test passed · ${test().toolCount ?? 0} tools. `
                      : "Test failed. "}
                    {test().message}
                  </p>
                )}
              </Show>
            </div>
          );
        }}
      </For>
    </section>
  );
}
