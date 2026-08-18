import { Show, createEffect, onCleanup } from "solid-js";
import AgGridSolid, { type AgGridSolidRef } from "solid-ag-grid";
import type { ColDef, ColGroupDef } from "ag-grid-community";

import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";

import { Badge, Btn, Icon, Icons, fmtDate, fmtNum, getTheme, theme } from "./ui";

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
  filter: "agTextColumnFilter",
  floatingFilter: false,
  minWidth: 72,
};
const PAGE_SIZE_SELECTOR: number[] = [15, 20, 25, 50, 100, 250];

/** AG Grid date filters receive native Date values by default. Our API DTOs
 * carry epoch milliseconds, so compare their local calendar day explicitly. */
export const EPOCH_DATE_FILTER_PARAMS = {
  browserDatePicker: true,
  comparator: (filterLocalDateAtMidnight: Date, cellValue: unknown) => {
    const timestamp = Number(cellValue);
    if (!Number.isFinite(timestamp)) return -1;
    const cellDate = new Date(timestamp);
    const cellDay = new Date(
      cellDate.getFullYear(),
      cellDate.getMonth(),
      cellDate.getDate(),
    );
    if (cellDay < filterLocalDateAtMidnight) return -1;
    if (cellDay > filterLocalDateAtMidnight) return 1;
    return 0;
  },
};

export interface GridRowsParams {
  startRow: number;
  endRow: number;
  sortModel: Array<{ colId: string; sort: string }>;
  filterModel: Record<string, unknown>;
  successCallback: (rowsThisBlock: unknown[], lastRow: number) => void;
  failCallback: () => void;
}

export function serverDatasource<T>(
  load: (params: {
    startRow: number;
    endRow: number;
    sortModel: Array<{ colId: string; sort: string }>;
    filterModel: Record<string, unknown>;
  }) => Promise<{ rows: T[]; total: number }>,
) {
  return {
    getRows: async (params: GridRowsParams) => {
      try {
        const result = await load({
          startRow: params.startRow,
          endRow: params.endRow,
          sortModel: params.sortModel,
          filterModel: params.filterModel,
        });
        params.successCallback(result.rows, result.total);
      } catch {
        params.failCallback();
      }
    },
  };
}

export function UsageGrid(props: {
  columnDefs: Array<ColDef | ColGroupDef>;
  /** undefined = data still loading (grid mounts only when ready). Optional in
   *  datasource (infinite row model) mode. */
  rowData?: unknown[] | undefined;
  pageSize?: number;
  /** Tailwind height class for the grid wrapper (default h-[420px]). */
  heightClass?: string;
  /** localStorage key for user prefs (column order/size/visibility, sort,
   *  filters). Column defs must be stable for the state to map back. */
  storageKey: string;
  /** Optional passthroughs for selection-enabled grids (e.g. Models). */
  rowSelection?: "single" | "multiple";
  suppressRowClickSelection?: boolean;
  getRowId?: (p: { data: any }) => string;
  onSelectionChanged?: (e: any) => void;
  onGridReady?: (e: any) => void;
  onModelUpdated?: (e: any) => void;
  /** Infinite row model (server-driven blocks; mutually exclusive with
   *  pagination props). The datasource maps startRow/endRow to
   *  limit/offset API calls with sort/filter forwarded to SQL. */
  datasource?: {
    getRows: (params: GridRowsParams) => void;
  };
  /** Block size the grid requests per fetch (default 100). */
  cacheBlockSize?: number;
  /** Increment to force the grid to re-pull its row cache (e.g. top-level
   *  filter changed). */
  refreshDeps?: unknown;
}) {
  createEffect(() => {
    props.refreshDeps; // track
    gridRef?.api?.purgeInfiniteCache?.();
  });
  const darkClass = () => {
    // Track the signal (updates live on toggle) but trust the DOM attribute —
    // it is the single source of truth that the whole app already styles by.
    theme();
    return getTheme() === "dark" ? "ag-theme-quartz-dark" : "ag-theme-quartz";
  };

  // ---- per-grid user prefs (filters, column size/order/visibility, sort) ----
  let gridRef: AgGridSolidRef | undefined;
  const saveState = () => {
    const api = gridRef?.api;
    if (!api) return;
    try {
      localStorage.setItem(
        props.storageKey,
        JSON.stringify({
          columnState: api.getColumnState(),
          filterModel: api.getFilterModel(),
        }),
      );
    } catch {}
  };
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const saveSoon = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveState, 250);
  };
  onCleanup(() => {
    if (saveTimer) clearTimeout(saveTimer);
  });
  const restoreState = () => {
    const api = gridRef?.api;
    if (!api) return;
    try {
      const raw = localStorage.getItem(props.storageKey);
      if (!raw) return;
      const j = JSON.parse(raw);
      if (Array.isArray(j.columnState)) {
        api.applyColumnState({ state: j.columnState, applyOrder: true });
      }
      if (j.filterModel && typeof j.filterModel === "object") {
        api.setFilterModel(j.filterModel);
      }
    } catch {}
  };

  /** Wipe persisted prefs and put the grid back on the column defs. */
  const resetLayout = () => {
    try {
      localStorage.removeItem(props.storageKey);
    } catch {}
    const api = gridRef?.api;
    if (!api) return;
    api.resetColumnState();
    api.setFilterModel(null);
  };

  return (
    <div
      class={`w-full max-h-[72vh] ${darkClass()} ${props.heightClass ?? "h-[420px]"} flex flex-col`}
    >
      <div class="min-h-0 flex-1">
        <Show when={props.rowData ?? props.datasource}>
          <AgGridSolid
            ref={gridRef}
            rowData={props.rowData!}
            columnDefs={props.columnDefs}
            defaultColDef={DEFAULT_COL_DEF}
            {...(props.datasource
              ? {
                  rowModelType: "infinite" as const,
                  datasource: props.datasource,
                  cacheBlockSize: props.cacheBlockSize ?? 100,
                  maxBlocksInCache: 8,
                  maxConcurrentDatasourceRequests: 2,
                  infiniteInitialRowCount: 1,
                  blockLoadDebounceMillis: 50,
                }
              : {
                  pagination: true,
                  paginationPageSize: props.pageSize ?? 25,
                  paginationPageSizeSelector: PAGE_SIZE_SELECTOR,
                })}
            animateRows
            rowHeight={38}
            suppressCellFocus
            onGridReady={(e) => {
              restoreState();
              props.onGridReady?.(e);
            }}
            onModelUpdated={props.onModelUpdated}
            onFilterChanged={saveSoon}
            onSortChanged={saveSoon}
            onColumnMoved={saveSoon}
            onColumnResized={saveSoon}
            onColumnVisible={saveSoon}
            rowSelection={props.rowSelection}
            suppressRowClickSelection={props.suppressRowClickSelection}
            getRowId={props.getRowId}
            onSelectionChanged={props.onSelectionChanged}
          />
        </Show>
      </div>
      <div class="flex items-center justify-end px-1.5 py-1 shrink-0">
        <Btn
          variant="ghost"
          size="sm"
          class="!px-2 text-[11px] text-ink-500 hover:text-ink-200"
          title="Reset column order, sizes, sorting and filters to the default layout"
          disabled={!props.rowData && !props.datasource}
          onClick={resetLayout}
        >
          <Icon name={Icons.refresh} size={12} />
          Reset layout
        </Btn>
      </div>
    </div>
  );
}
