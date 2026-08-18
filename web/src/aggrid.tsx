import { Show } from "solid-js";
import AgGridSolid from "solid-ag-grid";
import type { ColDef, ColGroupDef } from "ag-grid-community";

import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";

import { Badge, fmtDate, fmtNum, getTheme, theme } from "./ui";

/**
 * AG Grid usage tables (ag-grid-community + solid-ag-grid, user-sanctioned).
 *
 * The theme follows the app's white/dark system: the wrapper toggles the
 * ag-theme-quartz / ag-theme-quartz-dark class, and the --ag-* CSS variables
 * are remapped to the project's semantic tokens in style.tailwindcss.css so
 * both themes stay in sync with the rest of the UI.
 *
 * Gotchas around solid-ag-grid@0.0.230:
 *  - Every option prop is diffed in an effect that can fire BEFORE the grid's
 *    internal api exists (its api is assigned in a later microtask); a prop
 *    change inside that window crashes with
 *    `Cannot read properties of undefined ('__internalUpdateGridOptions')`.
 *    So: option props are MODULE CONSTANTS (not inline literals, which would
 *    be new identities every render) and the grid only mounts once rowData
 *    is a real array (never in the resource-pending window).
 *  - Custom cell renderers are Solid components passed as `cellRenderer`.
 */

/** OpenAI / Anthropic protocol badge cell. */
export function ProtoCell(props: { value?: string }) {
  const openai = props.value === "openai";
  return (
    <Badge tone={openai ? "blue" : "amber"}>
      {openai ? "OpenAI" : "Anthropic"}
    </Badge>
  );
}

/** HTTP-status badge cell. */
export function StatusCell(props: { value?: number }) {
  const s = Number(props.value ?? 0);
  return (
    <Badge tone={s < 400 ? "green" : s < 500 ? "amber" : "red"}>{s}</Badge>
  );
}

/** Token-bucket numeric cell formatter (compact "1.2M"). */
export function tokenFormatter(p: { value?: unknown }) {
  return fmtNum(Number(p.value ?? 0));
}

/** Plain count numeric cell formatter. */
export function countFormatter(p: { value?: unknown }) {
  return fmtNum(Number(p.value ?? 0));
}

/** Epoch-ms timestamp cell formatter. */
export function timeFormatter(p: { value?: unknown }) {
  return fmtDate(Number(p.value ?? 0));
}

/** Latency cell formatter ("1234 ms"). */
export function latencyFormatter(p: { value?: unknown }) {
  return `${fmtNum(Number(p.value ?? 0))}ms`;
}

// Module-level constants — see the gotcha note above (stable identities keep
// the grid's internal prop-diff effect from firing spurious change updates).
const DEFAULT_COL_DEF: ColDef = {
  sortable: true,
  resizable: true,
  filter: true,
  floatingFilter: true,
  minWidth: 72,
};
const PAGE_SIZE_SELECTOR: number[] = [25, 50, 100, 250];

export function UsageGrid(props: {
  columnDefs: Array<ColDef | ColGroupDef>;
  /** undefined = data still loading (grid mounts only when ready). */
  rowData: unknown[] | undefined;
  pageSize?: number;
  /** Tailwind height class for the grid wrapper (default h-[420px]). */
  heightClass?: string;
}) {
  const darkClass = () => {
    // Track the signal (updates live on toggle) but trust the DOM attribute —
    // it is the single source of truth that the whole app already styles by.
    theme();
    return getTheme() === "dark" ? "ag-theme-quartz-dark" : "ag-theme-quartz";
  };
  return (
    <div
      class={`w-full ${darkClass()} ${props.heightClass ?? "h-[420px]"}`}
    >
      <Show when={props.rowData}>
        <AgGridSolid
          rowData={props.rowData!}
          columnDefs={props.columnDefs}
          defaultColDef={DEFAULT_COL_DEF}
          pagination
          paginationPageSize={props.pageSize ?? 25}
          paginationPageSizeSelector={PAGE_SIZE_SELECTOR}
          animateRows
          rowHeight={38}
          suppressCellFocus
        />
      </Show>
    </div>
  );
}