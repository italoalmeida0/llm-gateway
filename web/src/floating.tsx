/**
 * Floating layers for the whole dashboard, powered by @floating-ui/dom (the
 * vanilla build — no React). Tooltips, select menus and popovers live in a
 * <Portal> at the top of the z-index scale and anchor themselves to their
 * trigger with flip + shift + autoUpdate: they are never clipped by an
 * ancestor's overflow (e.g. the modal's scroll area), never buried under the
 * modal layer, and stay glued to the trigger across scroll/resize.
 *
 * anchorFloat() positions via left/top, NOT transform — the element's own
 * CSS entrance animation (anim-float-in) is free to use transform, with
 * transform-origin derived from the resolved placement.
 *
 * Call anchorFloat() from a `ref` callback inside a <Show>, or use the
 * <FloatMenu> wrapper for plain anchored menus — both clean up their
 * listeners when Solid unmounts the layer.
 */
import { createEffect, onCleanup, Show, type JSX } from "solid-js";
import { Portal } from "solid-js/web";
import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  size,
  type Middleware,
  type Placement,
} from "@floating-ui/dom";

/** One z-index scale for every overlay: modals < toasts < floating layers. */
export const Z = {
  modal: 50,
  toast: 60,
  floating: 70,
} as const;

export interface AnchorOptions {
  placement?: Placement;
  /** Gap between trigger and floating element, px (default 6). */
  gap?: number;
  /** Clearance kept from every viewport edge, px (default 8). */
  padding?: number;
  /** Match the floating width to the trigger width (select menus). */
  matchWidth?: boolean;
  /** Cap max-height to what the resolved side can fit (scrollable menus). */
  maxHeight?: number;
  /** Extra middleware appended after the default stack. */
  middleware?: Middleware[];
}

/** transform-origin opposite the anchor side, so entrances grow from the trigger. */
const ORIGIN: Record<string, string> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

/** Anchor `el` to `ref`, glued on screen across scroll/resize. Returns cleanup.
 *
 * Timing-safe: Solid `ref` callbacks can fire before the Portal inserts `el`
 * into the document, and floating-ui throws on detached nodes
 * (`getComputedStyle` on a non-Element while climbing). Setup is deferred to
 * the next frame (when both ends are connected) and every update is guarded,
 * so a positioning failure can never break menu insertion.
 */
export function anchorFloat(
  ref: Element,
  el: HTMLElement,
  opts: AnchorOptions = {},
): () => void {
  if (!(ref instanceof Element) || !(el instanceof HTMLElement)) return () => {};
  const padding = opts.padding ?? 8;
  Object.assign(el.style, {
    position: "absolute",
    left: "0px",
    top: "0px",
    zIndex: String(Z.floating),
    visibility: "hidden",
  });

  let cleanup: (() => void) | undefined;
  let raf = 0;
  let tries = 0;
  let cancelled = false;

  const update = () =>
    computePosition(ref, el, {
      placement: opts.placement ?? "bottom",
      middleware: [
        offset(opts.gap ?? 6),
        flip({ padding }),
        shift({ padding }),
        ...(opts.matchWidth || opts.maxHeight
          ? [
              size({
                padding,
                apply({ rects, availableHeight, elements }) {
                  if (opts.matchWidth) {
                    elements.floating.style.width = `${rects.reference.width}px`;
                  }
                  if (opts.maxHeight) {
                    elements.floating.style.maxHeight = `${Math.min(
                      opts.maxHeight,
                      Math.max(96, availableHeight),
                    )}px`;
                  }
                },
              }),
            ]
          : []),
        ...(opts.middleware ?? []),
      ],
    })
      .then(({ x, y, placement }) => {
        if (cancelled) return;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.style.transformOrigin = `${ORIGIN[placement.split("-")[0]] ?? "top"} center`;
        el.style.visibility = "";
      })
      .catch(() => {});

  const setup = () => {
    if (cancelled) return;
    if ((!ref.isConnected || !el.isConnected) && tries++ < 60) {
      raf = requestAnimationFrame(setup);
      return;
    }
    try {
      cleanup = autoUpdate(ref, el, update);
    } catch {
      void update();
    }
  };
  raf = requestAnimationFrame(setup);
  return () => {
    cancelled = true;
    cancelAnimationFrame(raf);
    try {
      cleanup?.();
    } catch {}
  };
}

/** Reactive anchorFloat for getter-style refs (Solid components). */
export function useFloating(
  anchor: () => HTMLElement | null | undefined,
  floatingEl: () => HTMLElement | null | undefined,
  placement: Placement = "bottom-start",
) {
  createEffect(() => {
    const a = anchor();
    const f = floatingEl();
    if (!a || !f) return;
    const cleanup = anchorFloat(a, f, { placement });
    onCleanup(cleanup);
  });
}

/** Portaled anchored menu — click/mouse-down inside never bubbles out. */
export function FloatMenu(props: {
  /** Anchor element getter (usually a button ref). */
  anchor: () => HTMLElement | null | undefined;
  open: boolean;
  placement?: Placement;
  width?: string;
  children: JSX.Element;
}) {
  let pop: HTMLDivElement | undefined;
  useFloating(props.anchor, () => pop, props.placement ?? "bottom-start");
  return (
    <Show when={props.open}>
      <Portal>
        <div
          ref={pop}
          class="rounded-xl border border-line bg-ink-900 shadow-2xl p-1.5 text-xs"
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
