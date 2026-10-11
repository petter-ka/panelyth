import type { ContentItem } from "@panelyth/contracts"
import { create } from "zustand"
import { bridge } from "../../bridge"
import { currentLocale } from "@panelyth/i18n"
import { playInPane } from "../preview/previewStore"
import { ensureIndex, getItem, getTotal } from "../tiles/pageStore"
import { focusSelectAndReveal } from "../tiles/selectionStore"
import { requestFit, requestMedia } from "./viewerImages"

/**
 * The focused image viewer (Stage 04): which item is shown. Navigation walks
 * the open query session in its current order and skips folders and videos
 * (video playback is Stage 06).
 */
interface ViewerState {
  open: boolean
  index: number
  item: ContentItem | null
}

export const useViewerStore = create<ViewerState>(() => ({ open: false, index: 0, item: null }))

const set = useViewerStore.setState
const get = useViewerStore.getState

// Scans at most this many entries for the next image (e.g. across folders).
const MAX_SCAN = 5000
let navSeq = 0

function isViewable(item: ContentItem | undefined): item is ContentItem {
  return item?.kind === "image"
}

function prefetchAround(index: number, item: ContentItem): void {
  void requestMedia(item.id)
  const wanted: { id: number; priority: 0 | 1 }[] = [{ id: item.id, priority: 0 }]
  // Neighbours already loaded in the page store: prefetch their previews so
  // stepping to them is immediate.
  for (const i of [index + 1, index - 1]) {
    const n = getItem(i)
    if (isViewable(n)) {
      wanted.push({ id: n.id, priority: 1 })
      void requestMedia(n.id)
    }
  }
  void requestFit(wanted).catch(() => undefined)
}

function show(index: number, item: ContentItem): void {
  set({ open: true, index, item })
  prefetchAround(index, item)
}

/** Opens the viewer on an image tile. Returns false for folders/videos. */
export function openViewerAt(index: number): boolean {
  const item = getItem(index)
  if (!isViewable(item)) return false
  show(index, item)
  return true
}

// The media window (ADR-0033 amended) shows the file in a window of its own;
// this window keeps the listing, so the media window asks it for neighbours.

interface HostedWindow {
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
 * Double-click / Enter on an image or video tile: the file fills the screen in
 * a frameless window of its own, with zoom, fit, the Panelyth player and
 * previous / next. When that window can't open, the in-app surface is used.
 */
export function openFullscreenAt(index: number): boolean {
  const item = getItem(index)
  if (!isMedia(item)) return false
  const key = nextKey++
  hosted.set(key, { index, item })
  if (hosted.size > MAX_HOSTED) hosted.delete(hosted.keys().next().value!)
  void bridge.openMediaWindow(item.id, key, currentLocale()).catch(() => {
    hosted.delete(key)
    if (item.kind === "image") openViewerAt(index)
    else playInPane(index, { fullscreen: true })
  })
  return true
}

async function answerStep(key: number, direction: -1 | 0 | 1): Promise<ContentItem | null> {
  const window = hosted.get(key)
  if (!window) return null
  if (direction === 0) return window.item
  const found = await findMedia(window.index + direction, direction)
  if (!found) return null
  window.index = found.index
  window.item = found.item
  return found.item
}

async function findMedia(
  from: number,
  direction: 1 | -1,
): Promise<{ index: number; item: ContentItem } | null> {
  const total = getTotal()
  for (let i = from, n = 0; i >= 0 && i < total && n < MAX_SCAN; i += direction, n++) {
    const item = getItem(i) ?? (await ensureIndex(i))
    if (isMedia(item)) return { index: i, item }
  }
  return null
}

/** Answers the media windows' questions; returns the stop function. */
export function startMediaWindowHost(): () => void {
  return bridge.on("mediaWindow.step", ({ requestId, key, direction }) => {
    void answerStep(key, direction)
      .catch(() => null)
      .then((item) => bridge.mediaWindowAnswer(requestId, item))
      .catch(() => undefined)
  })
}

async function findViewable(
  from: number,
  direction: 1 | -1,
): Promise<{ index: number; item: ContentItem } | null> {
  const total = getTotal()
  for (let i = from, n = 0; i >= 0 && i < total && n < MAX_SCAN; i += direction, n++) {
    const item = getItem(i) ?? (await ensureIndex(i))
    if (isViewable(item)) return { index: i, item }
  }
  return null
}

/** Next (+1) or previous (-1) image; stays put at either end. */
export async function step(direction: 1 | -1): Promise<void> {
  const { open, index } = get()
  if (!open) return
  const seq = ++navSeq
  const found = await findViewable(index + direction, direction)
  if (found && seq === navSeq && get().open) show(found.index, found.item)
}

/** First or last image of the folder. */
export async function jump(to: "first" | "last"): Promise<void> {
  if (!get().open) return
  const seq = ++navSeq
  const found = to === "first" ? await findViewable(0, 1) : await findViewable(getTotal() - 1, -1)
  if (found && seq === navSeq && get().open) show(found.index, found.item)
}

/** Closes the viewer; the tile view selects and reveals the last image shown. */
export function closeViewer(): void {
  const { open, index, item } = get()
  if (!open) return
  navSeq++
  set({ open: false })
  focusSelectAndReveal(index, item?.id ?? null)
}

export function resetViewer(): void {
  navSeq++
  set({ open: false, index: 0, item: null })
}
