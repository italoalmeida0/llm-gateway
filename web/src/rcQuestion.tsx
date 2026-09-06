import { createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { Icon } from "./components/icon";

export interface PendingQuestion {
  id: string;
  questions: {header:string; question:string; options:{label:string; description?:string}[]; multiple?:boolean; custom?:boolean}[];
}

/** One request stays mounted across live snapshots so typed answers survive. */
export function QuestionPanel(props: {
  request: PendingQuestion;
  connected: boolean;
  submitting: boolean;
  error: string;
  onSubmit: (answers: string[][]) => void;
}) {
  const [step, setStep] = createSignal(0);
  const [drafts, setDrafts] = createStore(props.request.questions.map((q) => ({selected:[] as string[], custom:!q.options?.length && q.custom !== false, text:""})));
  const question = () => props.request.questions[step()];
  const draft = () => drafts[step()];
  const answers = (i: number) => [...drafts[i].selected, ...(drafts[i].custom && drafts[i].text.trim() ? [drafts[i].text.trim()] : [])];
  const ready = (i: number) => answers(i).length > 0 && (!drafts[i].custom || !!drafts[i].text.trim());
  let heading: HTMLLegendElement | undefined;
  function move(next: number) {
    setStep(next);
    requestAnimationFrame(() => heading?.focus());
  }
  function choose(label: string, checked: boolean) {
    if (question().multiple) setDrafts(step(), "selected", checked ? [...draft().selected, label] : draft().selected.filter((v) => v !== label));
    else setDrafts(step(), {selected:[label], custom:false});
  }
  return <section aria-label="Questions from assistant" class="mb-3 overflow-hidden rounded-2xl border border-line bg-card shadow-lg">
    <div class="flex items-center gap-2 px-4 py-3 border-b border-line text-xs text-ink-400">
      <Icon icon="lucide:message-circle" size={15} /><span class="font-medium text-ink-200">Your input is needed</span>
      <span class="ml-auto" aria-live="polite">{step()+1} of {props.request.questions.length}</span>
    </div>
    <form onSubmit={(e) => {
      e.preventDefault();
      if (!ready(step()) || props.submitting) return;
      if (step() < props.request.questions.length-1) move(step()+1);
      else if (props.connected && drafts.every((_, i) => ready(i))) props.onSubmit(drafts.map((_, i) => answers(i)));
    }}>
      <fieldset disabled={props.submitting} class="px-4 py-3 max-h-[38vh] overflow-y-auto min-w-0">
        <legend ref={heading} tabIndex={-1} class="float-left w-full mb-3 outline-none">
          <span class="block text-[11px] font-medium text-ink-500 mb-1">{question().header}</span>
          <span class="block text-sm font-medium text-ink-100 whitespace-pre-wrap break-words">{question().question}</span>
        </legend>
        <div class="clear-both space-y-2">
          <Show when={question().multiple}><p class="text-[11px] text-ink-500">Select all that apply.</p></Show>
          <For each={question().options || []}>{(option) => <label class={`flex items-start gap-3 rounded-xl border px-3 py-2.5 cursor-pointer transition-colors ${draft().selected.includes(option.label) ? "border-ink-400 bg-elev" : "border-line hover:bg-elev/70"}`}>
            <input type={question().multiple ? "checkbox" : "radio"} name={`${props.request.id}-${step()}`} checked={draft().selected.includes(option.label)} onChange={(e) => choose(option.label, e.currentTarget.checked)} class="mt-0.5 accent-accent-500 shrink-0" />
            <span class="min-w-0"><span class="block text-xs font-medium text-ink-200 break-words">{option.label}</span><Show when={option.description}><span class="block mt-1 text-xs text-ink-500 break-words">{option.description}</span></Show></span>
          </label>}</For>
          <Show when={question().custom !== false}>
            <label class={`flex items-center gap-3 rounded-xl border px-3 py-2.5 cursor-pointer ${draft().custom ? "border-ink-400 bg-elev" : "border-line hover:bg-elev/70"}`}>
              <input type={question().multiple ? "checkbox" : "radio"} name={`${props.request.id}-${step()}`} checked={draft().custom} onChange={(e) => {
                setDrafts(step(), "custom", e.currentTarget.checked);
                if (!question().multiple) setDrafts(step(), "selected", []);
              }} class="accent-accent-500 shrink-0" /><span class="text-xs text-ink-300">Type your own answer</span>
            </label>
            <Show when={draft().custom}>
              <textarea aria-label="Your answer" value={draft().text} maxLength={4000} rows={2} onInput={(e) => setDrafts(step(), "text", e.currentTarget.value)} class="block w-full resize-y rounded-xl border border-line bg-elev px-3 py-2 text-sm text-ink-100 outline-none focus:border-ink-400" />
            </Show>
          </Show>
        </div>
      </fieldset>
      <Show when={props.error}><p role="alert" class="px-4 pb-2 text-xs text-rose-400">{props.error}</p></Show>
      <div class="flex items-center gap-2 border-t border-line px-4 py-3">
        <button type="button" disabled={step() === 0 || props.submitting} onClick={() => move(step()-1)} class="rounded-lg px-3 py-2 text-xs text-ink-300 hover:bg-elev disabled:opacity-40 cursor-pointer disabled:cursor-default">Back</button>
        <Show when={!props.connected}><span class="text-[11px] text-ink-500">Reconnecting…</span></Show>
        <button type="submit" disabled={!ready(step()) || props.submitting || (step() === props.request.questions.length-1 && !props.connected)} class="ml-auto rounded-lg bg-ink-100 text-ink-950 px-4 py-2 text-xs font-medium hover:bg-ink-200 disabled:opacity-40 cursor-pointer disabled:cursor-default">
          {props.submitting ? "Sending…" : step() < props.request.questions.length-1 ? "Next" : "Send answers"}
        </button>
      </div>
    </form>
  </section>;
}
