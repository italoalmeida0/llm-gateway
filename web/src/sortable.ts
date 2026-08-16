import Sortable from "sortablejs";
import { onCleanup } from "solid-js";

/**
 * Thin wrapper around SortableJS (the project's drag-and-drop dep):
 * theme-consistent defaults — drag via a dedicated handle class, small
 * animation, ghost row dimmed. Used for every priority-ordered list in the
 * admin UI (providers, provider keys, model targets).
 *
 * The callback receives the reordered `data-id` values; persistence (API
 * call) is the caller's job — its state update/re-render applies the new
 * order: on drop we UNDO Sortable's optimistic DOM move, because Solid's
 * array reconciliation assumes the child order it rendered and crashes
 * (`insertBefore` on a reference node that got deleted) or snaps rows back
 * if the DOM was mutated behind its back.
 */
export function attachSortable(
  el: HTMLElement,
  opts: {
    /** Selector of the drag handle inside each row (default "[data-handle]"). */
    handle?: string;
    onReorder: (ids: string[]) => void;
  },
): Sortable {
  const s = Sortable.create(el, {
    animation: 150,
    handle: opts.handle ?? "[data-handle]",
    ghostClass: "sortable-ghost",
    chosenClass: "sortable-chosen",
    dragClass: "sortable-drag",
    onEnd: (evt) => {
      const { oldIndex, newIndex, item, from } = evt;
      if (oldIndex === newIndex || oldIndex == null || newIndex == null) return;
      const ids = Array.from(el.children)
        .map((c) => (c as HTMLElement).dataset.id)
        .filter((x): x is string => !!x);
      // Undo Sortable's optimistic DOM move. Solid's array reconciliation
      // trusts the child order it rendered (it computes insert references from
      // its own node list); reconciling against a DOM that was reordered behind
      // its back throws insertBefore NotFoundError and/or drops rows. Reverting
      // here makes the caller's state update / refetch re-render the list into
      // the new order from a consistent DOM.
      const ref = newIndex > oldIndex ? from.children[oldIndex] : from.children[oldIndex + 1];
      from.insertBefore(item, ref ?? null);
      opts.onReorder(ids);
    },
  });
  onCleanup(() => s.destroy());
  return s;
}
