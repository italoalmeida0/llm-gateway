import { onCleanup } from "solid-js";
import { followTail, recordToolScroll, restoreToolScroll } from "../../utils/scrollMemory";
import { ToolFooter } from "./ToolFooter";
import { ToolEditBodies } from "./ToolEditBodies";
import { ToolSearchBodies } from "./ToolSearchBodies";
import { ToolQuestionBodies } from "./ToolQuestionBodies";
import type { ToolPartProps } from "./toolUnitModel";

/**
 * The scrolling container of one tool body. It is the ONLY scroll surface of
 * a tool: the body components render their blocks with overflow-visible, so a
 * tool never shows nested scrollbars. Scroll position and tail-follow are
 * recorded here on the tool's row key.
 */
export function ToolBody(props: ToolPartProps) {
  return (
    <div
      ref={(el) => {
        restoreToolScroll(props.m.key(), el);
        requestAnimationFrame(() => restoreToolScroll(props.m.key(), el));
        onCleanup(followTail(el, () => props.m.open() && props.running));
      }}
      onScroll={(e) => recordToolScroll(props.m.key(), e.currentTarget)}
      class="mt-0.5 mb-1.5 rounded-lg border border-line/50 bg-ink-950/60 max-h-96 overflow-auto overscroll-contain [scrollbar-gutter:stable]"
    >
      {/* min-w-full w-fit column: block children (and their borders) stretch
          to the widest sibling, so a horizontal overflow never truncates a
          separator line at the visible edge. */}
      <div class="min-w-full w-fit">
        <ToolEditBodies {...props} />
        <ToolSearchBodies {...props} />
        <ToolQuestionBodies {...props} />
        <ToolFooter facts={props.m.footer()} />
      </div>
    </div>
  );
}
