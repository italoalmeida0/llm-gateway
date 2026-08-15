import { createSignal, For, Show, createResource, createMemo } from "solid-js";

import { api, type ModelDto, type ProviderDto, type RoutingMode, type SyncOutcome } from "../../api";
import { PageTitle } from "../../index";
import { usalItems } from "../../motion";
import { Badge, Btn, Card, EmptyState, Icon, IconBtn, Icons, Input, Modal, Segmented, Select, toast, fmtNum } from "../../ui";

const ROUTING_OPTIONS = [
  { value: "passthrough", label: "Pass-through" },
  { value: "router", label: "Router" },
] as Array<{ value: RoutingMode; label: string }>;

const PROTO_OPTIONS = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
] as Array<{ value: "openai" | "anthropic"; label: string }>;

const PRICING_KEYS = ["prompt", "completion", "image", "request", "input_cache_reads", "input_cache_writes"];

const csv = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const numOrNull = (s: string): number | null => {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
};

/** Human one-liner for a per-capability sync outcome map. */
export function syncSummary(sync?: Partial<Record<string, SyncOutcome>>): string {
  if (!sync) return "";
  const parts: string[] = [];
  for (const [cap, r] of Object.entries(sync)) {
    if (!r) continue;
    parts.push(r.error ? `${cap}: sync failed (${r.error})` : `${cap}: ${r.added} added, ${r.skipped} skipped`);
  }
  return parts.join(" · ");
}

export default function AdminModelsPage() {
  const [models, { refetch }] = createResource(async () => {
    const j = await api<{ models: ModelDto[] }>("GET", "/api/admin/models");
    return j.models;
  });
  const [providers] = createResource(async () => {
    const j = await api<{ providers: ProviderDto[] }>("GET", "/api/admin/providers");
    return j.providers;
  });

  const [routingMode, setRoutingMode] = createSignal<RoutingMode>("passthrough");
  createResource(async () => {
    const j = await api<{ settings: { routingMode: RoutingMode } }>("GET", "/api/admin/settings");
    setRoutingMode(j.settings.routingMode);
    return true;
  });

  const [busy, setBusy] = createSignal(false);
  const [editing, setEditing] = createSignal<ModelDto | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = createSignal<ModelDto | null>(null);
  const [confirmBulk, setConfirmBulk] = createSignal(false);
  const [selected, setSelected] = createSignal<Set<string>>(new Set());
  const [showAdvanced, setShowAdvanced] = createSignal(false);

  // ---- editor form ----
  const [fId, setFId] = createSignal("");
  const [fProvider, setFProvider] = createSignal("");
  const [fUpstream, setFUpstream] = createSignal("");
  const [fProto, setFProto] = createSignal<"openai" | "anthropic">("openai");
  const [fEnabled, setFEnabled] = createSignal(true);
  const [fAlwaysOn, setFAlwaysOn] = createSignal(true);
  const [fName, setFName] = createSignal("");
  const [fDesc, setFDesc] = createSignal("");
  const [fHf, setFHf] = createSignal("");
  const [fQuant, setFQuant] = createSignal("");
  const [fSlug, setFSlug] = createSignal("");
  const [fContext, setFContext] = createSignal("");
  const [fMaxOut, setFMaxOut] = createSignal("");
  const [fCreated, setFCreated] = createSignal("");
  const [fInMod, setFInMod] = createSignal("");
  const [fOutMod, setFOutMod] = createSignal("");
  const [fSampling, setFSampling] = createSignal("");
  const [fFeatures, setFFeatures] = createSignal("");
  const [fEfforts, setFEfforts] = createSignal("");
  const [fDatacenters, setFDatacenters] = createSignal("");
  const [fPricing, setFPricing] = createSignal<Record<string, string>>({});

  const providerOptions = createMemo(() =>
    (providers() ?? []).map((p) => ({ value: p.id, label: p.name })),
  );

  const changeRouting = async (mode: string) => {
    const m = mode as RoutingMode;
    if (m === routingMode()) return;
    try {
      await api("PATCH", "/api/admin/settings", { routingMode: m });
      setRoutingMode(m);
      toast(
        m === "router"
          ? "Router mode on — requests route through the model registry"
          : "Pass-through mode on — model names forward untouched",
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : "could not update settings", "err");
    }
  };

  const openEditor = (m: ModelDto | "new") => {
    if (m === "new") {
      setFId(""); setFProvider(providers()?.[0]?.id ?? ""); setFUpstream(""); setFProto("openai");
      setFEnabled(true); setFAlwaysOn(true);
      setFName(""); setFDesc(""); setFHf(""); setFQuant(""); setFSlug("");
      setFContext(""); setFMaxOut(""); setFCreated("");
      setFInMod("text"); setFOutMod("text"); setFSampling(""); setFFeatures(""); setFEfforts("");
      setFDatacenters(""); setFPricing({});
    } else {
      setFId(m.id); setFProvider(m.providerId ?? ""); setFUpstream(m.upstreamModel); setFProto(m.proto);
      setFEnabled(m.enabled); setFAlwaysOn(m.alwaysOn);
      setFName(m.name); setFDesc(m.description); setFHf(m.huggingFaceId); setFQuant(m.quantization);
      setFSlug(m.openrouterSlug);
      setFContext(m.contextLength == null ? "" : String(m.contextLength));
      setFMaxOut(m.maxOutputLength == null ? "" : String(m.maxOutputLength));
      setFCreated(m.created == null ? "" : String(m.created));
      setFInMod(m.inputModalities.join(", ")); setFOutMod(m.outputModalities.join(", "));
      setFSampling(m.samplingParams.join(", ")); setFFeatures(m.features.join(", "));
      setFEfforts((m.reasoningEfforts ?? []).join(", "));
      setFDatacenters((m.datacenters ?? []).map((d) => d.country_code).join(", "));
      setFPricing({ ...(m.pricing ?? {}) });
    }
    setShowAdvanced(false);
    setEditing(m);
  };

  const save = async () => {
    setBusy(true);
    try {
      const pricing: Record<string, string> = {};
      for (const k of PRICING_KEYS) {
        const pv = (fPricing()[k] ?? "").trim();
        if (pv) pricing[k] = pv;
      }
      const body: Record<string, unknown> = {
        proto: fProto(),
        enabled: fEnabled(),
        alwaysOn: fAlwaysOn(),
        name: fName().trim(),
        description: fDesc(),
        huggingFaceId: fHf().trim(),
        quantization: fQuant().trim(),
        openrouterSlug: fSlug().trim(),
        contextLength: numOrNull(fContext()),
        maxOutputLength: numOrNull(fMaxOut()),
        created: numOrNull(fCreated()),
        inputModalities: csv(fInMod()),
        outputModalities: csv(fOutMod()),
        samplingParams: csv(fSampling()),
        features: csv(fFeatures()),
        reasoningEfforts: csv(fEfforts()),
        datacenters: csv(fDatacenters()).map((cc) => ({ country_code: cc })),
        pricing: Object.keys(pricing).length ? pricing : null,
      };
      if (fProvider()) body.providerId = fProvider();
      if (fUpstream().trim()) body.upstreamModel = fUpstream().trim();
      if (editing() === "new") {
        body.id = fId().trim();
        await api("POST", "/api/admin/models", body);
        toast("Model registered");
      } else {
        const m = editing() as ModelDto;
        await api("PATCH", `/api/admin/models/${encodeURIComponent(m.id)}`, body);
        toast("Model updated");
      }
      setEditing(null);
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : "save failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (m: ModelDto) => {
    try {
      await api("PATCH", `/api/admin/models/${encodeURIComponent(m.id)}`, { enabled: !m.enabled });
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : "update failed", "err");
    }
  };

  const remove = async () => {
    const m = confirmDelete();
    if (!m) return;
    setBusy(true);
    try {
      await api("DELETE", `/api/admin/models/${encodeURIComponent(m.id)}`);
      toast("Model deleted");
      setConfirmDelete(null);
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : "delete failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const bulkRemove = async () => {
    setBusy(true);
    try {
      const j = await api<{ deleted: number }>("POST", "/api/admin/models/bulk-delete", {
        ids: [...selected()],
      });
      toast(`Deleted ${j.deleted} model${j.deleted === 1 ? "" : "s"}`);
      setConfirmBulk(false);
      setSelected(new Set<string>());
      refetch();
    } catch (e) {
      toast(e instanceof Error ? e.message : "bulk delete failed", "err");
    } finally {
      setBusy(false);
    }
  };

  const allSelected = createMemo(() => {
    const list = models() ?? [];
    return list.length > 0 && list.every((m) => selected().has(m.id));
  });
  const toggleAll = (on: boolean) =>
    setSelected(on ? new Set((models() ?? []).map((m) => m.id)) : new Set<string>());


  return (
    <div>
      <PageTitle
        title="Models"
        subtitle="The public model ids this gateway serves, mapped to each provider's upstream ids"
        right={
          <div class="flex items-center gap-3 flex-wrap">
            <div class="flex items-center gap-2">
              <span class="text-xs text-ink-500">Routing</span>
              <Segmented value={routingMode()} onChange={changeRouting} options={ROUTING_OPTIONS} />
            </div>
            <Btn onClick={() => openEditor("new")} disabled={(providers() ?? []).length === 0}>
              <Icon name={Icons.plus} /> New model
            </Btn>
          </div>
        }
      />

      <Show when={routingMode() === "router"}>
        <Card class="p-4 mb-4 border-amber-500/30">
          <div class="flex items-start gap-2 text-xs text-ink-300">
            <Icon name={Icons.warning} size={16} class="text-amber-500 mt-0.5" />
            <span>
              Router mode is strict: requests for models missing from this registry fail with 404,
              and the upstream receives the registered <em>upstream model</em> id. Switch back to
              pass-through to forward model names untouched.
            </span>
          </div>
        </Card>
      </Show>

      <Show when={selected().size > 0}>
        <Card class="p-3 mb-4 flex items-center justify-between">
          <span class="text-xs text-ink-300">{selected().size} selected</span>
          <div class="flex gap-2">
            <Btn variant="ghost" size="sm" onClick={() => setSelected(new Set<string>())}>Clear</Btn>
            <Btn variant="danger" size="sm" onClick={() => setConfirmBulk(true)}>
              <Icon name={Icons.trash} /> Delete selected
            </Btn>
          </div>
        </Card>
      </Show>

      <Show
        when={(models() ?? []).length > 0}
        fallback={
          <Card>
            <EmptyState
              icon={Icons.layers}
              title="No models registered"
              hint="Creating a provider auto-imports its /models list — or add a model manually."
            />
          </Card>
        }
      >
        <Card class="overflow-hidden" {...usalItems("fade-u", 60)}>
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="text-left text-[10px] uppercase tracking-wider text-ink-500 border-b border-line">
                  <th class="font-medium px-4 py-3 w-8">
                    <input
                      type="checkbox"
                      checked={allSelected()}
                      onChange={(e) => toggleAll(e.currentTarget.checked)}
                      class="w-4 h-4 rounded border-line bg-elev accent-brand-500 cursor-pointer"
                    />
                  </th>
                  <th class="font-medium px-3 py-3">Model</th>
                  <th class="font-medium px-3 py-3">Provider</th>
                  <th class="font-medium px-3 py-3">Upstream model</th>
                  <th class="font-medium px-3 py-3">Protocol</th>
                  <th class="font-medium px-3 py-3 text-right">Context</th>
                  <th class="font-medium px-3 py-3">Pricing</th>
                  <th class="font-medium px-3 py-3">Source</th>
                  <th class="font-medium px-3 py-3">Enabled</th>
                  <th class="font-medium px-3 py-3 text-right"></th>
                </tr>
              </thead>

              <tbody class="divide-y divide-line">
                <For each={models()}>
                  {(m) => (
                    <tr class="transition-colors hover:bg-ink-800/30">
                      <td class="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selected().has(m.id)}
                          onChange={(e) => {
                            const s = new Set(selected());
                            if (e.currentTarget.checked) s.add(m.id);
                            else s.delete(m.id);
                            setSelected(s);
                          }}
                          class="w-4 h-4 rounded border-line bg-elev accent-brand-500 cursor-pointer"
                        />
                      </td>
                      <td class="px-3 py-3 max-w-[280px]">
                        <div class="text-sm text-ink-100 font-medium truncate">{m.id}</div>
                        <Show when={m.name && m.name !== m.id}>
                          <div class="text-ink-500 truncate">{m.name}</div>
                        </Show>
                      </td>
                      <td class="px-3 py-3 text-ink-300 whitespace-nowrap">
                        <Show when={m.providerName} fallback={<Badge tone="amber">no provider</Badge>}>
                          {m.providerName}
                        </Show>
                      </td>
                      <td class="px-3 py-3 max-w-[220px]">
                        <code class="text-ink-400 truncate block">
                          {m.upstreamModel === m.id ? "—" : m.upstreamModel}
                        </code>
                      </td>
                      <td class="px-3 py-3">
                        <Badge tone={m.proto === "openai" ? "zinc" : "blue"}>{m.proto}</Badge>
                      </td>
                      <td class="px-3 py-3 text-right text-ink-300 whitespace-nowrap">
                        {m.contextLength != null ? fmtNum(m.contextLength) : "—"}
                      </td>
                      <td class="px-3 py-3 text-ink-400 whitespace-nowrap">
                        <Show when={m.pricing} fallback="—">
                          {(p) => (
                            <code title={JSON.stringify(p())}>
                              in {p().prompt ?? "—"} · out {p().completion ?? "—"}
                            </code>
                          )}
                        </Show>
                      </td>
                      <td class="px-3 py-3">
                        <Badge tone={m.source === "manual" ? "indigo" : "zinc"}>{m.source}</Badge>
                      </td>
                      <td class="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={m.enabled}
                          onChange={() => toggleEnabled(m)}
                          title={m.enabled ? "Disable model" : "Enable model"}
                          class="w-4 h-4 rounded border-line bg-elev accent-brand-500 cursor-pointer"
                        />
                      </td>
                      <td class="px-3 py-3">
                        <div class="flex justify-end gap-1">
                          <IconBtn icon={Icons.edit} title="Edit model" onClick={() => openEditor(m)} />
                          <IconBtn icon={Icons.trash} title="Delete model" danger onClick={() => setConfirmDelete(m)} />
                        </div>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Card>
      </Show>


      {/* editor modal */}
      <Modal
        open={!!editing()}
        onClose={() => setEditing(null)}
        title={editing() === "new" ? "Register model" : `Edit ${fId()}`}
        width="max-w-2xl"
      >
        <div class="space-y-4">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Public model id"
              value={fId()}
              onInput={setFId}
              placeholder="hf:zai-org/GLM-5.2"
              disabled={editing() !== "new"}
              hint={editing() === "new" ? "What clients send as `model`" : "Ids are immutable"}
            />
            <Select label="Provider" value={fProvider()} onChange={setFProvider} options={providerOptions()} />
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Input
              label="Upstream model id"
              value={fUpstream()}
              onInput={setFUpstream}
              placeholder={fId() || "defaults to the public id"}
              hint="What the provider actually receives"
            />
            <div>
              <span class="block text-xs font-medium text-ink-300 mb-1.5">Protocol</span>
              <Segmented value={fProto()} onChange={(p) => setFProto(p as "openai" | "anthropic")} options={PROTO_OPTIONS} />
            </div>
          </div>
          <div class="flex items-center gap-6">
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={fEnabled()} onChange={(e) => setFEnabled(e.currentTarget.checked)}
                class="w-4 h-4 rounded border-line bg-elev accent-brand-500" />
              <span class="text-sm">Enabled</span>
            </label>
            <label class="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={fAlwaysOn()} onChange={(e) => setFAlwaysOn(e.currentTarget.checked)}
                class="w-4 h-4 rounded border-line bg-elev accent-brand-500" />
              <span class="text-sm">Always on</span>
            </label>
          </div>

          <div class="border-t border-line pt-3">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced())}
              class="flex items-center gap-1.5 text-xs font-medium text-ink-400 hover:text-ink-200 transition-colors cursor-pointer"
            >
              <Icon
                name={Icons.chevronDown}
                size={14}
                class={`transition-transform duration-200 ${showAdvanced() ? "rotate-180" : ""}`}
              />
              Advanced metadata (shown in /v1/models)
            </button>
            <Show when={showAdvanced()}>
              <div class="mt-3 space-y-3">
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input label="Display name" value={fName()} onInput={setFName} placeholder="defaults to id" />
                  <Input label="Hugging Face id" value={fHf()} onInput={setFHf} placeholder="zai-org/GLM-5.2" />
                </div>
                <Input label="Description" value={fDesc()} onInput={setFDesc} />
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input label="Quantization" value={fQuant()} onInput={setFQuant} placeholder="fp8" />
                  <Input label="OpenRouter slug" value={fSlug()} onInput={setFSlug} placeholder="z-ai/glm-5" />
                </div>
                <div class="grid grid-cols-3 gap-3">
                  <Input label="Context length" type="number" value={fContext()} onInput={setFContext} />
                  <Input label="Max output" type="number" value={fMaxOut()} onInput={setFMaxOut} />
                  <Input label="Created (unix s)" type="number" value={fCreated()} onInput={setFCreated} />
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input label="Input modalities (csv)" value={fInMod()} onInput={setFInMod} placeholder="text, image" />
                  <Input label="Output modalities (csv)" value={fOutMod()} onInput={setFOutMod} placeholder="text" />
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input label="Sampling params (csv)" value={fSampling()} onInput={setFSampling} placeholder="temperature, top_p" />
                  <Input label="Features (csv)" value={fFeatures()} onInput={setFFeatures} placeholder="tools, reasoning" />
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Input label="Reasoning efforts (csv)" value={fEfforts()} onInput={setFEfforts} placeholder="low, medium, high" />
                  <Input label="Datacenters (csv country codes)" value={fDatacenters()} onInput={setFDatacenters} placeholder="US, IS" />
                </div>
                <div>
                  <div class="text-xs font-medium text-ink-300 mb-1.5">Pricing (per token, USD strings)</div>
                  <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <For each={PRICING_KEYS}>
                      {(k) => (
                        <Input
                          label={k}
                          value={fPricing()[k] ?? ""}
                          onInput={(pv) => setFPricing((prev) => ({ ...prev, [k]: pv }))}
                          placeholder="0.00000475"
                        />
                      )}
                    </For>
                  </div>
                </div>
              </div>
            </Show>
          </div>

          <div class="flex justify-end gap-2 pt-2">
            <Btn variant="ghost" onClick={() => setEditing(null)}>Cancel</Btn>
            <Btn onClick={save} disabled={busy() || !fProvider() || (editing() === "new" && !fId().trim())}>
              {busy() ? "Saving…" : "Save model"}
            </Btn>
          </div>
        </div>
      </Modal>


      {/* delete confirm (single) */}
      <Modal open={!!confirmDelete()} onClose={() => setConfirmDelete(null)} title="Delete model">
        <p class="text-sm text-ink-300">
          Delete <span class="font-semibold text-ink-100">{confirmDelete()?.id}</span>? Router-mode
          requests for it will start failing with 404. Usage history keeps its rows.
        </p>
        <div class="flex justify-end gap-2 mt-5">
          <Btn variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Btn>
          <Btn variant="danger" onClick={remove} disabled={busy()}>
            {busy() ? "Deleting…" : "Delete"}
          </Btn>
        </div>
      </Modal>

      {/* delete confirm (bulk) */}
      <Modal open={confirmBulk()} onClose={() => setConfirmBulk(false)} title="Delete selected models">
        <p class="text-sm text-ink-300">
          Delete <span class="font-semibold text-ink-100">{selected().size}</span> selected model
          {selected().size === 1 ? "" : "s"}? Usage history keeps its rows.
        </p>
        <div class="flex justify-end gap-2 mt-5">
          <Btn variant="ghost" onClick={() => setConfirmBulk(false)}>Cancel</Btn>
          <Btn variant="danger" onClick={bulkRemove} disabled={busy()}>
            {busy() ? "Deleting…" : `Delete ${selected().size}`}
          </Btn>
        </div>
      </Modal>
    </div>
  );
}

