import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import AgGridSolid, { type AgGridSolidRef } from "solid-ag-grid";
import type {
  ColDef,
  ColGroupDef,
  ColumnState,
  GridApi,
  IFilterParams,
  IFloatingFilterParams,
} from "ag-grid-community";

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
  floatingFilter: true,
  minWidth: 72,
};
const PAGE_SIZE_SELECTOR: number[] = [15, 20, 25, 50, 100, 250];
// The datetime floating filter stacks TWO datetime-local inputs — grids whose
// colDefs use it get a taller floating row (module constants, see gotcha above).
const FLOATING_FILTERS_TALL = { floatingFiltersHeight: 48 };
const FLOATING_FILTERS_DEFAULT = {};

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

/** Custom datetime filter model — also the server contract (gridql "datetime"
 *  branch): from/to are epoch MILLISECONDS, timezone-corrected client-side
 *  (datetime-local parses in the browser's local zone). */
interface DateTimeFilterModel {
  filterType: "datetime";
  from: number | null;
  to: number | null;
}

function parseLocalDateTime(value: string): number | null {
  if (!value) return null;
  const ms = Date.parse(value); // no offset → browser-local
  return Number.isFinite(ms) ? ms : null;
}

function toLocalDateTimeInput(ms: number | null): string {
  if (ms == null) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** From/To datetime-local range filter (vanilla AG Grid IFilter). The grids
 *  run the infinite row model — the SERVER filters (gridql datetime branch);
 *  doesFilterPass exists only to satisfy the interface. */
export class DateTimeFilter {
  private params!: IFilterParams;
  private eGui!: HTMLDivElement;
  private fromInput!: HTMLInputElement;
  private toInput!: HTMLInputElement;
  private from: number | null = null;
  private to: number | null = null;

  init(params: IFilterParams): void {
    this.params = params;
    this.eGui = document.createElement("div");
    this.eGui.className = "llmgw-dtfilter";
    const row = (label: string): HTMLInputElement => {
      const wrap = document.createElement("label");
      wrap.className = "llmgw-dtfilter-row";
      const span = document.createElement("span");
      span.textContent = label;
      const input = document.createElement("input");
      input.type = "datetime-local";
      input.className = "llmgw-dt-input";
      input.addEventListener("input", () => this.onChanged());
      wrap.append(span, input);
      this.eGui.appendChild(wrap);
      return input;
    };
    this.fromInput = row("From");
    this.toInput = row("To");
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "llmgw-dt-clear";
    clear.textContent = "Clear";
    clear.addEventListener("click", () => {
      this.fromInput.value = "";
      this.toInput.value = "";
      this.onChanged();
    });
    this.eGui.appendChild(clear);
  }

  private onChanged(): void {
    this.from = parseLocalDateTime(this.fromInput.value);
    this.to = parseLocalDateTime(this.toInput.value);
    this.params.filterChangedCallback();
  }

  getGui(): HTMLElement {
    return this.eGui;
  }

  isFilterActive(): boolean {
    return this.from != null || this.to != null;
  }

  doesFilterPass(): boolean {
    return true;
  }

  getModel(): DateTimeFilterModel | null {
    if (!this.isFilterActive()) return null;
    return { filterType: "datetime", from: this.from, to: this.to };
  }

  setModel(model: DateTimeFilterModel | null): void {
    const valid = model != null && model.filterType === "datetime";
    this.from = valid && Number.isFinite(model!.from) ? model!.from : null;
    this.to = valid && Number.isFinite(model!.to) ? model!.to : null;
    this.fromInput.value = toLocalDateTimeInput(this.from);
    this.toInput.value = toLocalDateTimeInput(this.to);
  }

  /** Floating-filter edits land here — one source of truth for the bounds. */
  setRangeFromFloating(from: number | null, to: number | null): void {
    this.from = from;
    this.to = to;
    this.fromInput.value = toLocalDateTimeInput(from);
    this.toInput.value = toLocalDateTimeInput(to);
    this.params.filterChangedCallback();
  }
}

/** Floating row companion: two compact datetime-local inputs that push bounds
 *  into the parent DateTimeFilter. AG Grid instantiates the parent filter
 *  alongside the floating filter, so parentFilterInstance always resolves. */
export class DateTimeFloatingFilter {
  private params!: IFloatingFilterParams;
  private eGui!: HTMLDivElement;
  private fromInput!: HTMLInputElement;
  private toInput!: HTMLInputElement;

  init(params: IFloatingFilterParams): void {
    this.params = params;
    this.eGui = document.createElement("div");
    this.eGui.className = "llmgw-dtfloating";
    const input = (): HTMLInputElement => {
      const el = document.createElement("input");
      el.type = "datetime-local";
      el.className = "llmgw-dt-input";
      el.title = "";
      el.addEventListener("input", () => this.onChanged());
      this.eGui.appendChild(el);
      return el;
    };
    this.fromInput = input();
    this.fromInput.title = "From";
    this.toInput = input();
    this.toInput.title = "To";
  }

  private onChanged(): void {
    const from = parseLocalDateTime(this.fromInput.value);
    const to = parseLocalDateTime(this.toInput.value);
    this.params.parentFilterInstance?.((instance: any) => {
      instance?.setRangeFromFloating?.(from, to);
    });
  }

  getGui(): HTMLElement {
    return this.eGui;
  }

  onParentModelChanged(model: DateTimeFilterModel | null): void {
    const valid = model != null && model.filterType === "datetime";
    const from = valid && Number.isFinite(model!.from) ? model!.from : null;
    const to = valid && Number.isFinite(model!.to) ? model!.to : null;
    const nextFrom = toLocalDateTimeInput(from);
    const nextTo = toLocalDateTimeInput(to);
    // Only write when different: this fires right after every floating edit
    // (parent → filterChangedCallback → back here); rewriting the same value
    // is a no-op but keeps the loop provably terminal.
    if (this.fromInput.value !== nextFrom) this.fromInput.value = nextFrom;
    if (this.toInput.value !== nextTo) this.toInput.value = nextTo;
  }
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

/** Filtered-set aggregates for the grid footer: server-computed over the
 *  same WHERE as the grid page — buckets stay separate, never a lump sum. */
export interface GridTotals {
  in_tok: number;
  cache_tok: number;
  out_tok: number;
  reqs: number;
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
  /** Filtered-set aggregates rendered in the footer (null/absent = footer as today). */
  totals?: GridTotals | null;
}) {
  const [changedColumns, setChangedColumns] = createSignal<string[]>([]);
  createEffect(() => {
    props.refreshDeps; // track
    gridRef?.api?.purgeInfiniteCache?.();
  });
  // props.columnDefs are stable module constants per page, so this picks once.
  const tallFloating = props.columnDefs.some(
    (c) =>
      !("children" in c) &&
      ((c as ColDef).filter === DateTimeFilter ||
        (c as ColDef).floatingFilterComponent === DateTimeFloatingFilter),
  );
  const darkClass = () => {
    // Track the signal (updates live on toggle) but trust the DOM attribute —
    // it is the single source of truth that the whole app already styles by.
    theme();
    return getTheme() === "dark" ? "ag-theme-quartz-dark" : "ag-theme-quartz";
  };

  // ---- per-grid user prefs (filters, column size/order/visibility, sort) ----
  let gridRef: AgGridSolidRef | undefined;
  let defaultColumnState: ColumnState[] = [];
  const columnLabels = new Map(
    props.columnDefs.flatMap((column) =>
      "children" in column
        ? []
        : [[column.colId ?? column.field ?? "", column.headerName ?? column.colId ?? column.field ?? "Column"]],
    ),
  );
  const updateChangedColumns = (api: GridApi) => {
    const defaults = new Map(defaultColumnState.map((state) => [state.colId, state]));
    const changed = api
      .getColumnState()
      .filter((state) =>
        (state.hide ?? false) !== (defaults.get(state.colId)?.hide ?? false) ||
        api.getColumnFilterModel(state.colId) != null,
      )
      .map((state) => state.colId);
    setChangedColumns(changed);
  };
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
  const onGridChanged = () => {
    if (gridRef?.api) updateChangedColumns(gridRef.api);
    saveSoon();
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

  const resetColumn = async (colId: string) => {
    const api = gridRef?.api;
    if (!api) return;
    const defaultState = defaultColumnState.find((state) => state.colId === colId);
    if (defaultState) {
      api.applyColumnState({
        state: [{ colId, hide: defaultState.hide ?? false }],
      });
    }
    await api.setColumnFilterModel(colId, null);
    api.onFilterChanged("api");
    updateChangedColumns(api);
    saveState();
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
    updateChangedColumns(api);
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
            {...(tallFloating ? FLOATING_FILTERS_TALL : FLOATING_FILTERS_DEFAULT)}
            animateRows
            rowHeight={38}
            suppressCellFocus
            onGridReady={(e) => {
              defaultColumnState = e.api.getColumnState().map((state: ColumnState) => ({ ...state }));
              restoreState();
              updateChangedColumns(e.api);
              props.onGridReady?.(e);
            }}
            onModelUpdated={props.onModelUpdated}
            onFilterChanged={onGridChanged}
            onSortChanged={onGridChanged}
            onColumnMoved={onGridChanged}
            onColumnResized={onGridChanged}
            onColumnVisible={onGridChanged}
            rowSelection={props.rowSelection}
            suppressRowClickSelection={props.suppressRowClickSelection}
            getRowId={props.getRowId}
            onSelectionChanged={props.onSelectionChanged}
          />
        </Show>
      </div>
      <div class="flex items-center justify-between gap-2 overflow-x-auto px-1.5 py-1 shrink-0">
        <div class="flex items-center gap-1 shrink-0">
          <For each={changedColumns()}>
            {(colId) => (
              <Btn
                variant="ghost"
                size="sm"
                class="max-h-5 min-h-5 max-w-fit min-w-fit !px-2 border border-brand-500/30 bg-brand-500/10 text-[11px] text-brand-400 hover:border-brand-500/50 hover:bg-brand-500/20 hover:text-brand-300"
                title={`Reset ${columnLabels.get(colId) ?? colId}`}
                onClick={() => resetColumn(colId)}
              >
                <Icon name={Icons.refresh} size={12} />
                Reset {columnLabels.get(colId) ?? colId}
              </Btn>
            )}
          </For>
        </div>
        <div class="flex items-center gap-3 shrink-0">
          <Show when={props.totals}>
            {(totals) => (
              <div
                class="flex items-center gap-2.5 whitespace-nowrap text-[11px] text-ink-400"
                title="Totals for the current table filters"
              >
                <span>In <strong class="font-semibold text-ink-200">{fmtNum(totals().in_tok)}</strong></span>
                <span>Cache <strong class="font-semibold text-ink-200">{fmtNum(totals().cache_tok)}</strong></span>
                <span>Out <strong class="font-semibold text-ink-200">{fmtNum(totals().out_tok)}</strong></span>
                <span>Requests <strong class="font-semibold text-ink-200">{fmtNum(totals().reqs)}</strong></span>
              </div>
            )}
          </Show>
          <Btn
            variant="ghost"
            size="sm"
            class="max-h-5 min-h-5 max-w-fit min-w-fit !px-2 text-[11px] text-ink-500 hover:text-ink-200"
            title="Reset column order, sizes, sorting and filters to the default layout"
            disabled={!props.rowData && !props.datasource}
            onClick={resetLayout}
          >
            <Icon name={Icons.refresh} size={12} />
            Reset layout
          </Btn>
        </div>
      </div>
    </div>
  );
}
