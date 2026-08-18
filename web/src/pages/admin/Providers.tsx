import { createSignal, For, Show, createResource, createMemo } from "solid-js";

import { api, type AuthStyle, type ProviderDto, type ProviderKeyDto, type SyncMode, type SyncOutcome, type SyncPreview } from "../../api";
import { PageTitle } from "../../index";
import { usalItems } from "../../motion";
import { attachSortable } from "../../sortable";
import { Badge, Btn, Card, EmptyState, Icon, IconBtn, Icons, Input, Modal, Segmented, Select, toast, fmtDate, timeUntil } from "../../ui";
import { syncSummary } from "./Models";

/** Badge view of a provider key's failover state. */
function keyStatus(k: ProviderKeyDto): { tone: "green" | "zinc" | "amber" | "red"; label: string } {
  if (k.status === "disabled") return { tone: "zinc", label: "Disabled" };
  if (k.status === "exhausted") {
    return k.exhaustedReason === "billing"
      ? { tone: "amber", label: `Out of credits · retry in ${timeUntil(k.cooldownUntil)}` }
      : { tone: "red", label: "Rejected upstream (auth)" };
  }
  if (k.cooldownUntil && k.cooldownUntil > Date.now()) {
    return { tone: "amber", label: `Cooldown · retry in ${timeUntil(k.cooldownUntil)}` };
  }
  return { tone: "green", label: "Active" };
}

const AUTH_STYLE_OPTIONS = [
  { value: "bearer", label: "Bearer" },
  { value: "x-api-key", label: "x-api-key" },
] as Array<{ value: AuthStyle; label: string }>;

type Cap = "openai" | "anthropic";

interface SmokeResult {
  reachable: boolean;
  status?: number;
  latencyMs?: number;
  models?: string[];
  error?: string;
}

interface ProbeResult {
  reachable: boolean;
  status?: number;
  latencyMs?: number;
  model?: string;
  reply?: string;
  upstreamError?: string;
  error?: string;
}

export default function AdminProvidersPage() {
  const [providers, { refetch }] = createResource(async () => {
    const j = await api<{ providers: ProviderDto[] }>("GET", "/api/admin/providers");
    return j.providers;
  });

  const [editing, setEditing] = createSignal<ProviderDto | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal<ProviderDto | null>(null);
  const [busy, setBusy] = createSignal(false);

  // ---- import-mode dialog (shown after creating a dual-capability provider) ----
  const [importFor, setImportFor] = createSignal<{ id: string; name: string; preview: SyncPreview } | null>(null);
  const [importMode, setImportMode] = createSignal<SyncMode>("both");
  const [importBusy, setImportBusy] = createSignal(false);

  // ---- editor form ----
  const [name, setName] = createSignal("");
  const [openaiUrl, setOpenaiUrl] = createSignal("");
  const [openaiAuth, setOpenaiAuth] = createSignal<AuthStyle>("bearer");
  const [anthropicUrl, setAnthropicUrl] = createSignal("");
  const [anthropicAuth, setAnthropicAuth] = createSignal<AuthStyle>("x-api-key");
  const [apiKey, setApiKey] = createSignal("");
  const [priority, setPriority] = createSignal("100");
  const [enabled, setEnabled] = createSignal(true);

  // ---- test modal ----
  const [testFor, setTestFor] = createSignal<ProviderDto | null>(null);
  const [smoke, setSmoke] = createSignal<Partial<Record<Cap, SmokeResult>> | null>(null);
  const [smokeBusy, setSmokeBusy] = createSignal(false);
  const [probeCap, setProbeCap] = createSignal<Cap>("openai");
  const [modelSel, setModelSel] = createSignal(""); // dropdown value
  const [modelFree, setModelFree] = createSignal(""); // manual override
  const [probe, setProbe] = createSignal<ProbeResult | null>(null);
  const [probeBusy, setProbeBusy] = createSignal(false);
  let testRequest = 0;
  let probeRequest = 0;

  const openEditor = (p: ProviderDto | "new") => {
    if (p === "new") {
      setName(""); setOpenaiUrl(""); setOpenaiAuth("bearer"); setAnthropicUrl(""); setAnthropicAuth("x-api-key");
      setApiKey(""); setPriority("100"); setEnabled(true);
    } else {
      setName(p.name);
      setOpenaiUrl(p.openaiBaseUrl ?? "");
      setOpenaiAuth(p.openaiAuthStyle ?? "bearer");
      setAnthropicUrl(p.anthropicBaseUrl ?? "");
      setAnthropicAuth(p.anthropicAuthStyle ?? "x-api-key");
      setApiKey("");
      setPriority(String(p.priority));
      setEnabled(p.enabled);
    }
    setEditing(p);
  };

  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        name: name().trim(),
        openaiBaseUrl: openaiUrl().trim() || null,
        openaiAuthStyle: openaiAuth(),
        anthropicBaseUrl: anthropicUrl().trim() || null,
        anthropicAuthStyle: anthropicAuth(),
        priority: Number(priority()) || 100,
        enabled: enabled(),
      };
      if (apiKey().trim()) body.apiKey = apiKey().trim();

      if (editing() === "new") {
        const j = await api<{
          provider: ProviderDto;
          sync?: Partial<Record<string, SyncOutcome>>;
          preview?: SyncPreview;
        }>("POST", "/api/admin/providers", body);
        if (j.preview) {
          // Dual-capability: nothing imported yet — ask how below.
          setImportMode("both");
          setImportFor({ id: j.provider.id, name: j.provider.name, preview: j.preview });
          toast("Provider created — choose how to import its models");
        } else {
          const summary = syncSummary(j.sync);
          toast(summary ? `Provider created — models: ${summary}` : "Provider created");
        }
      } else {
        await api("PATCH", `/api/admin/providers/${(editing() as ProviderDto).id}`, body);
        toast("Provider updated");
      }
      setEditing(null);
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : "save failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const openTest = async (p: ProviderDto) => {
    const requestId = ++testRequest;
    probeRequest++;
    setTestFor(p);
    setSmoke(null);
    setProbe(null);
    setModelSel("");
    setModelFree("");
    setProbeCap(p.openaiBaseUrl ? "openai" : "anthropic");
    setProbe(null);
    setProbeBusy(false);
    setSmokeBusy(true);
    try {
      const j = await api<{ results: Partial<Record<Cap, SmokeResult>> }>(
        "POST",
        `/api/admin/providers/${p.id}/test`,
      );
      if (requestId === testRequest && testFor()?.id === p.id) {
        setSmoke(j.results);
      }
    } catch (e) {
      if (requestId === testRequest && testFor()?.id === p.id) {
        toast(e instanceof Error ? e.message : "test failed", "err");
      }
    } finally {
      if (requestId === testRequest) setSmokeBusy(false);
    }
  };

  const closeTest = () => {
    testRequest++;
    probeRequest++;
    setTestFor(null);
    setSmoke(null);
    setProbe(null);
    setSmokeBusy(false);
    setProbeBusy(false);
  };

  const listedModels = createMemo(() => smoke()?.[probeCap()]?.models ?? []);
  /** Manual text wins; otherwise the dropdown; otherwise the first listed model. */
  const effectiveModel = createMemo(
    () => modelFree().trim() || (listedModels().includes(modelSel()) ? modelSel() : (listedModels()[0] ?? "")),
  );

  const changeProbeCap = (value: string) => {
    probeRequest++;
    setProbeCap(value as Cap);
    setModelSel("");
    setModelFree("");
    setProbe(null);
  };

  const runProbe = async () => {
    const p = testFor();
    const cap = probeCap();
    const model = effectiveModel();
    if (!p || !model) return;
    const requestId = ++probeRequest;
    setProbeBusy(true);
    setProbe(null);
    try {
      const j = await api<{ results: Partial<Record<Cap, ProbeResult>> }>(
        "POST",
        `/api/admin/providers/${p.id}/test`,
        { cap, model },
      );
      if (requestId === probeRequest && testFor()?.id === p.id && probeCap() === cap) {
        setProbe(j.results[cap] ?? { reachable: false, error: "no result" });
      }
    } catch (e) {
      if (requestId === probeRequest && testFor()?.id === p.id) {
        setProbe({ reachable: false, error: e instanceof Error ? e.message : "probe failed" });
      }
    } finally {
      if (requestId === probeRequest) setProbeBusy(false);
    }
  };

  const [syncBusy, setSyncBusy] = createSignal<string | null>(null);
  const [deleteModels, setDeleteModels] = createSignal(false);

  // ---- upstream key management ----
  const [keyFor, setKeyFor] = createSignal<{ id: string; name: string } | null>(null);
  const [newKeyLabel, setNewKeyLabel] = createSignal("");
  const [newKeySecret, setNewKeySecret] = createSignal("");
  const [keyBusy, setKeyBusy] = createSignal(false);
  const [confirmDeleteKey, setConfirmDeleteKey] = createSignal<{ provider: ProviderDto; key: ProviderKeyDto } | null>(null);

  const addKey = async () => {
    const t = keyFor();
    if (!t || !newKeySecret().trim()) return;
    setKeyBusy(true);
    try {
      await api("POST", `/api/admin/providers/${t.id}/keys`, {
        label: newKeyLabel().trim(),
        apiKey: newKeySecret().trim(),
      });
      toast("Key added to the fallback chain");
      setKeyFor(null);
      setNewKeyLabel("");
      setNewKeySecret("");
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not add key", "err");
    } finally {
      setKeyBusy(false);
    }
  };

  const patchKey = async (provider: ProviderDto, k: ProviderKeyDto, body: Record<string, unknown>, okMsg: string) => {
    try {
      await api("PATCH", `/api/admin/providers/${provider.id}/keys/${k.id}`, body);
      toast(okMsg);
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : "update failed", "err");
      refetch();
    }
  };

  const deleteKey = async () => {
    const t = confirmDeleteKey();
    if (!t) return;
    setKeyBusy(true);
    try {
      await api("DELETE", `/api/admin/providers/${t.provider.id}/keys/${t.key.id}`);
      toast("Key removed from the chain");
      setConfirmDeleteKey(null);
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : "delete failed", "err");
    } finally {
      setKeyBusy(false);
    }
  };

  /** Drag-and-drop callbacks (SortableJS): the reordered ids ARE the new priority. */
  const reorderProviders = async (ids: string[]) => {
    try {
      await api("POST", "/api/admin/providers/reorder", { ids });
    } catch (e) {
      toast(e instanceof Error ? e.message : "reorder failed", "err");
    } finally {
      refetch();
    }
  };

  const reorderKeys = (providerId: string) => async (ids: string[]) => {
    try {
      await api("POST", `/api/admin/providers/${providerId}/keys/reorder`, { ids });
    } catch (e) {
      toast(e instanceof Error ? e.message : "reorder failed", "err");
    } finally {
      refetch();
    }
  };

  const runImport = async () => {
    const t = importFor();
    if (!t) return;
    setImportBusy(true);
    try {
      const j = await api<{ sync: Partial<Record<string, SyncOutcome>> }>(
        "POST",
        `/api/admin/providers/${t.id}/sync-models`,
        { mode: importMode() },
      );
      const summary = syncSummary(j.sync);
      toast(summary || "Model sync done");
      setImportFor(null);
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : "import failed", "err");
    } finally {
      setImportBusy(false);
    }
  };

  const syncModels = async (p: ProviderDto) => {
    setSyncBusy(p.id);
    try {
      const j = await api<{ sync: Partial<Record<string, SyncOutcome>> }>(
        "POST",
        `/api/admin/providers/${p.id}/sync-models`,
      );
      const summary = syncSummary(j.sync);
      toast(summary || "Model sync done");
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : "sync failed", "err");
    } finally {
      setSyncBusy(null);
    }
  };

  const remove = async () => {
    const p = confirmDelete();
    if (!p) return;
    setBusy(true);
    try {
      const j = await api<{ modelsOrphaned: number; modelsDeleted: number }>(
        "DELETE",
        `/api/admin/providers/${p.id}${deleteModels() ? "?deleteModels=true" : ""}`,
      );
      toast(
        j.modelsDeleted > 0
          ? `Provider + ${j.modelsDeleted} model${j.modelsDeleted === 1 ? "" : "s"} deleted`
          : j.modelsOrphaned > 0
            ? `Provider deleted — ${j.modelsOrphaned} model${j.modelsOrphaned === 1 ? "" : "s"} kept (now orphaned)`
            : "Provider deleted",
      );
      setConfirmDelete(null);
      setDeleteModels(false);
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : "delete failed", "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageTitle
        title="Providers"
        subtitle="Upstream LLM endpoints the gateway forwards to — drag to set fallback order (the real API keys live here only)"
        right={<Btn onClick={() => openEditor("new")}><Icon name={Icons.plus} /> New provider</Btn>}
      />

      <Show when={(providers() ?? []).length > 0} fallback={
        <Card><EmptyState icon={Icons.server} title="No providers configured"
          hint="Add your endpoint(s) — the gateway cannot serve requests until one is enabled." /></Card>
      }>
        <div
          class="grid gap-4"
          {...usalItems("fade-u", 80)}
          ref={(el) => attachSortable(el, { onReorder: reorderProviders })}
        >
          <For each={providers()}>
            {(p) => (
              <div data-id={p.id}>
                <Card interactive class="p-6">
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <div class="flex items-start gap-2 min-w-0">
                      <span data-handle title="Drag to reorder (fallback priority)" class="mt-0.5 text-ink-600 hover:text-ink-300 transition-colors">
                        <Icon name={Icons.grip} size={16} />
                      </span>
                      <div class="min-w-0">
                        <div class="flex items-center gap-2 flex-wrap">
                          <span class="font-semibold">{p.name}</span>
                          <Badge tone={p.enabled ? "green" : "zinc"}>{p.enabled ? "Enabled" : "Disabled"}</Badge>
                          {p.openaiBaseUrl && <Badge tone="blue">OpenAI</Badge>}
                          {p.anthropicBaseUrl && <Badge tone="amber">Anthropic</Badge>}
                          <span class="text-[11px] text-ink-500">priority {p.priority} · {p.modelCount} model{p.modelCount === 1 ? "" : "s"} · added {fmtDate(p.createdAt)}</span>
                        </div>
                        <div class="mt-2 space-y-1 text-xs text-ink-400">
                          <Show when={p.openaiBaseUrl}>
                            <div>
                              OpenAI: <code class="text-ink-300">{p.openaiBaseUrl}</code>
                              <span class="text-ink-600"> · key via {p.openaiAuthStyle === "x-api-key" ? "x-api-key" : "Bearer"}</span>
                            </div>
                          </Show>
                          <Show when={p.anthropicBaseUrl}>
                            <div>
                              Anthropic: <code class="text-ink-300">{p.anthropicBaseUrl}</code>
                              <span class="text-ink-600"> · key via {p.anthropicAuthStyle === "x-api-key" ? "x-api-key" : "Bearer"}</span>
                            </div>
                          </Show>
                        </div>
                      </div>
                    </div>
                    <div class="flex items-center gap-1 shrink-0">
                      <IconBtn icon={Icons.bolt} title="Test connection" onClick={() => openTest(p)} />
                      <IconBtn
                        icon={Icons.refresh}
                        title="Sync models from upstream /models"
                        disabled={syncBusy() === p.id}
                        onClick={() => syncModels(p)}
                      />
                      <IconBtn icon={Icons.edit} title="Edit" onClick={() => openEditor(p)} />
                      <IconBtn icon={Icons.trash} title="Delete provider" danger onClick={() => { setDeleteModels(false); setConfirmDelete(p); }} />
                    </div>
                  </div>

                  {/* upstream keys (fallback order) */}
                  <div class="mt-4 border-t border-line pt-3">
                    <div class="flex items-center justify-between mb-2">
                      <span class="text-[11px] font-medium uppercase tracking-wider text-ink-500">
                        Upstream keys · fallback order
                      </span>
                      <button
                        type="button"
                        class="flex items-center gap-1 text-[11px] font-medium text-ink-400 hover:text-ink-100 transition-colors cursor-pointer"
                        onClick={() => { setNewKeyLabel(""); setNewKeySecret(""); setKeyFor({ id: p.id, name: p.name }); }}
                      >
                        <Icon name={Icons.plus} size={12} /> Add key
                      </button>
                    </div>
                    <div
                      class="space-y-1.5"
                      ref={(el) => attachSortable(el, { onReorder: reorderKeys(p.id) })}
                    >
                      <For each={p.keys}>
                        {(k) => {
                          const st = () => keyStatus(k);
                          return (
                            <div data-id={k.id} class="flex items-center gap-2 rounded-xl border border-line bg-elev/40 px-2 py-1.5">
                              <span data-handle title="Drag to reorder" class="text-ink-600 hover:text-ink-300 transition-colors shrink-0">
                                <Icon name={Icons.grip} size={14} />
                              </span>
                              <Badge tone={st().tone}>{st().label}</Badge>
                              <span class="text-xs text-ink-200 font-medium truncate">{k.label || "key"}</span>
                              <span class="text-[10px] text-ink-600 truncate">
                                {st().tone === "green" ? "configured ✓" : `fails ${k.failCount}`}
                              </span>
                              <div class="ml-auto flex items-center gap-0.5 shrink-0">
                                <Show when={k.status !== "active" || (k.cooldownUntil !== null && k.cooldownUntil > Date.now())}>
                                  <IconBtn
                                    icon={Icons.refresh}
                                    title="Re-enable: clear exhaustion/cooldown and return to rotation"
                                    onClick={() => patchKey(p, k, { status: "active" }, "Key re-enabled")}
                                  />
                                </Show>
                                <Show when={k.status === "active"}>
                                  <IconBtn
                                    icon={Icons.ban}
                                    title="Disable this key (kept for later re-enable)"
                                    onClick={() => patchKey(p, k, { status: "disabled" }, "Key disabled")}
                                  />
                                </Show>
                                <Show when={k.status === "disabled"}>
                                  <IconBtn
                                    icon={Icons.check}
                                    title="Enable this key"
                                    onClick={() => patchKey(p, k, { status: "active" }, "Key enabled")}
                                  />
                                </Show>
                                <IconBtn
                                  icon={Icons.trash}
                                  title={p.keys.length <= 1 ? "A provider needs at least one upstream key" : "Remove key"}
                                  danger
                                  disabled={p.keys.length <= 1}
                                  onClick={() => setConfirmDeleteKey({ provider: p, key: k })}
                                />
                              </div>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </div>
                </Card>
              </div>
            )}
          </For>
        </div>
      </Show>

      {/* editor modal */}
      <Modal open={!!editing()} onClose={() => setEditing(null)} title={editing() === "new" ? "New provider" : `Edit ${name()}`} width="max-w-lg">
        <div class="space-y-4">
          <Input label="Name" value={name()} onInput={setName} placeholder="e.g. Provider" />
          <div>
            <Input label="OpenAI-compatible base URL" value={openaiUrl()} onInput={setOpenaiUrl}
              placeholder="https://provider.example.com/openai/v1" hint="Leave empty if the provider has no OpenAI surface" />
            <div class="mt-2 flex items-center justify-between gap-3">
              <span class="text-xs text-ink-500">Send the key as</span>
              <Segmented value={openaiAuth()} onChange={setOpenaiAuth} options={AUTH_STYLE_OPTIONS} />
            </div>
          </div>
          <div>
            <Input label="Anthropic-compatible base URL" value={anthropicUrl()} onInput={setAnthropicUrl}
              placeholder="https://provider.example.com/anthropic/v1" hint="Leave empty if it has no Anthropic surface" />
            <div class="mt-2 flex items-center justify-between gap-3">
              <span class="text-xs text-ink-500">Send the key as</span>
              <Segmented value={anthropicAuth()} onChange={setAnthropicAuth} options={AUTH_STYLE_OPTIONS} />
            </div>
          </div>
          <Show when={editing() === "new"}>
            <Input label="Upstream API key" type="password" value={apiKey()} onInput={setApiKey}
              placeholder="sk-…" autocomplete="off"
              hint="Becomes the primary key — add fallback keys on the provider card after creating" />
          </Show>
          <div class="grid grid-cols-2 gap-3 items-end">
            <Input label="Priority (lower = preferred)" type="number" min={0} max={10000} value={priority()} onInput={setPriority} />
            <label class="flex items-center gap-2 pb-2 cursor-pointer">
              <input type="checkbox" checked={enabled()} onChange={(e) => setEnabled(e.currentTarget.checked)}
                class="w-4 h-4 rounded border-line bg-elev accent-brand-500" />
              <span class="text-sm">Enabled</span>
            </label>
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <Btn variant="ghost" onClick={() => setEditing(null)}>Cancel</Btn>
            <Btn onClick={save} disabled={busy() || !name().trim() || (!openaiUrl().trim() && !anthropicUrl().trim())}>
              {busy() ? "Saving…" : "Save provider"}
            </Btn>
          </div>
        </div>
      </Modal>

      {/* test modal */}
      <Modal open={!!testFor()} onClose={closeTest} title={`Test ${testFor()?.name ?? ""}`} width="max-w-lg">
        <div class="space-y-5">
          <div>
            <div class="text-xs font-medium text-ink-300 mb-2">Endpoint smoke test</div>
            <Show when={!smokeBusy()} fallback={<div class="text-xs text-ink-500">Checking…</div>}>
              <Show when={smoke()} fallback={<div class="text-xs text-ink-500">No result</div>}>
                {(s) => (
                  <div class="flex flex-wrap gap-2">
                    <For each={Object.entries(s()) as Array<[Cap, SmokeResult]>}>
                      {([cap, r]) => (
                        <Badge tone={r.reachable && (r.status ?? 500) < 400 ? "green" : "red"}>
                          {cap}: {r.reachable
                            ? `HTTP ${r.status} · ${r.latencyMs}ms · ${r.models?.length ?? 0} models`
                            : `unreachable${r.error ? ` (${r.error})` : ""}`}
                        </Badge>
                      )}
                    </For>
                  </div>
                )}
              </Show>
            </Show>
          </div>

          <div class="border-t border-line pt-5">
            <div class="text-xs font-medium text-ink-300 mb-2">Chat probe (sends a real "Hello")</div>
            <div class="space-y-3">
              <Show when={testFor()?.openaiBaseUrl && testFor()?.anthropicBaseUrl}>
                <Segmented
                  value={probeCap()}
                  onChange={changeProbeCap}
                  options={[
                    { value: "openai", label: "OpenAI" },
                    { value: "anthropic", label: "Anthropic" },
                  ]}
                />
              </Show>
              <Show when={listedModels().length > 0}>
                <Select
                  label="Model from /models"
                  value={effectiveModel()}
                  onChange={setModelSel}
                  options={listedModels().map((m) => ({ value: m, label: m }))}
                />
              </Show>
              <Input
                label={listedModels().length > 0 ? "…or type a model id" : "Model id"}
                value={modelFree()}
                onInput={setModelFree}
                placeholder="e.g. gpt-4o-mini / fake-llm-1"
                hint={
                  listedModels().length > 0
                    ? "Typing here overrides the dropdown"
                    : "Model list was empty — enter the id manually"
                }
              />
              <div class="flex justify-end">
                <Btn onClick={runProbe} disabled={probeBusy() || !effectiveModel()}>
                  {probeBusy() ? "Sending…" : "Send Hello"}
                </Btn>
              </div>
              <Show when={probe()}>
                {(r) => (
                  <div
                    class={`rounded-lg border px-3 py-2.5 text-xs anim-fade-in ${
                      r().reachable && (r().status ?? 500) < 400
                        ? "border-emerald-500/30 bg-emerald-500/5"
                        : "border-rose-500/30 bg-rose-500/5"
                    }`}
                  >
                    <Show
                      when={r().reachable && (r().status ?? 500) < 400}
                      fallback={
                        <div class="text-rose-500">
                          {r().reachable
                            ? `HTTP ${r().status} — ${r().upstreamError ?? "upstream rejected the request"}`
                            : `Unreachable — ${r().error ?? "unknown error"}`}
                        </div>
                      }
                    >
                      <div class="text-emerald-500 font-medium">
                        OK · {r().latencyMs}ms · model {r().model}
                      </div>
                      <Show when={r().reply}>
                        <div class="text-ink-200 mt-1.5">“{r().reply}”</div>
                      </Show>
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          </div>
        </div>
      </Modal>

      {/* import-mode dialog (dual-capability provider just created) */}
      <Modal
        open={!!importFor()}
        onClose={() => setImportFor(null)}
        title={`Import models — ${importFor()?.name ?? ""}`}
        width="max-w-lg"
      >
        <div class="space-y-4">
          <p class="text-sm text-ink-300">
            This provider has both protocol surfaces. The upstream model lists:
          </p>
          <div class="flex flex-wrap gap-2">
            <For each={(["openai", "anthropic"] as Cap[]).filter((c) => !!importFor()?.preview[c])}>
              {(c) => {
                const r = () => importFor()!.preview[c]!;
                return (
                  <Badge tone={r().error ? "red" : "zinc"}>
                    {c}: {r().error ? `failed (${r().error})` : `${r().count} models`}
                  </Badge>
                );
              }}
            </For>
            <Show when={importFor()?.preview.common != null}>
              <Badge tone="indigo">{importFor()!.preview.common} listed by both</Badge>
            </Show>
          </div>
          <div>
            <span class="block text-xs font-medium text-ink-300 mb-1.5">Import as</span>
            <Segmented
              value={importMode()}
              onChange={(m) => setImportMode(m as SyncMode)}
              options={[
                { value: "both", label: "Both" },
                { value: "separate", label: "Separate" },
              ]}
            />
            <p class="text-[11px] text-ink-500 mt-1.5">
              {importMode() === "both"
                ? "One entry per model, served on the OpenAI and Anthropic endpoints."
                : "Each model keeps the protocol of the list it came from (duplicates go to OpenAI)."}
            </p>
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <Btn variant="ghost" onClick={() => setImportFor(null)}>Skip for now</Btn>
            <Btn onClick={runImport} disabled={importBusy()}>
              {importBusy() ? "Importing…" : "Import models"}
            </Btn>
          </div>
        </div>
      </Modal>

      {/* add-key modal */}
      <Modal open={!!keyFor()} onClose={() => setKeyFor(null)} title={`Add upstream key — ${keyFor()?.name ?? ""}`} width="max-w-md">
        <div class="space-y-4">
          <Input label="Label (optional)" value={newKeyLabel()} onInput={setNewKeyLabel} placeholder="e.g. backup account" />
          <Input label="API key" type="password" value={newKeySecret()} onInput={setNewKeySecret}
            placeholder="sk-…" autocomplete="off"
            hint="Appended to the end of the fallback chain — drag it up to prefer it. Never leaves this server." />
          <div class="flex justify-end gap-2 pt-2">
            <Btn variant="ghost" onClick={() => setKeyFor(null)}>Cancel</Btn>
            <Btn onClick={addKey} disabled={keyBusy() || !newKeySecret().trim()}>
              {keyBusy() ? "Adding…" : "Add key"}
            </Btn>
          </div>
        </div>
      </Modal>

      {/* delete-key confirm */}
      <Modal open={!!confirmDeleteKey()} onClose={() => setConfirmDeleteKey(null)} title="Remove upstream key">
        <div class="space-y-4">
          <p class="text-sm text-ink-300">
            Remove <strong class="text-ink-100">{confirmDeleteKey()?.key.label || "this key"}</strong> from{" "}
            <strong class="text-ink-100">{confirmDeleteKey()?.provider.name}</strong>'s fallback chain?
            Requests will skip it immediately.
          </p>
          <div class="flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setConfirmDeleteKey(null)}>Cancel</Btn>
            <Btn variant="danger" onClick={deleteKey} disabled={keyBusy()}>Remove</Btn>
          </div>
        </div>
      </Modal>

      {/* delete confirm */}
      <Modal open={!!confirmDelete()} onClose={() => setConfirmDelete(null)} title="Delete provider">
        <div class="space-y-4">
          <p class="text-sm text-ink-300">
            Delete <strong class="text-ink-100">{confirmDelete()?.name}</strong>? Requests for its capabilities
            will start failing until another enabled provider covers them.
          </p>
          <Show when={(confirmDelete()?.modelCount ?? 0) > 0}>
            <label class="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={deleteModels()}
                onChange={(e) => setDeleteModels(e.currentTarget.checked)}
                class="w-4 h-4 rounded border-line bg-elev accent-brand-500 mt-0.5"
              />
              <span class="text-xs text-ink-300">
                Also delete its {confirmDelete()?.modelCount} registered model
                {(confirmDelete()?.modelCount ?? 0) === 1 ? "" : "s"}.
                <span class="text-ink-500 block mt-0.5">
                  Unchecked: models are kept and become orphaned (badge "no provider") — you can
                  re-link them to another provider from the Models tab.
                </span>
              </span>
            </label>
          </Show>
          <div class="flex justify-end gap-2">
            <Btn variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Btn>
            <Btn variant="danger" onClick={remove} disabled={busy()}>Delete</Btn>
          </div>
        </div>
      </Modal>
    </div>
  );
}
