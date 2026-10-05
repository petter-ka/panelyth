import type { ContentItem } from "@fastview/contracts"
import { usePageItem } from "@fastview/renderer-core"
import { useInterfaceSizeStore, type InterfaceSize } from "@fastview/ui"
import {
  columnResizingFeature,
  columnSizingFeature,
  createColumnHelper,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnSizingState,
  type Updater,
} from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from "react"
import { baseName, formatAttrs, formatDate, formatSize, glyphOf, isMuted } from "../features/format"
import {
  COLUMN_LIMITS,
  COLUMN_SORT,
  enter,
  goUp,
  moveCursor,
  pageStoreOf,
  parentRows,
  refresh,
  rowCount,
  setColumns,
  toggleHidden,
  toggleSort,
  useListingStore,
  type ColumnId,
  type ColumnWidths,
} from "../features/listing"
import type { Side } from "../features/panels"
import { TypeGlyph } from "./TypeGlyph"

/** Fixed row height per interface size, so no row is ever measured (ADR-0028). */
export const ROW_HEIGHT: Record<InterfaceSize, number> = { small: 20, medium: 22, large: 26 }
export const OVERSCAN = 12

// TanStack Table owns the columns, headers, sort indicators and sizing; its
// row model holds only the visible window (row indexes), and rows read their
// entries from the panel's page store. Go sorts (manualSorting).
const features = tableFeatures({ columnSizingFeature, columnResizingFeature, rowSortingFeature })

interface WindowRow {
  index: number
  start: number
}

const helper = createColumnHelper<typeof features, WindowRow>()
const sized = { minSize: COLUMN_LIMITS.min, maxSize: COLUMN_LIMITS.max }
const COLUMNS = helper.columns([
  helper.accessor((r) => r.index, { id: "name", header: "Name", enableResizing: false }),
  helper.accessor((r) => r.index, { id: "ext", header: "Ext", ...sized }),
  helper.accessor((r) => r.index, { id: "size", header: "Size", ...sized }),
  helper.accessor((r) => r.index, { id: "date", header: "Date", ...sized }),
  helper.accessor((r) => r.index, { id: "attr", header: "Attr", ...sized }),
])

// Cell widths come from CSS variables on the grid, so resizing a column
// re-renders the header only, never the rows.
const CELL: Record<ColumnId, CSSProperties> = {
  name: { flex: "1 1 0", minWidth: 0 },
  ext: { width: "var(--col-ext)" },
  size: { width: "var(--col-size)" },
  date: { width: "var(--col-date)" },
  attr: { width: "var(--col-attr)" },
}
const RIGHT = new Set<ColumnId>(["size"])

const cellClass = (id: ColumnId): string =>
  `shrink-0 truncate px-1.5 ${RIGHT.has(id) ? "text-right" : ""}`

export interface FullViewHandle {
  focus(): void
}

interface FullViewProps {
  side: Side
  active: boolean
  label: string
}

/** The Full view (ADR-0028): TanStack Table with TanStack Virtual rows of fixed height. */
export const FullView = forwardRef<FullViewHandle, FullViewProps>(function FullView(
  { side, active, label },
  ref,
) {
  const grid = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => ({ focus: () => grid.current?.focus() }), [])

  const size = useInterfaceSizeStore((s) => s.size)
  const rowHeight = ROW_HEIGHT[size]
  const panel = useListingStore((s) => s[side])
  const { sort, columns, cursor, revealToken, query } = panel
  const parent = parentRows(panel)
  const count = rowCount(panel)

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => body.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
  })
  useEffect(() => virtualizer.measure(), [rowHeight, virtualizer])
  const items = virtualizer.getVirtualItems()
  const first = items[0]?.index ?? 0
  const last = items.at(-1)?.index ?? -1

  // The page store fetches exactly the window (plus one page either side).
  const queryId = query?.queryId ?? 0
  useEffect(() => {
    pageStoreOf(side).setRange(first - parent, last - parent)
  }, [side, first, last, parent, queryId])

  // Navigation, sort and keyboard moves bring the cursor into view.
  useEffect(() => {
    if (count > 0) virtualizer.scrollToIndex(cursor, { align: "auto" })
  }, [cursor, revealToken, count, virtualizer])

  const data = useMemo(() => items.map((v) => ({ index: v.index, start: v.start })), [items])
  const onColumnSizingChange = useCallback(
    (updater: Updater<ColumnSizingState>) => {
      const current = useListingStore.getState()[side].columns
      const next = typeof updater === "function" ? updater(current) : updater
      const widths = { ...current }
      for (const key of Object.keys(widths) as (keyof ColumnWidths)[]) {
        const w = next[key]
        if (typeof w === "number") {
          widths[key] = Math.round(Math.max(COLUMN_LIMITS.min, Math.min(COLUMN_LIMITS.max, w)))
        }
      }
      setColumns(side, widths)
    },
    [side],
  )
  const sortedColumn = (Object.keys(COLUMN_SORT) as ColumnId[]).find(
    (id) => COLUMN_SORT[id] === sort.field,
  )
  const table = useTable({
    features,
    columns: COLUMNS,
    data,
    getRowId: (row) => String(row.index),
    manualSorting: true,
    enableMultiSort: false,
    columnResizeMode: "onChange",
    state: {
      sorting: sortedColumn ? [{ id: sortedColumn, desc: sort.direction === "desc" }] : [],
      columnSizing: columns,
    },
    onColumnSizingChange,
  })

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const ctrl = e.ctrlKey || e.metaKey
    const viewport = body.current?.getBoundingClientRect().height ?? 0
    const pageRows = Math.max(1, Math.floor(viewport / rowHeight) - 1)
    const sortKeys: Record<string, ColumnId> = { F3: "name", F4: "ext", F5: "date", F6: "size" }
    let handled = true
    if (ctrl && !e.altKey && !e.shiftKey && sortKeys[e.key]) {
      toggleSort(side, COLUMN_SORT[sortKeys[e.key]!])
    } else if (ctrl && e.key === "PageUp") void goUp(side)
    else if (ctrl && !e.shiftKey && e.key.toLowerCase() === "h") toggleHidden(side)
    else if (ctrl && !e.shiftKey && e.key.toLowerCase() === "r") void refresh(side)
    else if (e.altKey || ctrl || e.shiftKey) handled = false
    else if (e.key === "ArrowDown") moveCursor(side, cursor + 1)
    else if (e.key === "ArrowUp") moveCursor(side, cursor - 1)
    else if (e.key === "PageDown") moveCursor(side, cursor + pageRows)
    else if (e.key === "PageUp") moveCursor(side, cursor - pageRows)
    else if (e.key === "Home") moveCursor(side, 0)
    else if (e.key === "End") moveCursor(side, count - 1)
    else if (e.key === "Enter") void enter(side)
    else if (e.key === "Backspace") void goUp(side)
    else handled = false
    if (handled) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  const rowAt = (e: MouseEvent): number | null => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-row]")
    return el ? Number(el.dataset.row) : null
  }

  const style = {
    "--col-ext": `${columns.ext}px`,
    "--col-size": `${columns.size}px`,
    "--col-date": `${columns.date}px`,
    "--col-attr": `${columns.attr}px`,
  } as CSSProperties

  return (
    <div
      ref={grid}
      tabIndex={0}
      role="grid"
      aria-label={label}
      aria-rowcount={count + 1}
      aria-activedescendant={count > 0 ? `${side}-row-${cursor}` : undefined}
      data-active={active}
      data-testid={`grid-${side}`}
      onKeyDown={onKeyDown}
      style={style}
      className="group flex min-h-0 flex-1 flex-col bg-canvas text-xs outline-none"
    >
      <div
        role="row"
        className="flex h-6 shrink-0 select-none border-b border-border bg-chrome text-muted"
      >
        {table.getHeaderGroups()[0]?.headers.map((header) => {
          const id = header.column.id as ColumnId
          const sorted = header.column.getIsSorted()
          return (
            <div
              key={id}
              role="columnheader"
              aria-sort={sorted ? (sorted === "asc" ? "ascending" : "descending") : "none"}
              style={CELL[id]}
              className="relative flex shrink-0 items-center"
            >
              <button
                type="button"
                tabIndex={-1}
                onClick={() => toggleSort(side, COLUMN_SORT[id])}
                className={`flex h-full w-full items-center gap-1 px-1.5 hover:text-text ${RIGHT.has(id) ? "justify-end" : ""} ${sorted ? "text-text" : ""}`}
              >
                {String(header.column.columnDef.header)}
                {sorted && <span aria-hidden="true">{sorted === "asc" ? "↑" : "↓"}</span>}
              </button>
              {header.column.getCanResize() && (
                <div
                  aria-hidden="true"
                  data-testid={`resize-${id}`}
                  onMouseDown={header.getResizeHandler()}
                  onTouchStart={header.getResizeHandler()}
                  onDoubleClick={() => header.column.resetSize()}
                  className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-accent"
                />
              )}
            </div>
          )
        })}
      </div>
      <div
        ref={body}
        className="relative min-h-0 flex-1 overflow-auto tabular-nums"
        onMouseDown={(e) => {
          const index = rowAt(e)
          if (index !== null) moveCursor(side, index)
        }}
        onDoubleClick={(e) => {
          if (rowAt(e) !== null) void enter(side)
        }}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {table.getRowModel().rows.map((row) => {
            const { index, start } = row.original
            return index < parent ? (
              <ParentRow key={index} side={side} index={index} top={start} height={rowHeight} />
            ) : (
              <EntryRow
                key={index}
                side={side}
                index={index}
                entry={index - parent}
                top={start}
                height={rowHeight}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
})

interface RowProps {
  side: Side
  index: number
  top: number
  height: number
}

const rowClass =
  "absolute left-0 flex w-full items-center data-[cursor=true]:outline data-[cursor=true]:outline-1 " +
  "data-[cursor=true]:-outline-offset-1 data-[cursor=true]:outline-muted/60 " +
  "group-data-[active=true]:data-[cursor=true]:bg-raised group-data-[active=true]:data-[cursor=true]:outline-accent"

const useIsCursor = (side: Side, index: number): boolean =>
  useListingStore((s) => s[side].cursor === index)

/** The synthetic ".." row; never part of the session. */
const ParentRow = memo(function ParentRow({ side, index, top, height }: RowProps) {
  const isCursor = useIsCursor(side, index)
  return (
    <div
      role="row"
      id={`${side}-row-${index}`}
      data-row={index}
      data-cursor={isCursor}
      aria-selected={isCursor}
      className={rowClass}
      style={{ top, height }}
    >
      <span role="gridcell" style={CELL.name} className="flex items-center gap-1.5 truncate px-1.5">
        <TypeGlyph glyph="up" />
        ..
      </span>
      <span role="gridcell" style={CELL.ext} className={cellClass("ext")} />
      <span role="gridcell" style={CELL.size} className={cellClass("size")}>
        &lt;DIR&gt;
      </span>
      <span role="gridcell" style={CELL.date} className={cellClass("date")} />
      <span role="gridcell" style={CELL.attr} className={cellClass("attr")} />
    </div>
  )
})

const EntryRow = memo(function EntryRow({
  side,
  index,
  entry,
  top,
  height,
}: RowProps & { entry: number }) {
  const item = usePageItem(pageStoreOf(side), entry)
  const isCursor = useIsCursor(side, index)
  return (
    <div
      role="row"
      id={`${side}-row-${index}`}
      data-row={index}
      data-cursor={isCursor}
      data-id={item?.id}
      aria-selected={isCursor}
      className={`${rowClass} ${item && isMuted(item) ? "text-muted" : "text-text"}`}
      style={{ top, height }}
    >
      {item ? <Cells item={item} /> : <Placeholder />}
    </div>
  )
})

function Cells({ item }: { item: ContentItem }) {
  return (
    <>
      <span role="gridcell" style={CELL.name} className="flex items-center gap-1.5 px-1.5">
        <TypeGlyph glyph={glyphOf(item)} />
        <span className="truncate">{baseName(item)}</span>
      </span>
      <span role="gridcell" style={CELL.ext} className={cellClass("ext")}>
        {item.kind === "dir" ? "" : item.ext}
      </span>
      <span role="gridcell" style={CELL.size} className={cellClass("size")}>
        {formatSize(item)}
      </span>
      <span role="gridcell" style={CELL.date} className={cellClass("date")}>
        {formatDate(item.modifiedMs)}
      </span>
      <span role="gridcell" style={CELL.attr} className={`${cellClass("attr")} font-mono`}>
        {formatAttrs(item.attrs)}
      </span>
    </>
  )
}

function Placeholder() {
  return (
    <span role="gridcell" style={CELL.name} className="px-1.5">
      <span className="block h-2 w-32 rounded-sm bg-skeleton" />
    </span>
  )
}
