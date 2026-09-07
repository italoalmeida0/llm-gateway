import type { JSX } from "solid-js";
import { Icon as Iconify } from "../../components/icon";

/** Item de menu partilhado dos popovers FloatMenu (mesma classe em todos os
 * menus de contexto/ficheiros/sidebars — extraído para um só sítio). */
export function MenuItem(props: {
  icon?: string;
  iconSize?: number;
  children: JSX.Element;
  onClick?: (e: MouseEvent) => void;
  class?: string;
  role?: JSX.HTMLAttributes<HTMLButtonElement>["role"];
  tip?: string;
}) {
  return (
    <button
      role={props.role}
      onClick={props.onClick}
      data-rc-tip={props.tip}
      aria-label={props.tip}
      class={
        props.class ??
        "w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-ink-300 hover:bg-ink-800/60 flex items-center gap-2 cursor-pointer"
      }
    >
      {props.icon ? <Iconify icon={props.icon} size={props.iconSize ?? 13} /> : null}
      {props.children}
    </button>
  );
}
