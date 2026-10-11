import { isMarked, usePageItem, type PageStore } from "@panelyth/renderer-core"
import { TypeGlyph, useInterfaceSizeStore, type InterfaceSize } from "@panelyth/ui"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react"
import { folderPrefix, glyphOf, isMuted } from "../features/format"
import { enter, pageStoreOf, parentRows, rowCount, useListingStore } from "../features/listing"
import { useMarksStore } from "../features/marks"
import { onPanelKey } from "../features/panelKeys"
import type { Side } from "../features/panels"
import { clickRow, focusGrid, ROW_HEIGHT, type FullViewHandle } from "./FullView"
import { panelDnd } from "./panelDnd"
import { RenameField, useRenaming } from "./RenameField"
import { useRightButton } from "./useRightButton"
import { useScrollMemory } from "./useScrollMemory"

/** Fixed column width per interface size; nothing is measured per name (ADR-0028). */
export const BRIEF_COLUMN: Record<InterfaceSize, number> = { small: 180, medium: 200, large: 240 }
/** Whole columns kept mounted on each side of the visible ones. */
export const BRIEF_OVERSCAN = 1

interface BriefViewProps {
  side: Side
  active: boolean
  label: string
}

/**
 * The Brief view (Stage C03, ADR-0028): names only, in fixed-width columns
 * that flow top to bottom and then into the next column. TanStack Virtual
 * virtualizes the columns horizontally; a column holds as many rows as fit
 * the panel's height. ← / → move a column. A listbox for assistive tech.
 */
export const BriefView = forwardRef<FullViewHandle, BriefViewProps>(function BriefView(
  { side, active, label },
  ref,
) {
  const box = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => ({ focus: () => box.current?.focus() }), [])

  const size = useInterfaceSizeStore((s) => s.size)
  const rowHeight = ROW_HEIGHT[size]
  const columnWidth = BRIEF_COLUMN[size]
  const panel = useListingStore((s) => s[side])
  const { cursor, revealToken, query } = panel
  const parent = parentRows(panel)
  const count = rowCount(panel)
  const store = pageStoreOf(side)
  useScrollMemory(
    box,
    side,
    panel.dirId !== null && !panel.branch && !panel.find && !panel.archive ? panel.dirId : null,
    "left",
  )

  // The rows per column follow the panel's height (measured on resize only).
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      setViewport((v) => (v.width === r.width && v.height === r.height ? v : r))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const rows = Math.max(1, Math.floor(viewport.height / rowHeight))
  const columns = Math.ceil(count / rows)
  const visibleColumns = Math.max(1, Math.floor(viewport.width / columnWidth))

  const virtualizer = useVirtualizer({
    horizontal: true,
    count: columns,
    getScrollElement: () => box.current,
    estimateSize: () => columnWidth,
    overscan: BRIEF_OVERSCAN,
  })
  useEffect(() => virtualizer.measure(), [columnWidth, virtualizer])
  const items = virtualizer.getVirtualItems()
  const firstColumn = items[0]?.index ?? 0
  const lastColumn = items.at(-1)?.index ?? -1

  // The page store fetches exactly the mounted columns' entries.
  const queryId = query?.queryId ?? 0
  useEffect(() => {
    pageStoreOf(side).setRange(
      firstColumn * rows - parent,
      Math.min(count, (lastColumn + 1) * rows) - 1 - parent,
    )
  }, [side, firstColumn, lastColumn, rows, count, parent, queryId])

  // Navigation and keyboard moves bring the cursor's column into view.
  useEffect(() => {
    if (count > 0) virtualizer.scrollToIndex(Math.floor(cursor / rows), { align: "auto" })
  }, [cursor, revealToken, count, rows, virtualizer])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    onPanelKey(side, e, {
      count,
      cursor,
      page: Math.max(1, rows * visibleColumns - 1),
      column: rows,
    })
  }

  const rowAt = (e: MouseEvent): number | null => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-row]")
    return el ? Number(el.dataset.row) : null
  }

  const rightButton = useRightButton(side)

  return (
    <div
      ref={box}
      tabIndex={0}
      role="listbox"
      aria-label={label}
      aria-orientation="vertical"
      aria-multiselectable="true"
      aria-activedescendant={count > 0 ? `${side}-row-${cursor}` : undefined}
      data-active={active}
      data-testid={`grid-${side}`}
      data-view="brief"
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        const row = rowAt(e)
        if (row !== null && e.button === 0) clickRow(side, cursor, row, e)
        rightButton.onMouseDown(e)
      }}
      onMouseMove={rightButton.onMouseMove}
      onContextMenu={rightButton.onContextMenu}
      onDoubleClick={(e) => {
        if (rowAt(e) !== null) void enter(side)
      }}
      {...panelDnd(side)}
      className="group relative min-h-0 flex-1 overflow-x-auto overflow-y-hidden bg-canvas text-xs outline-none"
    >
      <div style={{ width: virtualizer.getTotalSize(), height: "100%", position: "relative" }}>
        {items.map((column) => {
          const first = column.index * rows
          const last = Math.min(count, first + rows)
          const cells = []
          for (let index = first; index < last; index++) {
            cells.push(
              <BriefItem
                key={index}
                side={side}
                store={store}
                index={index}
                entry={index - parent}
                left={column.start}
                top={(index - first) * rowHeight}
                width={columnWidth}
                height={rowHeight}
              />,
            )
          }
          return cells
        })}
      </div>
    </div>
  )
})

interface ItemProps {
  side: Side
  store: PageStore
  index: number
  /** Session index; negative for the synthetic "..". */
  entry: number
  left: number
  top: number
  width: number
  height: number
}

const itemClass =
  "absolute flex items-center gap-1.5 truncate pr-2 pl-1 hover:bg-raised data-[marked=true]:text-accent data-[cursor=true]:outline data-[cursor=true]:outline-1 " +
  "data-[cursor=true]:-outline-offset-1 data-[cursor=true]:outline-muted/60 " +
  "group-data-[active=true]:data-[cursor=true]:bg-raised group-data-[active=true]:data-[cursor=true]:outline-accent"

const BriefItem = memo(function BriefItem({
  side,
  store,
  index,
  entry,
  left,
  top,
  width,
  height,
}: ItemProps) {
  const item = usePageItem(store, Math.max(0, entry))
  const shown = entry < 0 ? undefined : item
  const isCursor = useListingStore((s) => s[side].cursor === index)
  const marked = useMarksStore((s) => entry >= 0 && isMarked(s[side], entry, shown?.id))
  const renaming = useRenaming(side, index)
  const panelPath = useListingStore((s) => s[side].path)
  const prefix = shown ? folderPrefix(shown.dirPath, panelPath) : ""
  return (
    <div
      role="option"
      draggable={!renaming && shown !== undefined}
      id={`${side}-row-${index}`}
      data-row={index}
      data-cursor={isCursor}
      data-marked={marked}
      data-id={shown?.id}
      aria-selected={marked}
      className={`${itemClass} ${shown && isMuted(shown) ? "text-muted" : "text-text"}`}
      style={{ left, top, width, height }}
    >
      <span aria-hidden="true" className="w-2 shrink-0 text-center">
        {marked ? "•" : ""}
      </span>
      {entry < 0 ? (
        <>
          <TypeGlyph glyph="up" />
          ..
        </>
      ) : shown && renaming ? (
        <>
          <TypeGlyph glyph={glyphOf(shown)} muted={isMuted(shown)} />
          <RenameField onDone={() => focusGrid(side)} />
        </>
      ) : shown ? (
        <>
          <TypeGlyph glyph={glyphOf(shown)} muted={isMuted(shown)} />
          <span className="truncate">
            {prefix && <span className="text-muted">{prefix}</span>}
            {shown.kind === "dir" ? `[${shown.name}]` : shown.name}
          </span>
        </>
      ) : (
        <span className="block h-2 w-24 rounded-sm bg-skeleton" />
      )}
    </div>
  )
})
