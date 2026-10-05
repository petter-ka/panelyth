import type { PreviewPriority } from "@fastview/contracts"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { openFolderEntry, useFolderStore } from "../../features/folder/folderStore"
import { requestCovers } from "../../features/previews/coverStore"
import {
  getThumbProfile,
  requestVisible,
  setThumbProfile,
  type ThumbRequest,
} from "../../features/previews/thumbStore"
import {
  CONTENT_PADDING,
  TILE_METRICS,
  profileFor,
  rowCount,
  rowHeight,
  tilesPerRow,
  type TileSize,
} from "../../features/tiles/layout"
import { useLayoutStore } from "../../features/tiles/layoutStore"
import { getItem, onPagesLoaded, setRange } from "../../features/tiles/pageStore"
import {
  clearSelection,
  focusAndSelect,
  focusOnly,
  selectIndexRanges,
  selectAll,
  selectRangeTo,
  selectionCount,
  toggleSelected,
  useSelectionStore,
} from "../../features/tiles/selectionStore"
import {
  INTERFACE_SIZE_SCALE,
  useInterfaceSizeStore,
} from "../../features/theme/interfaceSizeStore"
import { playInPane } from "../../features/preview/previewStore"
import { openViewerAt } from "../../features/viewer/viewerStore"
import { ContextMenuRoot, ContextMenuTrigger } from "../ui/menu"
import { Tile } from "./Tile"
import { TileMenu, type MenuTarget } from "./TileMenu"

/** Pause after scrolling before thumbnails are requested (fast scrolls request nothing). */
const SETTLE_MS = 80
const OVERSCAN_ROWS = 2

interface RowProps {
  rowIndex: number
  start: number
  first: number
  count: number
  size: TileSize
  height: number
  interfaceScale: number
}

/** One line of tiles, left-aligned; spare width stays at the right edge. */
const TileRow = memo(function TileRow({
  rowIndex,
  start,
  first,
  count,
  size,
  height,
  interfaceScale,
}: RowProps) {
  const m = TILE_METRICS[size]
  const tiles = []
  for (let i = 0; i < count; i++) tiles.push(<Tile key={first + i} index={first + i} size={size} />)
  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 1}
      className="absolute top-0 left-0 flex w-full"
      style={{
        height,
        transform: `translateY(${start}px)`,
        gap: m.gap * interfaceScale,
        paddingLeft: CONTENT_PADDING * interfaceScale,
        paddingRight: CONTENT_PADDING * interfaceScale,
      }}
    >
      {tiles}
    </div>
  )
})

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
 * The content area: every item is a fixed-size tile; tiles flow left to
 * right and wrap. A wider window fits more tiles per row (ADR-0004,
 * docs/viewer/stages/03-tile-view.md). Rows are virtualized, so the mounted DOM depends
 * on the viewport, never on the folder size.
 */
export function TileView() {
  const total = useFolderStore((s) => s.query?.total ?? 0)
  const queryId = useFolderStore((s) => s.query?.queryId ?? 0)
  const resetToken = useFolderStore((s) => s.scrollResetToken)
  const size = useLayoutStore((s) => s.tileSize)
  const stepTileSize = useLayoutStore((s) => s.stepTileSize)
  const interfaceSize = useInterfaceSizeStore((s) => s.size)
  const interfaceScale = INTERFACE_SIZE_SCALE[interfaceSize]
  const focusIndex = useSelectionStore((s) => s.focusIndex)
  const revealToken = useSelectionStore((s) => s.revealToken)
  const dpr = useDevicePixelRatio()

  const scrollRef = useRef<HTMLDivElement>(null)
  const marqueeRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    clientX: number
    clientY: number
    additive: boolean
    active: boolean
    lastRanges: [number, number][] | null
  } | null>(null)
  const animationRef = useRef(0)
  const removeDragListenersRef = useRef<(() => void) | null>(null)
  const [marqueeActive, setMarqueeActive] = useState(false)
  const [width, setWidth] = useState(0)
  const perRow = width > 0 ? tilesPerRow(width, size, interfaceScale) : 1
  const rows = rowCount(total, perRow)
  const height = rowHeight(size, interfaceScale)

  useEffect(
    () => () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current)
      removeDragListenersRef.current?.()
    },
    [],
  )

  useEffect(() => setThumbProfile(profileFor(size, dpr)), [size, dpr])

  // One ResizeObserver measures content width. Tile rows account for both
  // available width and interface spacing, while thumbnail boxes stay fixed.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => setWidth(el.clientWidth || el.getBoundingClientRect().width)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => height,
    overscan: OVERSCAN_ROWS,
    paddingStart: CONTENT_PADDING * interfaceScale,
    paddingEnd: CONTENT_PADDING * interfaceScale,
    useFlushSync: false,
  })

  // Tile or interface size changes the fixed row height.
  useEffect(() => virtualizer.measure(), [virtualizer, height])

  // Keep the first visible item in view when tiles per row change.
  // perRow is 0 until the first real width measurement: the jump from the
  // placeholder value is not a resize and must not scroll (a no-op scroll
  // still flags isScrolling and delays the first thumbnails).
  const anchor = useRef({ perRow: 0, firstItem: 0 })
  useLayoutEffect(() => {
    if (width === 0) return
    const previous = anchor.current.perRow
    anchor.current.perRow = perRow
    if (previous === 0 || previous === perRow || total === 0) return
    const row = Math.floor(anchor.current.firstItem / perRow)
    if (row > 0 || (virtualizer.scrollOffset ?? 0) !== 0) {
      virtualizer.scrollToIndex(row, { align: "start" })
    }
  }, [perRow, total, virtualizer, width])

  // The viewer closed: bring the last image it showed into view.
  useEffect(() => {
    if (revealToken === 0) return
    virtualizer.scrollToIndex(Math.floor(useSelectionStore.getState().focusIndex / perRow), {
      align: "auto",
    })
    // perRow is read at reveal time; only the token triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealToken, virtualizer])

  // New folder or sort: back to the top. Only if not already there: a no-op
  // scrollToOffset(0) still flags isScrolling for ~150 ms, which would hold
  // back the first thumbnail request.
  useEffect(() => {
    if ((virtualizer.scrollOffset ?? 0) !== 0) virtualizer.scrollToOffset(0)
  }, [resetToken, virtualizer])

  const virtualRows = virtualizer.getVirtualItems()
  const firstRow = virtualRows[0]?.index ?? 0
  const lastRow = virtualRows.at(-1)?.index ?? -1
  const offset = virtualizer.scrollOffset ?? 0
  const viewport = virtualizer.scrollRect?.height ?? 0
  const visible = virtualRows.filter((r) => r.end > offset && r.start < offset + viewport)
  const firstVisibleRow = visible[0]?.index ?? firstRow
  const lastVisibleRow = visible.at(-1)?.index ?? lastRow

  // Runs after the perRow effect above has consumed the previous value.
  useLayoutEffect(() => {
    anchor.current.firstItem = firstVisibleRow * perRow
  }, [firstVisibleRow, perRow])

  // Pages for the mounted rows (the page store adds one page on each side).
  useEffect(() => {
    if (lastRow < 0) return
    setRange(firstRow * perRow, Math.min(total, (lastRow + 1) * perRow) - 1)
  }, [firstRow, lastRow, perRow, total, queryId])

  // Thumbnails only for a settled range: visible first, then overscan, then
  // the next screen in the scroll direction. One call per settled range.
  const [loadTick, setLoadTick] = useState(0)
  useEffect(() => onPagesLoaded(() => setLoadTick((t) => t + 1)), [])
  const lastOffset = useRef(0)
  const scrolling = virtualizer.isScrolling
  // The settle pause only matters after the user scrolled; a range that
  // changed because data arrived (first page, folder opened) is requested at once.
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
        for (let i = Math.max(0, rowA) * perRow; i < Math.min(total, (rowB + 1) * perRow); i++) {
          const item = getItem(i)
          if (item) wanted.push({ item, priority })
        }
      }
      const screenRows = lastVisibleRow - firstVisibleRow + 1
      add(firstVisibleRow, lastVisibleRow, 0)
      add(firstRow, firstVisibleRow - 1, 1)
      add(lastVisibleRow + 1, lastRow, 1)
      if (direction > 0) add(lastRow + 1, lastRow + screenRows, 2)
      else add(firstRow - screenRows, firstRow - 1, 2)
      void requestVisible(wanted).catch(() => undefined)
      // Folder covers only for what is on screen or about to be (no forward buffer).
      void requestCovers(
        wanted.filter((w) => w.priority < 2),
        getThumbProfile(),
      )
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
    total,
    queryId,
    loadTick,
  ])

  // Ctrl/Cmd + wheel steps the tile size (non-passive to prevent page zoom).
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      stepTileSize(e.deltaY < 0 ? 1 : -1)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [stepTileSize])

  // Plain arrows move and select; Shift extends from the anchor; Ctrl/Cmd
  // moves focus only (then Ctrl+Space toggles); Ctrl+Shift adds a range.
  const moveFocus = useCallback(
    (index: number, mode: "select" | "extend" | "add" | "focus" = "select") => {
      if (total === 0) return
      const next = Math.min(Math.max(index, 0), total - 1)
      const id = getItem(next)?.id ?? null
      if (mode === "extend" || mode === "add") selectRangeTo(next, id, mode === "add")
      else if (mode === "focus") focusOnly(next)
      else focusAndSelect(next, id)
      virtualizer.scrollToIndex(Math.floor(next / perRow), { align: "auto" })
    },
    [total, perRow, virtualizer],
  )

  const [menuTarget, setMenuTarget] = useState<MenuTarget>("background")

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || e.pointerType === "touch" || e.shiftKey) return
    if ((e.target as Element).closest("[data-tile-drag-handle]")) return
    const view = e.currentTarget
    const bounds = view.getBoundingClientRect()
    const drag = {
      pointerId: e.pointerId,
      startX: e.clientX - bounds.left + view.scrollLeft,
      startY: e.clientY - bounds.top + view.scrollTop,
      clientX: e.clientX,
      clientY: e.clientY,
      additive: e.ctrlKey || e.metaKey,
      active: false,
      lastRanges: null as [number, number][] | null,
    }
    dragRef.current = drag

    const sameRanges = (a: [number, number][] | null, b: [number, number][]): boolean =>
      a !== null &&
      a.length === b.length &&
      a.every(([start, end], i) => {
        const other = b[i]
        return other !== undefined && start === other[0] && end === other[1]
      })

    const updateMarquee = (clientX: number, clientY: number): void => {
      const current = dragRef.current
      const overlay = marqueeRef.current
      if (!current || !overlay) return
      const viewRect = view.getBoundingClientRect()
      const x = clientX - viewRect.left + view.scrollLeft
      const y = clientY - viewRect.top + view.scrollTop
      const left = Math.min(current.startX, x)
      const right = Math.max(current.startX, x)
      const top = Math.min(current.startY, y)
      const bottom = Math.max(current.startY, y)
      const widthPx = Math.max(1, right - left)
      const heightPx = Math.max(1, bottom - top)
      overlay.style.left = `${left - (right === left ? 0.5 : 0)}px`
      overlay.style.top = `${top - (bottom === top ? 0.5 : 0)}px`
      overlay.style.width = `${widthPx}px`
      overlay.style.height = `${heightPx}px`

      const metrics = TILE_METRICS[size]
      const columnStep = metrics.tile + metrics.gap * interfaceScale
      const padding = CONTENT_PADDING * interfaceScale
      const tileExtent = metrics.tile + metrics.nameLine * interfaceScale
      const minX = left - (right === left ? 0.5 : 0)
      const maxX = right + (right === left ? 0.5 : 0)
      const minY = top - (bottom === top ? 0.5 : 0)
      const maxY = bottom + (bottom === top ? 0.5 : 0)
      const firstColumn = Math.max(0, Math.floor((minX - padding - metrics.tile) / columnStep) + 1)
      const afterColumn = Math.min(perRow, Math.ceil((maxX - padding) / columnStep))
      const firstRow = Math.max(0, Math.floor((minY - padding - tileExtent) / height) + 1)
      const afterRow = Math.min(rows, Math.ceil((maxY - padding) / height))
      const ranges: [number, number][] = []
      if (afterColumn > firstColumn && afterRow > firstRow) {
        for (let row = firstRow; row < afterRow; row++) {
          const first = row * perRow + firstColumn
          const end = Math.min(total, row * perRow + afterColumn)
          if (end > first) ranges.push([first, end])
        }
      }

      const indexAt = (contentX: number, contentY: number): number => {
        if (total === 0) return 0
        const row = Math.min(rows - 1, Math.max(0, Math.floor((contentY - padding) / height)))
        const column = Math.min(
          perRow - 1,
          Math.max(0, Math.floor((contentX - padding) / columnStep)),
        )
        return Math.min(total - 1, row * perRow + column)
      }
      const anchorIndex = indexAt(current.startX, current.startY)
      let focusIndex = indexAt(x, y)
      if (!current.additive && ranges.length === 1 && ranges[0]![1] - ranges[0]![0] === 1)
        focusIndex = ranges[0]![0]
      if (!sameRanges(current.lastRanges, ranges)) {
        const item = getItem(focusIndex)
        selectIndexRanges(ranges, {
          additive: current.additive,
          anchorIndex,
          focusIndex,
          focusId: item?.id ?? null,
        })
        current.lastRanges = ranges
      }
    }

    const stopAutoScroll = (): void => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current)
      animationRef.current = 0
    }
    const scheduleAutoScroll = (): void => {
      if (animationRef.current) return
      const tick = (): void => {
        animationRef.current = 0
        const current = dragRef.current
        if (!current?.active) return
        const rect = view.getBoundingClientRect()
        const edge = 32
        let delta = 0
        if (current.clientY < rect.top + edge && view.scrollTop > 0) {
          const depth = Math.min(1, (rect.top + edge - current.clientY) / edge)
          delta = -Math.ceil(4 + depth * 24)
        } else if (
          current.clientY > rect.bottom - edge &&
          view.scrollTop < view.scrollHeight - view.clientHeight
        ) {
          const depth = Math.min(1, (current.clientY - (rect.bottom - edge)) / edge)
          delta = Math.ceil(4 + depth * 24)
        }
        if (delta === 0) return
        view.scrollTop += delta
        updateMarquee(current.clientX, current.clientY)
        animationRef.current = requestAnimationFrame(tick)
      }
      animationRef.current = requestAnimationFrame(tick)
    }

    const onMove = (event: PointerEvent): void => {
      const current = dragRef.current
      if (!current || event.pointerId !== current.pointerId) return
      current.clientX = event.clientX
      current.clientY = event.clientY
      if (!current.active && Math.hypot(event.clientX - e.clientX, event.clientY - e.clientY) < 4)
        return
      if (!current.active) {
        current.active = true
        setMarqueeActive(true)
      }
      updateMarquee(event.clientX, event.clientY)
      const rect = view.getBoundingClientRect()
      if (event.clientY < rect.top + 32 || event.clientY > rect.bottom - 32) scheduleAutoScroll()
      else stopAutoScroll()
    }
    const finish = (event?: PointerEvent): void => {
      const current = dragRef.current
      if (!current || (event && event.pointerId !== current.pointerId)) return
      if (current.active && event?.type === "pointerup") updateMarquee(event.clientX, event.clientY)
      dragRef.current = null
      stopAutoScroll()
      removeDragListenersRef.current?.()
      removeDragListenersRef.current = null
      setMarqueeActive(false)
    }
    const onUp = (event: PointerEvent): void => finish(event)
    const onBlur = (): void => finish()
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
    window.addEventListener("blur", onBlur)
    removeDragListenersRef.current = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
      window.removeEventListener("blur", onBlur)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.altKey) return // Alt+arrows / Alt+Enter are window-level (navigation, properties)
    if (e.key === "Escape") {
      if (selectionCount(useSelectionStore.getState()) > 0) {
        e.preventDefault()
        clearSelection()
      }
      return
    }
    const pageRows = Math.max(1, lastVisibleRow - firstVisibleRow)
    // Ctrl+Shift extends without dropping earlier Ctrl+click picks.
    const mod = e.ctrlKey || e.metaKey
    const mode = e.shiftKey ? (mod ? "add" : "extend") : mod ? "focus" : "select"
    const move = (index: number) => () => moveFocus(index, mode)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault()
      selectAll(total)
      return
    }
    const keys: Record<string, () => void> = {
      ArrowRight: move(focusIndex + 1),
      ArrowLeft: move(focusIndex - 1),
      ArrowDown: move(focusIndex + perRow),
      ArrowUp: move(focusIndex - perRow),
      Home: move(0),
      End: move(total - 1),
      PageDown: move(focusIndex + pageRows * perRow),
      PageUp: move(focusIndex - pageRows * perRow),
      " ": () => {
        const id = getItem(focusIndex)?.id
        if (id === undefined) return
        if (e.ctrlKey || e.metaKey) toggleSelected(focusIndex, id)
        else focusAndSelect(focusIndex, id)
      },
      Enter: () => {
        const item = getItem(focusIndex)
        if (item?.kind === "dir") void openFolderEntry(item.id)
        else if (item?.kind === "video") playInPane(focusIndex)
        else openViewerAt(focusIndex)
      },
    }
    const action = keys[e.key]
    if (!action) return
    e.preventDefault()
    action()
  }

  return (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>
        <div
          ref={scrollRef}
          onPointerDown={onPointerDown}
          onMouseDown={(e) => {
            // Empty space: a left click clears the selection (Explorer/Finder).
            const onTile = (e.target as HTMLElement).closest("[data-testid=tile]") !== null
            if (!onTile && e.button === 0 && !e.shiftKey && !e.ctrlKey && !e.metaKey)
              clearSelection()
          }}
          onContextMenu={(e) => {
            const onTile = (e.target as HTMLElement).closest(
              "[data-testid=tile][data-kind]:not([data-kind=loading])",
            )
            setMenuTarget(onTile ? "selection" : "background")
          }}
          role="grid"
          aria-label="Folder contents"
          aria-rowcount={rows}
          aria-colcount={perRow}
          aria-activedescendant={total > 0 ? `tile-${focusIndex}` : undefined}
          tabIndex={0}
          onKeyDown={onKeyDown}
          className="h-full overflow-y-auto overflow-x-hidden outline-none select-none"
          data-testid="tile-view"
          data-per-row={perRow}
          data-tile-size={size}
        >
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualRows.map((row) => {
              const first = row.index * perRow
              return (
                <TileRow
                  key={row.key}
                  rowIndex={row.index}
                  start={row.start}
                  first={first}
                  count={Math.min(perRow, total - first)}
                  size={size}
                  height={height}
                  interfaceScale={interfaceScale}
                />
              )
            })}
            <div
              ref={marqueeRef}
              aria-hidden="true"
              hidden={!marqueeActive}
              className="pointer-events-none absolute z-20 border border-accent bg-accent/15"
              data-testid="marquee-selection"
            />
          </div>
        </div>
      </ContextMenuTrigger>
      <TileMenu target={menuTarget} />
    </ContextMenuRoot>
  )
}
