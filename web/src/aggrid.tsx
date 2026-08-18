import AgGridSolid from "solid-ag-grid";
import type { ColDef, ColGroupDef } from "ag-grid-community";

import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";

import { Badge, fmtDate, fmtNum, theme } from "./ui";

/**
 * AG Grid usage tables (ag-grid-community + solid-ag-grid, user-sanctioned).
 *
 * The theme follows the app's white/dark system: the wrapper toggles the
 * ag-theme-quartz / ag-theme-quartz-dark class, and the --ag-* CSS variables
 * are remapped to the project's semantic tokens in style.tailwindcss.css so
 * both themes stay in sync with the rest of the UI.
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

export function UsageGrid(props: {
  columnDefs: Array<ColDef | ColGroupDef>;
  rowData: unknown[];
  pageSize?: number;
  /** Tailwind height class for the grid wrapper (default h-[420px]). */
  heightClass?: string;
}) {
  return (
    <div
      class={`w-full ${theme() === "dark" ? "ag-theme-quartz-dark" : "ag-theme-quartz"} ${
        props.heightClass ?? "h-[420px]"
      }`}
    >
      <AgGridSolid
        rowData={props.rowData}
        columnDefs={props.columnDefs}
        defaultColDef={{
          sortable: true,
          resizable: true,
          filter: true,
          floatingFilter: true,
          minWidth: 72,
        }}
        pagination
        paginationPageSize={props.pageSize ?? 25}
        paginationPageSizeSelector={[25, 50, 100, 250]}
        animateRows
        rowHeight={38}
        suppressCellFocus
      />
    </div>
  );
}