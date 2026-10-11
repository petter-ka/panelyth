import type { ContentItem } from "@panelyth/contracts"
import { isMarked, usePageItem, type PageStore } from "@panelyth/renderer-core"
import {
  Spinner,
  Tooltip,
  TypeGlyph,
  useInterfaceSizeStore,
  type InterfaceSize,
} from "@panelyth/ui"
import {
  columnOrderingFeature,
  columnPinningFeature,
  columnResizingFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  createColumnHelper,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnPinningState,
  type ColumnSizingState,
  type ColumnVisibilityState,
  type Updater,
} from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from "react"
import {
  baseName,
  formatAttrs,
  formatListDate,
  formatSize,
  glyphOf,
  isMuted,
  folderPrefix,
} from "../features/format"
import {
  COLUMN_LIMITS,
  COLUMN_SORT,
  DEFAULT_COLUMNS,
  DEFAULT_COLUMN_LAYOUT,
  enter,
  moveCursor,
  pageStoreOf,
  parentRows,
  readColumnOrder,
  readColumnPinning,
  readColumnVisibility,
  rowCount,
  setColumnLayout,
  setColumns,
  setSort,
  toggleSort,
  useListingStore,
  type ColumnId,
  type ColumnLayout,
  type ColumnPinning,
  type ColumnWidths,
} from "../features/listing"
import { dropAnchor, extendTo, toggleRow, useMarksStore } from "../features/marks"
import { onPanelKey } from "../features/panelKeys"
import type { Side } from "../features/panels"
import { closeQuickSearch } from "../features/quicksearch"
import { useSettingsStore } from "../features/settings"
import { panelDnd } from "./panelDnd"
import { PopupMenu, type MenuEntry } from "./PopupMenu"
import { RenameField, useRenaming } from "./RenameField"
import { useRightButton } from "./useRightButton"
import { useScrollMemory } from "./useScrollMemory"
import { msg, t } from "@panelyth/i18n"

/** Fixed row height per interface size, so no row is ever measured (ADR-0028). */
export const ROW_HEIGHT: Record<InterfaceSize, number> = { small: 20, medium: 22, large: 26 }
export const OVERSCAN = 12

const HEADER_HEIGHT = 24
const GUTTER_WIDTH = 10
const COLUMN_IDS: readonly ColumnId[] = ["name", "ext", "size", "date", "attr"]
const COLUMN_LABEL: Record<ColumnId, string> = {
  name: msg("Name"),
  ext: msg("Ext"),
  size: msg("Size"),
  date: msg("Date"),
  attr: msg("Attr"),
}

// TanStack owns sizing, visibility, ordering, pinning and the sort indicators.
// Its row model holds only the virtual window's indexes; rows read their data
// from the panel page store. Sorting still happens in Go (manualSorting).
const features = tableFeatures({
  columnSizingFeature,
  columnResizingFeature,
  columnOrderingFeature,
  columnVisibilityFeature,
  columnPinningFeature,
  rowSortingFeature,
})

interface WindowRow {
  index: number
  start: number
}

interface RenderColumn {
  id: ColumnId
  size: number
  pin: false | "start" | "end"
  offset: number
}

interface ColumnMenuState {
  id: ColumnId
  left: number
  top: number
}

const helper = createColumnHelper<typeof features, WindowRow>()
const sized = { minSize: COLUMN_LIMITS.min, maxSize: COLUMN_LIMITS.max }
const COLUMNS = helper.columns([
  helper.accessor((r) => r.index, {
    id: "name",
    header: "Name",
    minSize: COLUMN_LIMITS.nameMin,
    maxSize: COLUMN_LIMITS.nameMax,
    enableHiding: false,
  }),
  helper.accessor((r) => r.index, { id: "ext", header: "Ext", ...sized }),
  helper.accessor((r) => r.index, { id: "size", header: "Size", ...sized }),
  helper.accessor((r) => r.index, { id: "date", header: "Date", ...sized }),
  helper.accessor((r) => r.index, { id: "attr", header: "Attr", ...sized }),
])

const RIGHT = new Set<ColumnId>(["size"])
const SECONDARY = new Set<ColumnId>(["size", "date", "attr"])
const MONO = new Set<ColumnId>(["ext", "size", "date", "attr"])

const cellClass = (id: ColumnId, marked = false): string => {
  const alignment = RIGHT.has(id) ? " text-right" : ""
  const secondary = SECONDARY.has(id) ? (marked ? "text-accent" : "text-muted") : ""
  const mono = MONO.has(id) ? " font-mono tabular-nums" : ""
  return `shrink-0 truncate px-1.5${alignment}${secondary ? ` ${secondary}` : ""}${mono}`
}

const columnStyle = (column: RenderColumn, header = false): CSSProperties => ({
  boxSizing: "border-box",
  flex: `0 0 ${column.size}px`,
  width: column.size,
  minWidth: column.size,
  maxWidth: column.size,
  ...(column.pin && {
    position: "sticky",
    [column.pin === "start" ? "left" : "right"]:
      column.offset + (column.pin === "start" ? GUTTER_WIDTH : 0),
    zIndex: header ? 4 : 2,
  }),
})

export interface FullViewHandle {
  focus(): void
}

interface FullViewProps {
  side: Side
  active: boolean
  label: string
}

/** TanStack Table with fixed-height, virtualized rows and configurable columns. */
export const FullView = forwardRef<FullViewHandle, FullViewProps>(function FullView(
  { side, active, label },
  ref,
) {
  const grid = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [columnMenu, setColumnMenu] = useState<ColumnMenuState | null>(null)
  useImperativeHandle(ref, () => ({ focus: () => grid.current?.focus() }), [])

  const size = useInterfaceSizeStore((s) => s.size)
  const rowHeight = ROW_HEIGHT[size]
  const panel = useListingStore((s) => s[side])
  const {
    sort,
    columns,
    columnOrder,
    columnVisibility,
    columnPinning,
    cursor,
    revealToken,
    query,
  } = panel
  const parent = parentRows(panel)
  const count = rowCount(panel)
  const store = pageStoreOf(side)

  const measureViewport = useCallback((): void => {
    const node = body.current
    if (node) setViewportWidth(node.clientWidth)
  }, [])

  // A vertical scrollbar can reduce clientWidth when rows first appear without
  // changing the panel's outer size, so ResizeObserver alone is not sufficient.
  useLayoutEffect(measureViewport, [measureViewport, count])

  useEffect(() => {
    const node = body.current
    if (!node) return
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measureViewport)
    observer.observe(node)
    return () => observer.disconnect()
  }, [measureViewport])

  const otherColumnWidth = COLUMN_IDS.reduce((width, id) => {
    if (id === "name" || !columnVisibility[id]) return width
    return width + (columns[id] ?? 0)
  }, 0)
  const effectiveNameWidth =
    columns.name ??
    Math.min(
      COLUMN_LIMITS.nameMax,
      Math.max(COLUMN_LIMITS.nameMin, viewportWidth - GUTTER_WIDTH - otherColumnWidth),
    )
  const effectiveSizing: ColumnSizingState = { ...columns, name: effectiveNameWidth }

  // TanStack Virtual returns methods that React Compiler cannot safely memoize.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => body.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
  })
  useScrollMemory(
    body,
    side,
    panel.dirId !== null && !panel.branch && !panel.find && !panel.archive ? panel.dirId : null,
    "top",
  )
  useEffect(() => virtualizer.measure(), [rowHeight, virtualizer])
  const items = virtualizer.getVirtualItems()
  const first = items[0]?.index ?? 0
  const last = items.at(-1)?.index ?? -1

  // The page store fetches exactly the window (plus one page either side).
  const queryId = query?.queryId ?? 0
  useEffect(() => {
    pageStoreOf(side).setRange(first - parent, last - parent)
  }, [side, first, last, parent, queryId])

  // Cursor movement scrolls the same virtual body; the sticky header remains visible.
  useEffect(() => {
    if (count > 0) virtualizer.scrollToIndex(cursor, { align: "auto" })
  }, [cursor, revealToken, count, virtualizer])

  const data = useMemo(() => items.map((v) => ({ index: v.index, start: v.start })), [items])
  const onColumnSizingChange = useCallback(
    (updater: Updater<ColumnSizingState>) => {
      const current = useListingStore.getState()[side].columns
      const previous: ColumnSizingState = { ...current, name: effectiveNameWidth }
      const next = typeof updater === "function" ? updater(previous) : updater
      const widths: ColumnWidths = { ...current }
      for (const id of COLUMN_IDS) {
        const value = next[id]
        if (typeof value !== "number" || Math.round(value) === Math.round(previous[id] ?? 0))
          continue
        const min = id === "name" ? COLUMN_LIMITS.nameMin : COLUMN_LIMITS.min
        const max = id === "name" ? COLUMN_LIMITS.nameMax : COLUMN_LIMITS.max
        widths[id] = Math.round(Math.max(min, Math.min(max, value)))
      }
      setColumns(side, widths)
    },
    [side, effectiveNameWidth],
  )

  const updateLayout = useCallback(
    (update: (current: ColumnLayout) => ColumnLayout): void => {
      const current = useListingStore.getState()[side]
      const next = update({
        order: [...current.columnOrder],
        visibility: { ...current.columnVisibility },
        pinning: {
          start: [...current.columnPinning.start],
          end: [...current.columnPinning.end],
        },
      })
      setColumnLayout(side, next)
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
      columnSizing: effectiveSizing,
      columnOrder,
      columnVisibility,
      columnPinning,
    },
    onColumnSizingChange,
    onColumnOrderChange: (updater) =>
      updateLayout((current) => ({
        ...current,
        order: readColumnOrder(typeof updater === "function" ? updater(current.order) : updater),
      })),
    onColumnVisibilityChange: (updater: Updater<ColumnVisibilityState>) =>
      updateLayout((current) => ({
        ...current,
        visibility: readColumnVisibility(
          typeof updater === "function" ? updater(current.visibility) : updater,
        ),
      })),
    onColumnPinningChange: (updater: Updater<ColumnPinningState>) =>
      updateLayout((current) => ({
        ...current,
        pinning: readColumnPinning(
          typeof updater === "function" ? updater(current.pinning) : updater,
        ),
      })),
  })

  const renderColumns: RenderColumn[] = table.getVisibleLeafColumns().map((column) => {
    const pin = column.getIsPinned()
    return {
      id: column.id as ColumnId,
      size: column.getSize(),
      pin,
      offset:
        pin === "start" ? column.getStart("start") : pin === "end" ? column.getAfter("end") : 0,
    }
  })
  const tableWidth = GUTTER_WIDTH + renderColumns.reduce((total, column) => total + column.size, 0)
  const fullWidth = Math.max(viewportWidth, tableWidth)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const viewport = body.current?.getBoundingClientRect().height ?? 0
    const page = Math.max(1, Math.floor(viewport / rowHeight) - 1)
    onPanelKey(side, e, { count, cursor, page, column: 0 })
  }

  const rowAt = (e: MouseEvent): number | null => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-row]")
    return el ? Number(el.dataset.row) : null
  }

  const rightButton = useRightButton(side)
  const onMouseDown = (e: MouseEvent<HTMLElement>): void => {
    const row = rowAt(e)
    if (row !== null && e.button === 0) clickRow(side, cursor, row, e)
    rightButton.onMouseDown(e)
  }

  const fitColumn = (id: ColumnId): void => {
    const nodes = grid.current?.querySelectorAll<HTMLElement>(`[data-column="${id}"]`)
    let fit = t(COLUMN_LABEL[id]).length * 8 + 28
    nodes?.forEach((node) => {
      const text = id === "name" ? node.querySelector<HTMLElement>(".truncate") : null
      fit = Math.max(fit, (text?.scrollWidth ?? node.scrollWidth) + (id === "name" ? 32 : 2))
    })
    const min = id === "name" ? COLUMN_LIMITS.nameMin : COLUMN_LIMITS.min
    const max = id === "name" ? COLUMN_LIMITS.nameMax : COLUMN_LIMITS.max
    setColumns(side, {
      ...useListingStore.getState()[side].columns,
      [id]: Math.round(Math.max(min, Math.min(max, fit))),
    })
  }

  const resetColumnWidth = (id: ColumnId): void => {
    const current = useListingStore.getState()[side].columns
    if (id === "name") {
      const widths = { ...current }
      delete widths.name
      setColumns(side, widths)
    } else setColumns(side, { ...current, [id]: DEFAULT_COLUMNS[id] })
  }

  const reorderWithinRegion = (
    id: ColumnId,
    target: ColumnId,
    pin: false | "start" | "end",
    after = false,
  ): void => {
    updateLayout((current) => {
      const next = {
        ...current,
        order: [...current.order],
        pinning: {
          start: [...current.pinning.start],
          end: [...current.pinning.end],
        },
      }
      const region =
        pin === "start"
          ? next.pinning.start
          : pin === "end"
            ? next.pinning.end
            : next.order.filter(
                (key) => !next.pinning.start.includes(key) && !next.pinning.end.includes(key),
              )
      const from = region.indexOf(id)
      const targetIndex = region.indexOf(target)
      if (from < 0 || targetIndex < 0 || from === targetIndex) return current
      region.splice(from, 1)
      const adjustedTarget = targetIndex - (from < targetIndex ? 1 : 0)
      region.splice(adjustedTarget + (after ? 1 : 0), 0, id)
      if (!pin) {
        next.order = [...next.pinning.start, ...region, ...next.pinning.end]
      } else if (pin === "start") next.pinning.start = region
      else next.pinning.end = region
      return next
    })
  }

  const moveColumn = (id: ColumnId, direction: -1 | 1): void => {
    const at = renderColumns.findIndex((column) => column.id === id)
    const target = renderColumns[at + direction]
    if (target && target.pin === renderColumns[at]?.pin) {
      reorderWithinRegion(id, target.id, target.pin, direction === 1)
    }
  }

  /** Drag in the column menu's list: moves a column before or after another in the layout order. */
  const reorderColumns = (source: string, target: string, after: boolean): void => {
    if (source === target) return
    updateLayout((current) => {
      const order = current.order.filter((key) => key !== source)
      const at = order.indexOf(target as ColumnId)
      if (at < 0 || !COLUMN_IDS.includes(source as ColumnId)) return current
      order.splice(at + (after ? 1 : 0), 0, source as ColumnId)
      return { ...current, order }
    })
  }

  const pinColumn = (id: ColumnId, pin: false | "start" | "end"): void => {
    updateLayout((current) => {
      const next: ColumnPinning = {
        start: current.pinning.start.filter((key) => key !== id),
        end: current.pinning.end.filter((key) => key !== id),
      }
      if (pin === "start") next.start.push(id)
      if (pin === "end") next.end.push(id)
      return { ...current, pinning: next }
    })
  }

  const openColumnMenu = (event: MouseEvent, id: ColumnId): void => {
    event.preventDefault()
    event.stopPropagation() // not the entry menu of the body
    const bounds = grid.current?.getBoundingClientRect()
    if (!bounds) return
    const width = 260
    const maxHeight = Math.min(448, bounds.height * 0.8)
    setColumnMenu({
      id,
      left: Math.max(0, Math.min(event.clientX - bounds.left, bounds.width - width)),
      top: Math.max(0, Math.min(event.clientY - bounds.top, bounds.height - maxHeight)),
    })
  }

  const menuEntries: MenuEntry[] = (() => {
    if (!columnMenu) return []
    const id = columnMenu.id
    const visualIndex = renderColumns.findIndex((column) => column.id === id)
    const column = renderColumns[visualIndex]
    const sorted = sort.field === COLUMN_SORT[id]
    const entries: MenuEntry[] = [
      {
        id: "column-heading",
        label: t("{column} column", { column: t(COLUMN_LABEL[id]) }),
        heading: true,
      },
      {
        id: "fit",
        label: t("Fit to visible rows"),
        detail: t("Double-click edge"),
        onSelect: () => fitColumn(id),
      },
      { id: "reset-width", label: t("Reset column width"), onSelect: () => resetColumnWidth(id) },
      { id: "sort-heading", label: t("Sort"), heading: true },
      {
        id: "sort-asc",
        label: t("Sort ascending"),
        current: sorted && sort.direction === "asc",
        onSelect: () => setSort(side, { field: COLUMN_SORT[id], direction: "asc" }),
      },
      {
        id: "sort-desc",
        label: t("Sort descending"),
        current: sorted && sort.direction === "desc",
        onSelect: () => setSort(side, { field: COLUMN_SORT[id], direction: "desc" }),
      },
      { id: "layout-heading", label: t("Column layout"), heading: true },
      {
        id: "move-left",
        label: t("Move left"),
        disabled: visualIndex <= 0 || renderColumns[visualIndex - 1]?.pin !== column?.pin,
        onSelect: () => moveColumn(id, -1),
      },
      {
        id: "move-right",
        label: t("Move right"),
        disabled:
          visualIndex < 0 ||
          visualIndex >= renderColumns.length - 1 ||
          renderColumns[visualIndex + 1]?.pin !== column?.pin,
        onSelect: () => moveColumn(id, 1),
      },
      {
        id: "pin-start",
        label: t("Pin to start"),
        current: column?.pin === "start",
        onSelect: () => pinColumn(id, "start"),
      },
      {
        id: "pin-end",
        label: t("Pin to end"),
        current: column?.pin === "end",
        onSelect: () => pinColumn(id, "end"),
      },
      ...(column?.pin
        ? [{ id: "unpin", label: t("Unpin column"), onSelect: () => pinColumn(id, false) }]
        : []),
      { id: "columns-heading", label: t("Show columns (drag to reorder)"), heading: true },
      ...columnOrder.map((columnId) => ({
        id: `visible-${columnId}`,
        dragId: columnId,
        label: t(COLUMN_LABEL[columnId]),
        checked: columnVisibility[columnId],
        disabled: columnId === "name",
        keepOpen: true,
        onSelect: () => {
          if (columnId === "name") return
          updateLayout((current) => ({
            ...current,
            visibility: { ...current.visibility, [columnId]: !current.visibility[columnId] },
          }))
        },
      })),
      {
        id: "hide",
        label: t("Hide {column}", { column: t(COLUMN_LABEL[id]) }),
        disabled: id === "name",
        onSelect: () =>
          updateLayout((current) => ({
            ...current,
            visibility: { ...current.visibility, [id]: false },
          })),
      },
      {
        id: "reset-layout",
        label: t("Reset all columns"),
        onSelect: () => {
          setColumns(side, { ...DEFAULT_COLUMNS })
          setColumnLayout(side, {
            order: [...DEFAULT_COLUMN_LAYOUT.order],
            visibility: { ...DEFAULT_COLUMN_LAYOUT.visibility },
            pinning: { start: [], end: [] },
          })
        },
      },
    ]
    return entries
  })()

  return (
    <div
      ref={grid}
      tabIndex={0}
      role="grid"
      aria-label={label}
      aria-rowcount={count + 1}
      aria-multiselectable="true"
      aria-activedescendant={count > 0 ? `${side}-row-${cursor}` : undefined}
      data-active={active}
      data-testid={`grid-${side}`}
      onKeyDown={onKeyDown}
      className="group relative flex min-h-0 flex-1 flex-col bg-canvas text-xs outline-none"
    >
      <div
        ref={body}
        className="relative min-h-0 flex-1 overflow-auto"
        onMouseDown={onMouseDown}
        onMouseMove={rightButton.onMouseMove}
        onContextMenu={rightButton.onContextMenu}
        onDoubleClick={(e) => {
          if (rowAt(e) !== null) void enter(side)
        }}
        {...panelDnd(side)}
      >
        <div
          style={{
            height: HEADER_HEIGHT + virtualizer.getTotalSize(),
            width: fullWidth,
            minWidth: tableWidth,
            position: "relative",
          }}
        >
          <div
            role="row"
            className="sticky top-0 z-10 flex h-6 select-none border-b border-border bg-chrome text-muted"
            style={{ width: fullWidth }}
          >
            <div aria-hidden="true" className="sticky left-0 z-10 w-2.5 shrink-0 bg-chrome" />
            {renderColumns.map((renderColumn) => {
              const id = renderColumn.id
              const column = table.getColumn(id)
              const header = table.getFlatHeaders().find((item) => item.column.id === id)
              const sorted = column?.getIsSorted() ?? false
              return (
                <Tooltip
                  key={id}
                  content={t(
                    "Right-click for column options and order. Drag the edge to resize; double-click to fit visible cells.",
                  )}
                >
                  <div
                    role="columnheader"
                    aria-sort={sorted ? (sorted === "asc" ? "ascending" : "descending") : "none"}
                    data-column={id}
                    data-column-header={id}
                    onContextMenu={(event) => openColumnMenu(event, id)}
                    style={columnStyle(renderColumn, true)}
                    className={`relative flex shrink-0 items-center ${renderColumn.pin ? "bg-chrome" : ""}`}
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => toggleSort(side, COLUMN_SORT[id])}
                      className={`flex h-full w-full items-center gap-1 px-1.5 hover:text-text ${RIGHT.has(id) ? "justify-end" : ""} ${sorted ? "text-text" : ""}`}
                    >
                      {t(COLUMN_LABEL[id])}
                      {sorted && <span aria-hidden="true">{sorted === "asc" ? "↑" : "↓"}</span>}
                    </button>
                    <div
                      aria-hidden="true"
                      data-testid={`resize-${id}`}
                      onMouseDown={(event) => {
                        event.stopPropagation()
                        header?.getResizeHandler()(event)
                      }}
                      onTouchStart={(event) => {
                        event.stopPropagation()
                        header?.getResizeHandler()(event)
                      }}
                      onDoubleClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        fitColumn(id)
                      }}
                      className="absolute top-0 right-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-accent"
                    />
                  </div>
                </Tooltip>
              )
            })}
          </div>
          <div
            style={{
              position: "absolute",
              top: HEADER_HEIGHT,
              left: 0,
              width: fullWidth,
              height: virtualizer.getTotalSize(),
            }}
          >
            {table.getRowModel().rows.map((row) => {
              const { index, start } = row.original
              return index < parent ? (
                <ParentRow
                  key={index}
                  side={side}
                  store={store}
                  index={index}
                  top={start}
                  height={rowHeight}
                  width={fullWidth}
                  columns={renderColumns}
                />
              ) : (
                <EntryRow
                  key={index}
                  side={side}
                  store={store}
                  index={index}
                  entry={index - parent}
                  top={start}
                  height={rowHeight}
                  width={fullWidth}
                  columns={renderColumns}
                />
              )
            })}
          </div>
        </div>
      </div>
      {columnMenu && (
        <PopupMenu
          label={t("{column} column options", { column: t(COLUMN_LABEL[columnMenu.id]) })}
          testId={`column-menu-${side}`}
          entries={menuEntries}
          onReorder={reorderColumns}
          onClose={() => setColumnMenu(null)}
          style={{ left: columnMenu.left, top: columnMenu.top }}
        />
      )}
    </div>
  )
})

interface RowProps {
  side: Side
  /** The panel's page store; it changes when the panels swap (Ctrl+U). */
  store: PageStore
  index: number
  top: number
  height: number
  width: number
  columns: readonly RenderColumn[]
}

// Marks retain an accent glyph; hover and the cursor use a light raised surface.
const rowClass =
  "absolute left-0 flex items-center hover:bg-raised data-[marked=true]:text-accent data-[cursor=true]:outline data-[cursor=true]:outline-1 " +
  "data-[cursor=true]:-outline-offset-1 data-[cursor=true]:outline-muted/60 " +
  "group-data-[active=true]:data-[cursor=true]:bg-raised group-data-[active=true]:data-[cursor=true]:outline-accent"

const useIsCursor = (side: Side, index: number): boolean =>
  useListingStore((s) => s[side].cursor === index)

/** The synthetic ".." row; never part of the session. */
const ParentRow = memo(function ParentRow({ side, index, top, height, width, columns }: RowProps) {
  const isCursor = useIsCursor(side, index)
  return (
    <div
      role="row"
      id={`${side}-row-${index}`}
      data-row={index}
      data-cursor={isCursor}
      aria-selected={false}
      className={rowClass}
      style={{ top, height, width, minWidth: width }}
    >
      <span aria-hidden="true" className="sticky left-0 z-[3] w-2.5 shrink-0" />
      {columns.map((column) => (
        <span
          key={column.id}
          role="gridcell"
          data-column={column.id}
          style={columnStyle(column)}
          className={
            column.id === "name"
              ? "flex items-center gap-1.5 truncate px-1.5"
              : cellClass(column.id)
          }
        >
          {column.id === "name" ? (
            <>
              <TypeGlyph glyph="up" />
              ..
            </>
          ) : column.id === "size" ? (
            "<DIR>"
          ) : null}
        </span>
      ))}
    </div>
  )
})

const EntryRow = memo(function EntryRow({
  side,
  index,
  entry,
  top,
  height,
  width,
  columns,
  store,
}: RowProps & { entry: number }) {
  const item = usePageItem(store, entry)
  const isCursor = useIsCursor(side, index)
  const marked = useMarksStore((s) => isMarked(s[side], entry, item?.id))
  const renaming = useRenaming(side, index)
  return (
    <div
      role="row"
      id={`${side}-row-${index}`}
      data-row={index}
      data-cursor={isCursor}
      data-marked={marked}
      data-id={item?.id}
      aria-selected={marked}
      draggable={!renaming && item !== undefined}
      className={`${rowClass} ${item && isMuted(item) ? "text-muted" : "text-text"}`}
      style={{ top, height, width, minWidth: width }}
    >
      <span aria-hidden="true" className="sticky left-0 z-[3] w-2.5 shrink-0 text-center">
        {marked ? "•" : ""}
      </span>
      {item ? (
        <Cells item={item} marked={marked} columns={columns} renaming={renaming} side={side} />
      ) : (
        <Placeholder columns={columns} />
      )}
    </div>
  )
})

/** Keys go back to the panel after an inline edit. */
export const focusGrid = (side: Side): void =>
  document.querySelector<HTMLElement>(`[data-testid="grid-${side}"]`)?.focus()

function Cells({
  item,
  marked,
  columns,
  renaming,
  side,
}: {
  item: ContentItem
  marked: boolean
  columns: readonly RenderColumn[]
  renaming: boolean
  side: Side
}) {
  const { sizeFormat, dateFormat } = useSettingsStore((s) => s.settings)
  const panelPath = useListingStore((s) => s[side].path)
  // Enter on this folder or archive is still being answered (a slow drive).
  const opening = useListingStore((s) => s[side].loading && s[side].loadingTarget === item.id)
  const prefix = folderPrefix(item.dirPath, panelPath)
  return (
    <>
      {columns.map((column) => (
        <span
          key={column.id}
          role="gridcell"
          data-column={column.id}
          style={columnStyle(column)}
          className={
            column.id === "name"
              ? "flex items-center gap-1.5 truncate px-1.5"
              : cellClass(column.id, marked)
          }
        >
          {column.id === "name" ? (
            <>
              {opening ? (
                <Spinner size={16} />
              ) : (
                <TypeGlyph glyph={glyphOf(item)} muted={isMuted(item)} />
              )}
              {renaming ? (
                <RenameField onDone={() => focusGrid(side)} />
              ) : (
                <span className="truncate">
                  {prefix && <span className="text-muted">{prefix}</span>}
                  {baseName(item)}
                </span>
              )}
            </>
          ) : column.id === "ext" ? (
            item.kind === "dir" ? (
              ""
            ) : (
              item.ext
            )
          ) : column.id === "size" ? (
            formatSize(item, sizeFormat)
          ) : column.id === "date" ? (
            formatListDate(item.modifiedMs, dateFormat)
          ) : (
            formatAttrs(item.attrs)
          )}
        </span>
      ))}
    </>
  )
}

function Placeholder({ columns }: { columns: readonly RenderColumn[] }) {
  return (
    <>
      {columns.map((column) => (
        <span
          key={column.id}
          role="gridcell"
          data-column={column.id}
          style={columnStyle(column)}
          className={column.id === "name" ? "px-1.5" : cellClass(column.id)}
        >
          {column.id === "name" && <span className="block h-2 w-32 rounded-sm bg-skeleton" />}
        </span>
      ))}
    </>
  )
}

/** Click moves the cursor; Ctrl+click toggles a mark; Shift+click marks a range. */
export function clickRow(
  side: Side,
  cursor: number,
  row: number,
  e: Pick<MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">,
): void {
  closeQuickSearch()
  if (e.ctrlKey || e.metaKey) void toggleRow(side, row)
  else if (e.shiftKey) extendTo(side, cursor, row)
  else dropAnchor(side)
  moveCursor(side, row)
}
