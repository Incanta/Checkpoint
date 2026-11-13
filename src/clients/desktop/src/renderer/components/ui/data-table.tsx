import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnSizingState,
  type Row,
  type RowData,
  type SortingState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronDown, faChevronUp } from "@fortawesome/free-solid-svg-icons";

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /**
     * Takes the space the other columns leave. At most one column should
     * set this. Dragging either of its edges resizes the neighbor across
     * that edge, so the boundary still follows the pointer.
     */
    fill?: boolean;
    /**
     * The text a cell shows, used to size the column to its widest value
     * until the user resizes it. Columns without it use their `size`.
     */
    measure?: (row: TData) => string;
    /** Upper bound for the content-based width. Defaults to 320px. */
    maxAutoSize?: number;
    /** Extra classes for this column's body cells. */
    cellClassName?: string;
  }
}

const HEADER_HEIGHT = 32;
const ESTIMATED_ROW_HEIGHT = 28;
// px-2 on each side, plus the 1px column divider.
const CELL_CHROME = 17;
// Room for the sort chevron and its gap in a header.
const SORT_ICON_ROOM = 18;
const DEFAULT_MAX_AUTO_SIZE = 320;
const MAX_MEASURED_ROWS = 1000;

export interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T, any>[];
  getRowId: (row: T) => string;
  /**
   * Saves the user's column widths under this key (per viewer, in
   * localStorage) so they survive remounts and restarts.
   */
  storageKey?: string;
  /** Double-click or Enter on a row. */
  onRowActivate?: (row: T) => void;
  onRowContextMenu?: (event: React.MouseEvent, row: T) => void;
  /** Shown under the header when there are no rows. */
  emptyState?: ReactNode;
  className?: string;
}

function loadSizes(storageKey: string | undefined): ColumnSizingState {
  if (!storageKey) return {};
  try {
    const raw = localStorage.getItem(`data-table:${storageKey}:sizes`);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveSizes(storageKey: string | undefined, sizes: ColumnSizingState) {
  if (!storageKey) return;
  try {
    localStorage.setItem(
      `data-table:${storageKey}:sizes`,
      JSON.stringify(sizes),
    );
  } catch {
    /* storage unavailable; widths just won't persist */
  }
}

function fontOf(el: Element, weight?: string): string {
  const style = getComputedStyle(el);
  return `${weight ?? style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
}

/**
 * Widths that fit each measurable column's header and widest value. Uses a
 * canvas rather than the DOM, so it works while the table is hidden
 * (display: none) and doesn't depend on what's rendered.
 */
function measureColumns<T>(
  el: Element,
  columns: ColumnDef<T, any>[],
  data: T[],
): ColumnSizingState {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return {};
  const bodyFont = fontOf(el);
  const headerFont = fontOf(el, "600");
  const rows = data.slice(0, MAX_MEASURED_ROWS);
  const sizes: ColumnSizingState = {};

  for (const column of columns) {
    const measure = column.meta?.measure;
    if (!column.id || !measure || column.meta?.fill) continue;

    ctx.font = headerFont;
    const header = typeof column.header === "string" ? column.header : "";
    let width = ctx.measureText(header).width + SORT_ICON_ROOM;

    ctx.font = bodyFont;
    for (const row of rows) {
      width = Math.max(width, ctx.measureText(measure(row)).width);
    }

    const max = column.meta?.maxAutoSize ?? DEFAULT_MAX_AUTO_SIZE;
    sizes[column.id] = Math.ceil(Math.min(width + CELL_CHROME, max));
  }
  return sizes;
}

/**
 * A virtualized, sortable, resizable table. Columns with `meta.measure`
 * start sized to their content; the `meta.fill` column takes the rest of
 * the width. Widths the user drags are kept (see `storageKey`), and
 * double-clicking a column's resize handle returns it to its content width.
 */
export function DataTable<T>({
  data,
  columns,
  getRowId,
  storageKey,
  onRowActivate,
  onRowContextMenu,
  emptyState,
  className = "",
}: DataTableProps<T>): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [userSizes, setUserSizes] = useState<ColumnSizingState>(() =>
    loadSizes(storageKey),
  );
  const [autoSizes, setAutoSizes] = useState<ColumnSizingState>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (scrollRef.current) {
      setAutoSizes(measureColumns(scrollRef.current, columns, data));
    }
  }, [columns, data]);

  useEffect(() => {
    saveSizes(storageKey, userSizes);
  }, [storageKey, userSizes]);

  const columnSizing = useMemo(
    () => ({ ...autoSizes, ...userSizes }),
    [autoSizes, userSizes],
  );

  const table = useReactTable({
    data,
    columns,
    getRowId: (row) => getRowId(row),
    // Sizes only change through the boundary drag below, which writes
    // userSizes directly.
    state: { sorting, columnSizing },
    onSortingChange: setSorting,
    // TanStack sorts numbers descending first, which for already
    // newest-first data looks like the click did nothing.
    sortDescFirst: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const rows = table.getRowModel().rows;
  const leafColumns = table.getVisibleLeafColumns();
  const fillIndex = leafColumns.findIndex((c) => c.columnDef.meta?.fill);

  /**
   * Each handle sits on the boundary to the right of column `index`, and
   * dragging it moves that boundary with the pointer. Left of the fill
   * column that means resizing the column itself (the fill column absorbs
   * the change); from the fill column rightward it means resizing the
   * column on the far side of the boundary, since the fill column's width
   * isn't fixed. With a fill column, the last column's right edge is the
   * table's edge and has no handle.
   */
  const boundaryTarget = (index: number) => {
    if (fillIndex < 0 || index < fillIndex) {
      return { column: leafColumns[index], sign: 1 };
    }
    if (index + 1 < leafColumns.length) {
      return { column: leafColumns[index + 1], sign: -1 };
    }
    return null;
  };

  const [resizingHandle, setResizingHandle] = useState<string | null>(null);
  const dragRef = useRef<{
    targetId: string;
    sign: number;
    startX: number;
    startSize: number;
    min: number;
    max: number;
  } | null>(null);

  const gridTemplateColumns = leafColumns
    .map((column) =>
      column.columnDef.meta?.fill
        ? `minmax(${column.columnDef.minSize ?? 160}px, 1fr)`
        : `${column.getSize()}px`,
    )
    .join(" ");
  const minWidth = leafColumns.reduce(
    (sum, column) =>
      sum +
      (column.columnDef.meta?.fill
        ? (column.columnDef.minSize ?? 160)
        : column.getSize()),
    0,
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    scrollMargin: HEADER_HEIGHT,
    overscan: 12,
    getItemKey: (index) => rows[index]?.id ?? index,
  });

  const selectedIndex = useMemo(
    () => (selectedId ? rows.findIndex((r) => r.id === selectedId) : -1),
    [rows, selectedId],
  );

  const selectIndex = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      setSelectedId(row.id);
      virtualizer.scrollToIndex(index, { align: "auto" });
    },
    [rows, virtualizer],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (rows.length === 0) return;
    const pageSize = Math.max(
      1,
      Math.floor(
        ((scrollRef.current?.clientHeight ?? 0) - HEADER_HEIGHT) /
          ESTIMATED_ROW_HEIGHT,
      ),
    );
    const at = selectedIndex;
    let next: number | null = null;
    switch (e.key) {
      case "ArrowDown":
        next = Math.min(rows.length - 1, at + 1);
        break;
      case "ArrowUp":
        next = Math.max(0, at - 1);
        break;
      case "PageDown":
        next = Math.min(rows.length - 1, Math.max(0, at) + pageSize);
        break;
      case "PageUp":
        next = Math.max(0, at - pageSize);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = rows.length - 1;
        break;
      case "Enter":
        if (at >= 0 && onRowActivate) {
          e.preventDefault();
          onRowActivate(rows[at].original);
        }
        return;
      default:
        return;
    }
    e.preventDefault();
    selectIndex(next);
  };

  const resetColumnSize = (id: string) => {
    setUserSizes((sizes) => {
      const { [id]: _removed, ...rest } = sizes;
      return rest;
    });
  };

  const renderRow = (row: Row<T>, start: number, index: number) => {
    const selected = row.id === selectedId;
    return (
      <div
        key={row.id}
        data-index={index}
        ref={virtualizer.measureElement}
        role="row"
        aria-selected={selected}
        className={`absolute left-0 top-0 grid w-full cursor-default select-none border-b border-[var(--color-border-muted)] text-sm transition-colors ${
          selected
            ? "bg-[var(--color-accent-muted)] text-[var(--color-text-primary)] hover:bg-[color-mix(in_srgb,var(--color-accent-muted),var(--color-accent)_25%)]"
            : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-surface)]"
        }`}
        style={{
          gridTemplateColumns,
          transform: `translateY(${start - HEADER_HEIGHT}px)`,
        }}
        onClick={() => setSelectedId(row.id)}
        onDoubleClick={() => onRowActivate?.(row.original)}
        onContextMenu={(e) => {
          setSelectedId(row.id);
          onRowContextMenu?.(e, row.original);
        }}
      >
        {row.getVisibleCells().map((cell) => (
          <div
            key={cell.id}
            role="cell"
            className={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap border-r border-[var(--color-border-muted)] px-2 py-1 last:border-r-0 ${
              cell.column.columnDef.meta?.cellClassName ?? ""
            }`}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div
      ref={scrollRef}
      role="table"
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={`scroll-on-secondary relative h-full overflow-auto bg-[var(--color-bg-primary)] text-left outline-none ${className}`}
    >
      <div style={{ minWidth }}>
        <div
          role="row"
          className="sticky top-0 z-10 grid border-b border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] text-sm font-semibold text-[var(--color-text-primary)]"
          style={{ gridTemplateColumns, height: HEADER_HEIGHT }}
        >
          {table.getFlatHeaders().map((header, index) => {
            const column = header.column;
            const sorted = column.getIsSorted();
            const target = boundaryTarget(index);
            const canResize = target !== null && target.column.getCanResize();
            return (
              <div
                key={header.id}
                role="columnheader"
                aria-sort={
                  sorted === "asc"
                    ? "ascending"
                    : sorted === "desc"
                      ? "descending"
                      : "none"
                }
                className="relative flex min-w-0 items-center border-r border-[var(--color-border-default)] last:border-r-0"
              >
                <button
                  type="button"
                  disabled={!column.getCanSort()}
                  onClick={column.getToggleSortingHandler()}
                  className="m-0 flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-none border-0 bg-transparent px-2 py-0 text-left text-sm font-semibold text-inherit hover:bg-[var(--color-bg-overlay)] disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {flexRender(column.columnDef.header, header.getContext())}
                  </span>
                  {sorted && (
                    <FontAwesomeIcon
                      icon={sorted === "asc" ? faChevronUp : faChevronDown}
                      className="shrink-0 text-[0.7em] text-[var(--color-text-muted)]"
                    />
                  )}
                </button>
                {canResize && target && (
                  <div
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.preventDefault();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      const def = target.column.columnDef;
                      dragRef.current = {
                        targetId: target.column.id,
                        sign: target.sign,
                        startX: e.clientX,
                        startSize: target.column.getSize(),
                        min: def.minSize ?? 40,
                        max: def.maxSize ?? Number.MAX_SAFE_INTEGER,
                      };
                      setResizingHandle(header.id);
                    }}
                    onPointerMove={(e) => {
                      const drag = dragRef.current;
                      if (!drag) return;
                      const size = Math.round(
                        Math.min(
                          drag.max,
                          Math.max(
                            drag.min,
                            drag.startSize +
                              drag.sign * (e.clientX - drag.startX),
                          ),
                        ),
                      );
                      setUserSizes((sizes) =>
                        sizes[drag.targetId] === size
                          ? sizes
                          : { ...sizes, [drag.targetId]: size },
                      );
                    }}
                    onPointerUp={(e) => {
                      e.currentTarget.releasePointerCapture(e.pointerId);
                      dragRef.current = null;
                      setResizingHandle(null);
                    }}
                    onLostPointerCapture={() => {
                      dragRef.current = null;
                      setResizingHandle(null);
                    }}
                    onDoubleClick={() => resetColumnSize(target.column.id)}
                    title="Drag to resize, double-click to fit"
                    className={`absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none ${
                      resizingHandle === header.id
                        ? "bg-[var(--color-accent)]"
                        : "hover:bg-[var(--color-border-default)]"
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>

        {rows.length === 0 && emptyState ? (
          emptyState
        ) : (
          <div
            role="rowgroup"
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer
              .getVirtualItems()
              .map((item) =>
                renderRow(rows[item.index], item.start, item.index),
              )}
          </div>
        )}
      </div>
    </div>
  );
}
