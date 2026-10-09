import type { ContentItem } from "@panelyth/contracts"
import { create } from "zustand"
import { getItem, onPagesLoaded } from "../tiles/pageStore"
import { focusAndSelect, selectionCount, useSelectionStore } from "../tiles/selectionStore"
import { requestFit, requestMedia } from "../viewer/viewerImages"
import { expandPane } from "../workspace/paneControls"

/**
 * What the preview pane shows (Stage 06): the last selected entry, or a
 * count when several are selected. It follows the selection after it
 * settles, so walking the tiles with a held arrow key never loads (or
 * probes, or decodes) every item passed on the way.
 */
interface PreviewState {
  item: ContentItem | null
  /** Number of selected entries; > 1 shows a summary instead of a preview. */
  count: number
  /**
   * Set by Enter / double-click on a video: the player starts playing, in
   * full screen when asked (double-click).
   */
  play: { id: number; token: number | null; fullscreen: boolean } | null
}

export const usePreviewStore = create<PreviewState>(() => ({ item: null, count: 0, play: null }))

const set = usePreviewStore.setState
const get = usePreviewStore.getState

/** A selection change this soon after the previous one waits until it settles. */
export const SETTLE_MS = 150

let lastChange = -Infinity
let timer: ReturnType<typeof setTimeout> | null = null

function selectedItem(): { item: ContentItem | null; count: number } {
  const s = useSelectionStore.getState()
  const count = selectionCount(s)
  if (s.selectedId === null) return { item: null, count }
  const at = getItem(s.focusIndex)
  if (at?.id === s.selectedId) return { item: at, count }
  // Focus moved elsewhere (Ctrl+click on another tile): keep the shown item.
  const current = get().item
  return { item: current?.id === s.selectedId ? current : null, count }
}

/** Starts the pane's requests: display size / token URL and the fit preview or poster. */
function load(item: ContentItem): void {
  if (item.kind === "dir") return
  void requestMedia(item.id)
  void requestFit([{ id: item.id, priority: 0 }], [], "pane").catch(() => undefined)
}

function apply(): void {
  timer = null
  const next = selectedItem()
  const cur = get()
  if (next.item === cur.item && next.count === cur.count) return
  const changed = next.item?.id !== cur.item?.id
  set({ item: next.item, count: next.count, play: changed ? null : cur.play })
  if (changed && next.item && next.count <= 1) load(next.item)
}

function schedule(): void {
  const now = performance.now()
  const settled = now - lastChange > SETTLE_MS
  lastChange = now
  if (timer) clearTimeout(timer)
  if (settled) apply()
  else timer = setTimeout(apply, SETTLE_MS)
}

/**
 * Enter / double-click on a video tile: select it, show the pane and play.
 * With `fullscreen` the player also fills the screen; Esc returns to the pane.
 */
export function playInPane(index: number, { fullscreen = false } = {}): boolean {
  const item = getItem(index)
  if (item?.kind !== "video") return false
  focusAndSelect(index, item.id)
  if (timer) clearTimeout(timer)
  apply()
  expandPane("preview")
  set((s) => ({ play: { id: item.id, token: (s.play?.token ?? 0) + 1, fullscreen } }))
  return true
}

/** Stages a fullscreen video surface without starting playback while Viewer is hidden. */
export function stageVideoInPane(index: number): boolean {
  const item = getItem(index)
  if (item?.kind !== "video") return false
  focusAndSelect(index, item.id)
  if (timer) clearTimeout(timer)
  apply()
  expandPane("preview")
  set({ play: { id: item.id, token: null, fullscreen: true } })
  return true
}

/** Starts the video after the staged Viewer becomes the active app. */
export function startStagedPlayback(): void {
  set((s) =>
    s.play?.fullscreen && s.play.token === null
      ? { play: { ...s.play, token: (s.play.token ?? 0) + 1 } }
      : s,
  )
}

/** Leaves the app-level fullscreen surface while keeping ordinary playback in the pane. */
export function closeVideoFullscreen(): void {
  set((s) => (s.play?.fullscreen ? { play: { ...s.play, fullscreen: false } } : s))
}

/** Stops a playback launched by another app before returning to that app. */
export function stopPreviewPlayback(): void {
  if (get().play !== null) set({ play: null })
}

export function startPreviewTracking(): () => void {
  const unsubSelection = useSelectionStore.subscribe((s, prev) => {
    if (
      s.selectedId !== prev.selectedId ||
      s.ranges !== prev.ranges ||
      s.include !== prev.include ||
      s.exclude !== prev.exclude
    )
      schedule()
  })
  // A page reload can replace the shown item (modified in place).
  const unsubPages = onPagesLoaded(() => {
    const cur = get().item
    if (cur && selectedItem().item !== cur) schedule()
  })
  return () => {
    unsubSelection()
    unsubPages()
    if (timer) clearTimeout(timer)
    timer = null
  }
}

export function resetPreview(): void {
  if (timer) clearTimeout(timer)
  timer = null
  lastChange = -Infinity
  set({ item: null, count: 0, play: null })
}
