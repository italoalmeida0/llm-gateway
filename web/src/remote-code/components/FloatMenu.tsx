import { onCleanup, onMount, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import type { Placement } from "@floating-ui/dom";
import { anchorFloat } from "../../floating";

/** Local popover menu on the shared floating-ui layer (Portal + flip/shift). */
export function FloatMenu(props: {
  anchor: () => HTMLElement | null | undefined;
  open: boolean;
  placement?: Placement;
  width?: string;
  children: JSX.Element;
}) {
  return (
    <Show when={props.open}>
      <Portal>
        <div
          ref={(el) => {
            const a = props.anchor();
            if (!a) return;
            onCleanup(anchorFloat(a, el, { placement: props.placement ?? "bottom-start", maxHeight: 520 }));
          }}
          data-floatmenu
          class="anim-float-in max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-line bg-card shadow-xl p-1.5 text-xs [scrollbar-gutter:stable]"
          style={props.width ? { width: props.width } : undefined}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {props.children}
        </div>
      </Portal>
    </Show>
  );
}

/**
 * Interfaces
 */

