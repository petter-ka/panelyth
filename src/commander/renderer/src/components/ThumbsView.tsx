import type { ContentItem, PreviewPriority } from "@panelyth/contracts"
import {
  CONTENT_PADDING,
  profileFor,
  rowCount as tileRows,
  rowHeight as tileRowHeight,
  TILE_METRICS,
  TILE_SIZE_ORDER,
  tilesPerRow,
  TileThumb,
  type ThumbRequest,
  type ThumbStore,
  type TileSize,
} from "@panelyth/media-ui"
import { isMarked, usePageItem, type PageStore } from "@panelyth/renderer-core"
import {
  createWheelStepper,
  INTERFACE_SIZE_SCALE,
  Spinner,
  TypeGlyph,
  useInterfaceSizeStore,
  WHEEL_NOTCH_PX,
} from "@panelyth/ui"
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
import { updateSettings, useSettingsStore } from "../features/settings"
import { thumbsOf } from "../features/thumbs"
import { clickRow, focusGrid, type FullViewHandle } from "./FullView"
import { panelDnd } from "./panelDnd"
import { RenameField, useRenaming } from "./RenameField"
import { useRightButton } from "./useRightButton"
import { useScrollMemory } from "./useScrollMemory"

/** Pause after scrolling before thumbnails are requested (fast scrolls request nothing). */
const SETTLE_MS = 80
/** Rows of tiles kept mounted above and below the visible ones. */
export const THUMBS_OVERSCAN_ROWS = 2

interface ThumbsViewProps {
  side: Side
  active: boolean
  label: string
}

function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1)
  useEffect(() => {
    // Moving the window to another monitor changes the ratio.
    const media = window.matchMedia?.(`(resolution: ${dpr}dppx)`)
    const onChange = (): void => setDpr(window.devicePixelRatio || 1)
    media?.addEventListener("change", onChange)
    return () => media?.removeEventListener("change", onChange)
  }, [dpr])
  return dpr
}

/**
 * The Thumbnails view (Stage C10, ADR-0028): the panel's entries as tiles of
 * a fixed size, flowing left to right. The geometry, the thumbnail store and
 * the preview frame are the viewer's (@panelyth/media-ui), on the shared
 * preview cache; the cursor and the marks are the commander's, as in the
 * other views. Rows of tiles are virtualized, so the mounted DOM depends on
 * the panel's size, never on the folder's.
 */
export const ThumbsView = forwardRef<FullViewHandle, ThumbsViewProps>(function ThumbsView(
  { side, active, label },
  ref,
) {
  const box = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => ({ focus: () => box.current?.focus() }), [])

  const size = useSettingsStore((s) => s.settings.thumbSize)
  const scale = INTERFACE_SIZE_SCALE[useInterfaceSizeStore((s) => s.size)]
  const dpr = useDevicePixelRatio()
  const panel = useListingStore((s) => s[side])
  const { cursor, revealToken, query } = panel
  const parent = parentRows(panel)
  const count = rowCount(panel)
  const store = pageStoreOf(side)
  const thumbs = thumbsOf(side)

  // One ResizeObserver measures the panel's width; nothing is measured per tile.
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = (): void => setWidth(el.clientWidth || el.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const perRow = width > 0 ? tilesPerRow(width, size, scale) : 1
  const rows = tileRows(count, perRow)
  const height = tileRowHeight(size, scale)

  // The profile follows tile size × pixel density; pages then bring matching thumbnails.
  useEffect(() => thumbs.setProfile(profileFor(size, dpr)), [thumbs, size, dpr])

  // TanStack Virtual returns methods that React Compiler cannot safely memoize.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => box.current,
    estimateSize: () => height,
    overscan: THUMBS_OVERSCAN_ROWS,
    paddingStart: CONTENT_PADDING * scale,
    paddingEnd: CONTENT_PADDING * scale,
    useFlushSync: false,
  })
  useScrollMemory(
    box,
    side,
    panel.dirId !== null && !panel.branch && !panel.find && !panel.archive && !panel.remote
      ? panel.dirId
      : null,
    "top",
  )
  useEffect(() => virtualizer.measure(), [virtualizer, height])

  const items = virtualizer.getVirtualItems()
  const firstRow = items[0]?.index ?? 0
  const lastRow = items.at(-1)?.index ?? -1
  const offset = virtualizer.scrollOffset ?? 0
  const viewport = virtualizer.scrollRect?.height ?? 0
  const visible = items.filter((r) => r.end > offset && r.start < offset + viewport)
  const firstVisibleRow = visible[0]?.index ?? firstRow
  const lastVisibleRow = visible.at(-1)?.index ?? lastRow

  // The page store fetches exactly the mounted rows' entries.
  const queryId = query?.queryId ?? 0
  useEffect(() => {
    if (lastRow < 0) return
    pageStoreOf(side).setRange(
      firstRow * perRow - parent,
      Math.min(count, (lastRow + 1) * perRow) - 1 - parent,
    )
  }, [side, firstRow, lastRow, perRow, count, parent, queryId])

  // Navigation and keyboard moves bring the cursor's row into view.
  useEffect(() => {
    if (count > 0) virtualizer.scrollToIndex(Math.floor(cursor / perRow), { align: "auto" })
  }, [cursor, revealToken, count, perRow, virtualizer])

  // Thumbnails only for a settled range: visible first, then the overscan,
  // then the next screen in the scroll direction. One call per settled range.
  const [loadTick, setLoadTick] = useState(0)
  useEffect(() => store.onPagesLoaded(() => setLoadTick((n) => n + 1)), [store])
  const lastOffset = useRef(0)
  const scrolling = virtualizer.isScrolling
  const scrolledSinceRequest = useRef(false)
  useEffect(() => {
    if (scrolling) scrolledSinceRequest.current = true
  }, [scrolling])
  useEffect(() => {
    if (scrolling || lastRow < 0) return
    const direction = offset >= lastOffset.current ? 1 : -1
    lastOffset.current = offset
    const delay = scrolledSinceRequest.current ? SETTLE_MS : 0
    const timer = setTimeout(() => {
      scrolledSinceRequest.current = false
      const wanted: ThumbRequest[] = []
      const add = (rowA: number, rowB: number, priority: PreviewPriority): void => {
        const from = Math.max(0, rowA) * perRow
        const to = Math.min(count, (rowB + 1) * perRow)
        for (let i = from; i < to; i++) {
          const item = i - parent >= 0 ? store.getItem(i - parent) : undefined
          // Only pictures and videos have previews; other files show their type.
          if (item && (item.kind === "image" || item.kind === "video")) {
            wanted.push({ item, priority })
          }
        }
      }
      const screenRows = lastVisibleRow - firstVisibleRow + 1
      add(firstVisibleRow, lastVisibleRow, 0)
      add(firstRow, firstVisibleRow - 1, 1)
      add(lastVisibleRow + 1, lastRow, 1)
      if (direction > 0) add(lastRow + 1, lastRow + screenRows, 2)
      else add(firstRow - screenRows, firstRow - 1, 2)
      void thumbs.requestVisible(wanted).catch(() => undefined)
    }, delay)
    return () => clearTimeout(timer)
    // offset is sampled when the range settles; scrolling itself must not retrigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    scrolling,
    firstRow,
    lastRow,
    firstVisibleRow,
    lastVisibleRow,
    perRow,
    count,
    parent,
    queryId,
    loadTick,
    size,
    dpr,
  ])

  // Ctrl/Cmd + wheel steps the tile size (non-passive to prevent page zoom).
  useEffect(() => {
    const el = box.current
    if (!el) return
    // As in the viewer's tile view: a pinch changes the size by its distance.
    const sizeStep = createWheelStepper({ stepPx: WHEEL_NOTCH_PX / 2 })
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const direction = sizeStep(e)
      if (direction === 0) return
      const now = useSettingsStore.getState().settings.thumbSize
      const next =
        TILE_SIZE_ORDER[
          Math.min(
            TILE_SIZE_ORDER.length - 1,
            Math.max(0, TILE_SIZE_ORDER.indexOf(now) + (direction < 0 ? 1 : -1)),
          )
        ]!
      if (next !== now) updateSettings({ thumbSize: next })
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    onPanelKey(side, e, {
      count,
      cursor,
      page: Math.max(1, lastVisibleRow - firstVisibleRow) * perRow,
      column: 1,
      row: perRow,
    })
  }

  const rowAt = (e: MouseEvent): number | null => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-row]")
    return el ? Number(el.dataset.row) : null
  }

  const rightButton = useRightButton(side)
  const m = TILE_METRICS[size]

  return (
    <div
      ref={box}
      tabIndex={0}
      role="listbox"
      aria-label={label}
      aria-orientation="horizontal"
      aria-multiselectable="true"
      aria-activedescendant={count > 0 ? `${side}-row-${cursor}` : undefined}
      data-active={active}
      data-testid={`grid-${side}`}
      data-view="thumbs"
      data-per-row={perRow}
      data-tile-size={size}
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
      className="group relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto bg-canvas text-xs outline-none select-none"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((row) => {
          const first = row.index * perRow
          const last = Math.min(count, first + perRow)
          const tiles = []
          for (let index = first; index < last; index++) {
            tiles.push(
              <ThumbTile
                key={index}
                side={side}
                store={store}
                thumbs={thumbs}
                index={index}
                entry={index - parent}
                size={size}
              />,
            )
          }
          return (
            <div
              key={row.key}
              role="presentation"
              className="absolute top-0 left-0 flex w-full"
              style={{
                height,
                transform: `translateY(${row.start}px)`,
                gap: m.gap * scale,
                paddingLeft: CONTENT_PADDING * scale,
                paddingRight: CONTENT_PADDING * scale,
              }}
            >
              {tiles}
            </div>
          )
        })}
      </div>
    </div>
  )
})

interface TileProps {
  side: Side
  store: PageStore
  thumbs: ThumbStore
  index: number
  /** Session index; negative for the synthetic "..". */
  entry: number
  size: TileSize
}

const tileClass =
  "flex shrink-0 flex-col rounded-[3px] [contain:layout_paint] hover:bg-raised/60 " +
  "data-[cursor=true]:outline data-[cursor=true]:outline-1 data-[cursor=true]:-outline-offset-1 " +
  "data-[cursor=true]:outline-muted/60 group-data-[active=true]:data-[cursor=true]:bg-raised " +
  "group-data-[active=true]:data-[cursor=true]:outline-accent"

/**
 * One tile: a fixed square slot plus one name line, so nothing reflows when
 * a thumbnail arrives. It subscribes to its own page item, thumbnail, cursor
 * and mark only.
 */
const ThumbTile = memo(function ThumbTile({ side, store, thumbs, index, entry, size }: TileProps) {
  const item = usePageItem(store, Math.max(0, entry))
  const shown: ContentItem | undefined = entry < 0 ? undefined : item
  const isCursor = useListingStore((s) => s[side].cursor === index)
  const marked = useMarksStore((s) => entry >= 0 && isMarked(s[side], entry, shown?.id))
  const renaming = useRenaming(side, index)
  const panelPath = useListingStore((s) => s[side].path)
  // Enter on this folder or archive is still being answered (a slow drive).
  const opening = useListingStore(
    (s) => s[side].loading && shown !== undefined && s[side].loadingTarget === shown.id,
  )
  const m = TILE_METRICS[size]
  const glyph = Math.round(m.tile * 0.36)
  const nameSize = size === "small" ? "h-[1.125rem] text-[0.75rem]" : "h-[1.25rem] text-[0.8125rem]"
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
      data-kind={entry < 0 ? "parent" : (shown?.kind ?? "loading")}
      aria-selected={marked}
      aria-label={entry < 0 ? ".." : shown?.name}
      className={tileClass}
      style={{ width: m.tile }}
    >
      <div
        className="relative flex items-center justify-center rounded-[3px]"
        style={{ width: m.tile, height: m.tile }}
        data-thumb-box
      >
        {entry < 0 ? (
          <span className="flex size-full items-center justify-center rounded-[3px] bg-skeleton/60 text-muted">
            <TypeGlyph glyph="up" size={glyph} />
          </span>
        ) : shown ? (
          <TileThumb
            item={shown}
            box={m.tile}
            // A mark is the tile's accent frame; the cursor is drawn around the whole tile.
            visual={{ selected: marked, focused: false, dragOver: false }}
            thumbs={thumbs}
            fallback={<TypeGlyph glyph={glyphOf(shown)} size={glyph} muted={isMuted(shown)} />}
          />
        ) : (
          <span className="size-full rounded-[3px] bg-skeleton" />
        )}
        {opening && (
          <span className="absolute inset-0 grid place-items-center rounded-[3px] bg-canvas/60 text-text">
            <Spinner size={28} />
          </span>
        )}
      </div>
      <div
        className={`mt-1 flex items-center justify-center truncate px-1 leading-5 ${nameSize} ${
          marked ? "text-accent" : shown && isMuted(shown) ? "text-muted" : "text-text"
        }`}
      >
        {entry < 0 ? (
          ".."
        ) : shown && renaming ? (
          <RenameField onDone={() => focusGrid(side)} />
        ) : shown ? (
          <span className="truncate">
            {prefix && <span className="text-muted">{prefix}</span>}
            {shown.name}
          </span>
        ) : null}
      </div>
    </div>
  )
})
