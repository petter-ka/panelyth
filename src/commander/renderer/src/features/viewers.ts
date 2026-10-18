import type {
  ContentItem,
  MediaWindowCommand,
  MediaWindowCommandResult,
  MediaWindowStep,
} from "@panelyth/contracts"
import { create } from "zustand"
import { currentAppearance, whileAppLoads } from "@panelyth/ui"
import { currentLocale, t } from "@panelyth/i18n"
import { bridge } from "../bridge"
import { opensInDocumentWindow, openDocumentWindow } from "./documents"
import { clipboardPaste, clipboardSetOf, deleteNow, entryOperand } from "./files"
import { focusEntry, onSessionChanged, pageStoreOf, parentRows, useListingStore } from "./listing"
import { otherSide, setActivePanel, usePanelsStore, type Side } from "./panels"

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

// The media window (ADR-0033 amended) shows the file in a window of its own;
// the panel keeps the listing, so the window asks it for neighbours.

interface HostedWindow {
  side: Side
  /** The panel's session when the window opened; another folder ends the bookkeeping. */
  queryId: number
  index: number
  item: ContentItem
}

/** Windows opened from here, by the key they were opened with (the newest few). */
const hosted = new Map<number, HostedWindow>()
const MAX_HOSTED = 32
let nextKey = 1

const isMedia = (item: ContentItem | undefined): item is ContentItem =>
  item?.kind === "image" || item?.kind === "video"

/**
 * An image or video fills the screen in a frameless window of its own, with
 * zoom, fit, the Panelyth player and previous / next. When that window can't
 * open the in-app surface above the panels is used instead.
 */
export function openMediaViewer(
  item: ContentItem,
  side = usePanelsStore.getState().active,
): boolean {
  if (!isMedia(item)) return false
  const panel = useListingStore.getState()[side]
  if (!panel.query) return false
  const key = nextKey++
  hosted.set(key, {
    side,
    queryId: panel.query.queryId,
    index: panel.cursor - parentRows(panel),
    item,
  })
  if (hosted.size > MAX_HOSTED) hosted.delete(hosted.keys().next().value!)
  // Main reads the file before the window opens: on a drive still spinning up
  // that takes a while, so the loading screen shows meanwhile.
  void whileAppLoads(
    bridge.openMediaWindow(item.id, key, currentAppearance().theme, currentLocale()),
    { label: t("Opening…") },
  ).catch(() => {
    hosted.delete(key)
    openMediaOverlay(item, side)
  })
  return true
}

/** The window's panel still shows the session it was opened from. */
const samePanel = (window: HostedWindow): boolean =>
  useListingStore.getState()[window.side].query?.queryId === window.queryId

/**
 * The window's file may have moved in the listing since (a delete above it,
 * a new version): its index is looked up again. False when it left.
 */
async function relocate(window: HostedWindow): Promise<boolean> {
  const store = pageStoreOf(window.side)
  if (store.getItem(window.index)?.id === window.item.id) return true
  if (!samePanel(window)) return false
  const at = await bridge.indexOf(window.queryId, window.item.id).catch(() => null)
  if (!at || at.index < 0) return false
  window.index = at.index
  return true
}

/** The nearest image or video from `from` in `direction`. */
async function findMedia(
  side: Side,
  from: number,
  direction: -1 | 1,
): Promise<{ index: number; item: ContentItem } | null> {
  const store = pageStoreOf(side)
  const total = store.getTotal()
  for (
    let index = from, scanned = 0;
    index >= 0 && index < total && scanned < MAX_STEP_SCAN;
    index += direction, scanned++
  ) {
    const item = await store.ensureIndex(index)
    if (isMedia(item)) return { index, item }
  }
  return null
}

/** The media window asked for its own item, the previous, next, first or last one. */
async function answerStep(key: number, direction: MediaWindowStep): Promise<ContentItem | null> {
  const window = hosted.get(key)
  if (!window) return null
  if (direction === 0) return window.item
  // The ends are those of the listing the window was opened from.
  if (typeof direction === "string" && !samePanel(window)) return null
  let found: Awaited<ReturnType<typeof findMedia>>
  if (direction === "first") found = await findMedia(window.side, 0, 1)
  else if (direction === "last")
    found = await findMedia(window.side, pageStoreOf(window.side).getTotal() - 1, -1)
  else {
    await relocate(window)
    found = await findMedia(window.side, window.index + direction, direction)
  }
  if (!found) return null
  window.index = found.index
  window.item = found.item
  return found.item
}

/**
 * A file key in the media window, on the file it shows (never the marks):
 * the clipboard, paste into the panel's folder, the trash or a permanent
 * delete. After a delete the window shows the next file (the previous one at
 * the end), or nothing.
 */
export async function runMediaCommand(
  key: number,
  command: MediaWindowCommand,
): Promise<MediaWindowCommandResult> {
  const window = hosted.get(key)
  if (!window) return { item: null, done: false }
  const refused = { item: window.item, done: false }
  if (!samePanel(window) || !(await relocate(window))) return refused
  const source = entryOperand(window.side, window.item.id)
  if (!source) return refused
  switch (command) {
    case "copy":
    case "cut":
      return { item: window.item, done: await clipboardSetOf(window.side, source, command) }
    case "paste":
      return { item: window.item, done: await clipboardPaste(window.side) }
    case "trash":
    case "delete": {
      const next =
        (await findMedia(window.side, window.index + 1, 1)) ??
        (await findMedia(window.side, window.index - 1, -1))
      if (!(await deleteNow(window.side, source, command === "delete"))) return refused
      if (!next) {
        hosted.delete(key)
        return { item: null, done: true }
      }
      // The listing drops the deleted row soon; relocate() finds the new index then.
      window.index = next.index
      window.item = next.item
      return { item: next.item, done: true }
    }
  }
}

/** The cursor goes to the file the window showed last, scrolled into view. */
function revealHosted(key: number): void {
  const window = hosted.get(key)
  hosted.delete(key)
  if (!window || !samePanel(window)) return
  revealInPanel(window.side, window.item.id)
}

function revealInPanel(side: Side, entryId: number): void {
  setActivePanel(side)
  void focusEntry(side, entryId)
  set((s) => ({ panelFocus: s.panelFocus + 1 }))
}

/** Answers the media windows' questions; returns the stop function. */
export function startMediaWindowHost(): () => void {
  const stops = [
    bridge.on("mediaWindow.step", ({ requestId, key, direction }) => {
      void answerStep(key, direction)
        .catch(() => null)
        .then((item) => bridge.mediaWindowAnswer(requestId, item))
        .catch(() => undefined)
    }),
    bridge.on("mediaWindow.command", ({ requestId, key, command }) => {
      void runMediaCommand(key, command)
        .catch(() => ({ item: hosted.get(key)?.item ?? null, done: false }))
        .then((r) => bridge.mediaWindowAnswer(requestId, r.item, r.done))
        .catch(() => undefined)
    }),
    bridge.on("mediaWindow.closed", ({ key }) => revealHosted(key)),
  ]
  return () => stops.forEach((stop) => stop())
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

/** Esc: the cursor goes to the file shown last. */
export function closeMediaViewer(): void {
  const current = get().mediaViewer
  if (!current) return
  set((s) => ({ mediaViewer: null, panelFocus: s.panelFocus + 1 }))
  revealInPanel(current.side, current.item.id)
}

/** Steps to the adjacent image or video in the source panel. */
export async function stepMediaViewer(direction: -1 | 1): Promise<boolean> {
  const current = get().mediaViewer
  return current ? showMediaFrom(current.index + direction, direction) : false
}

/** Home / End in the media overlay: the panel's first or last image or video. */
export async function jumpMediaViewer(to: "first" | "last"): Promise<boolean> {
  const current = get().mediaViewer
  if (!current) return false
  return to === "first"
    ? showMediaFrom(0, 1)
    : showMediaFrom(pageStoreOf(current.side).getTotal() - 1, -1)
}

/** The overlay shows the nearest image or video from `from` in `direction`; false when none. */
async function showMediaFrom(from: number, direction: -1 | 1): Promise<boolean> {
  const current = get().mediaViewer
  if (!current) return false
  const store = pageStoreOf(current.side)
  const total = store.getTotal()
  for (
    let index = from, scanned = 0;
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
