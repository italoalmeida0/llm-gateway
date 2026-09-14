import { createEffect, createSignal, on, Show, type JSX } from "solid-js";

/** Manual choices survive snapshots, but expire when the activity phase changes. */
export function createDisclosure(phase: () => string, autoOpen: () => boolean) {
  const [manual, setManual] = createSignal<boolean>();
  createEffect(on(phase, () => setManual(undefined), { defer: true }));
  const open = () => manual() ?? autoOpen();
  return { open, toggle: () => setManual(!open()) };
}

/** Mount expensive details on first use, then hide them without losing DOM/scroll. */
export function DisclosureBody(props: { open: boolean; class?: string; children: JSX.Element }) {
  const [visited, setVisited] = createSignal(false);
  createEffect(() => { if (props.open) setVisited(true); });
  return <Show when={visited() || props.open}>
    <div class={props.class} style={{ display: props.open ? undefined : "none" }}>{props.children}</div>
  </Show>;
}
