import { TarnavMarkdown } from "./TarnavMarkdown";

/** Transcript adapter: the actual renderer is the parity page's TarnavMarkdown. */
export function StreamingMarkdown(props: { children?: string; streaming?: boolean; active?: boolean; class?: string; plain?: boolean }) {
  return <TarnavMarkdown embedded mode={props.plain ? "plain" : undefined} streaming={props.streaming} active={props.active} class={props.class}>{props.children}</TarnavMarkdown>;
}
