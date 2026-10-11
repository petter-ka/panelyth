import type { ContentItem } from "@panelyth/contracts"
import { create } from "zustand"
import { currentAppearance } from "@panelyth/ui"
import { currentLocale } from "@panelyth/i18n"
import { bridge } from "../bridge"
import { opensInDocumentWindow, openDocumentWindow } from "./documents"
import { onSessionChanged, pageStoreOf, parentRows, useListingStore } from "./listing"
import { otherSide, usePanelsStore, type Side } from "./panels"

// Quick view (Ctrl+Q) and the lister (F3), Stage C05. Quick view shows the
// active panel's cursor entry in the other panel once the cursor settles,
// so a held arrow key never loads anything. The lister is a full window over
// the panels; N / P step through the panel's files and Esc returns with the
// panel's cursor unchanged.

/** The cursor must rest this long before quick view loads it (as the viewer's preview pane). */
export const QUICK_SETTLE_MS = 150

export type ListerMode = "text" | "hex" | "image" | "video"

export interface ListerState {
  /** The panel the lister was opened from. */
  side: Side
  /** The shown file's index in that panel's session. */
  index: number
  item: ContentItem
  /** null: chosen by the file (image, video, text or hex). */
  mode: ListerMode | null
}

export interface MediaViewerState {
  side: Side
  index: number
  item: ContentItem
}

interface ViewersState {
  /** The panel quick view follows; it shows in the other panel. */
  quick: Side | null
  /** The settled cursor entry (null on ".." or an empty folder). */
  quickItem: ContentItem | null
  lister: ListerState | null
  mediaViewer: MediaViewerState | null
  /** Increments when focus should go back to the active panel's list. */
  panelFocus: number
}

export const useViewersStore = create<ViewersState>(() => ({
  quick: null,
  quickItem: null,
  lister: null,
  mediaViewer: null,
  panelFocus: 0,
}))

const set = useViewersStore.setState
const get = useViewersStore.getState

/** The item at a panel's cursor: undefined while its page loads, null on "..". */
function itemAtCursor(side: Side): ContentItem | null | undefined {
  const p = useListingStore.getState()[side]
  const index = p.cursor - parentRows(p)
  if (p.dirId === null || index < 0) return null
  return pageStoreOf(side).getItem(index)
}

/**
 * Delays a value until it has been stable for `delay` ms; the same value
 * again does not restart the wait. Pure timing, unit-tested.
 */
export function createSettler<T>(delay: number, onSettle: (value: T) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: { value: T } | null = null
  let settled: { value: T } | null = null
  return {
    push(value: T): void {
      if (pending && Object.is(pending.value, value)) return
      if (timer) clearTimeout(timer)
      timer = null
      pending = null
      if (settled && Object.is(settled.value, value)) return
      pending = { value }
      timer = setTimeout(() => {
        timer = null
        settled = pending
        pending = null
        if (settled) onSettle(settled.value)
      }, delay)
    },
    cancel(): void {
      if (timer) clearTimeout(timer)
      timer = null
      pending = null
    },
  }
}

/** Ctrl+Q: opens quick view for a panel, or closes it. */
export function toggleQuickView(side: Side): void {
  if (get().quick !== null) {
    set({ quick: null, quickItem: null })
    return
  }
  const item = itemAtCursor(side)
  set({ quick: side, quickItem: item ?? null })
}

export const closeQuickView = (): void => set({ quick: null, quickItem: null })

/**
 * An image or video fills the screen in a frameless window of its own
 * (ADR-0033). When that window can't open (an image the browser can't show
 * directly, say) the in-app surface above the panels is used instead.
 */
export function openMediaViewer(
  item: ContentItem,
  side = usePanelsStore.getState().active,
): boolean {
  if (item.kind !== "image" && item.kind !== "video") return false
  void bridge
    .openMediaWindow(item.id, currentAppearance().theme, currentLocale())
    .catch(() => openMediaOverlay(item, side))
  return true
}

/** Opens a shared full-window media surface above Commander. */
export function openMediaOverlay(
  item: ContentItem,
  side = usePanelsStore.getState().active,
): boolean {
  if (item.kind !== "image" && item.kind !== "video") return false
  const panel = useListingStore.getState()[side]
  const index = panel.cursor - parentRows(panel)
  set({ mediaViewer: { side, index, item } })
  return true
}

export function closeMediaViewer(): void {
  if (!get().mediaViewer) return
  set((s) => ({ mediaViewer: null, panelFocus: s.panelFocus + 1 }))
}

/** Steps to the adjacent image or video in the source panel. */
export async function stepMediaViewer(direction: -1 | 1): Promise<boolean> {
  const current = get().mediaViewer
  if (!current) return false
  const store = pageStoreOf(current.side)
  const total = store.getTotal()
  for (
    let index = current.index + direction, scanned = 0;
    index >= 0 && index < total && scanned < MAX_STEP_SCAN;
    index += direction, scanned++
  ) {
    const item = await store.ensureIndex(index)
    if (get().mediaViewer !== current) return false
    if (item?.kind === "image" || item?.kind === "video") {
      set({ mediaViewer: { ...current, index, item } })
      return true
    }
  }
  return false
}

/** Tab with quick view open: focus goes back to the panel. */
export const focusPanel = (): void => set((s) => ({ panelFocus: s.panelFocus + 1 }))

/**
 * Follows the quick-view panel's cursor: the entry id settles for
 * QUICK_SETTLE_MS, then the item is shown. Started once by the app.
 */
export function startQuickView(): () => void {
  const settler = createSettler<number | null>(QUICK_SETTLE_MS, () => {
    const side = get().quick
    if (side === null) return
    const item = itemAtCursor(side)
    if (item !== undefined) set({ quickItem: item })
  })
  const check = (): void => {
    const side = get().quick
    if (side === null) {
      settler.cancel()
      return
    }
    const item = itemAtCursor(side)
    if (item === undefined) return // its page arrives with onPagesLoaded
    settler.push(item?.id ?? null)
  }
  const unsubs = [
    useListingStore.subscribe((s, prev) => {
      const side = get().quick
      if (side === null) return
      const a = s[side]
      const b = prev[side]
      if (a.cursor !== b.cursor || a.dirId !== b.dirId || a.query !== b.query) check()
    }),
    useViewersStore.subscribe((s, prev) => {
      if (s.quick !== prev.quick) {
        settler.cancel()
        if (s.quick !== null) check()
      }
    }),
    // Quick view always shows in the inactive panel: it follows the active one.
    usePanelsStore.subscribe((s, prev) => {
      if (s.active !== prev.active && get().quick !== null && get().quick !== s.active)
        set({ quick: s.active })
    }),
    pageStoreOf("left").onPagesLoaded(() => get().quick === "left" && check()),
    pageStoreOf("right").onPagesLoaded(() => get().quick === "right" && check()),
    // Ctrl+U moves the folder to the other side: quick view follows the panel the user is in.
    onSessionChanged(() => get().quick !== null && check()),
  ]
  return () => {
    settler.cancel()
    unsubs.forEach((u) => u())
  }
}

/** Where quick view is shown: the panel opposite the one it follows. */
export const quickTarget = (s: Pick<ViewersState, "quick">): Side | null =>
  s.quick === null ? null : otherSide(s.quick)

// Lister ------------------------------------------------------------------------

/** F3: the cursor file in the lister (folders and ".." do nothing). */
export function openLister(side: Side): void {
  const p = useListingStore.getState()[side]
  const index = p.cursor - parentRows(p)
  const item = index >= 0 ? pageStoreOf(side).getItem(index) : undefined
  if (!item || item.kind === "dir") return
  // PDFs and text files go to the document window unless Settings says otherwise (ADR-0033).
  if (opensInDocumentWindow(item)) {
    void openDocumentWindow(item).then((opened) => {
      if (!opened) set({ lister: { side, index, item, mode: null } })
    })
    return
  }
  set({ lister: { side, index, item, mode: null } })
}

export function closeLister(): void {
  if (!get().lister) return
  set((s) => ({ lister: null, panelFocus: s.panelFocus + 1 }))
}

export function setListerMode(mode: ListerMode): void {
  const l = get().lister
  if (l) set({ lister: { ...l, mode } })
}

/** How far N / P look for the next file (folders come first in a listing). */
const MAX_STEP_SCAN = 10_000

/** N / P: the next or previous file of the panel; false at either end. */
export async function listerStep(direction: 1 | -1): Promise<boolean> {
  const l = get().lister
  if (!l) return false
  const store = pageStoreOf(l.side)
  const total = store.getTotal()
  for (
    let i = l.index + direction, n = 0;
    i >= 0 && i < total && n < MAX_STEP_SCAN;
    i += direction, n++
  ) {
    const item = await store.ensureIndex(i)
    if (get().lister !== l) return false // closed or moved meanwhile
    if (item && item.kind !== "dir") {
      set({ lister: { ...l, index: i, item, mode: null } })
      return true
    }
  }
  return false
}

/** Tests. */
export function resetViewers(): void {
  set({ quick: null, quickItem: null, lister: null, mediaViewer: null, panelFocus: 0 })
}
