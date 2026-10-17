import type { ContentItem, MediaWindowCommand, MediaWindowCommandResult } from "@panelyth/contracts"
import { create } from "zustand"
import { bridge } from "../../bridge"
import { currentLocale } from "@panelyth/i18n"
import { copySelectionToClipboard } from "../clipboard/clipboard"
import { useFolderStore } from "../folder/folderStore"
import {
  copySelection,
  currentSelection,
  deletePermanently,
  paste,
  refreshClip,
  trashSelection,
  useJobsStore,
} from "../jobs/jobsStore"
import { playInPane } from "../preview/previewStore"
import { ensureIndex, getItem, getTotal } from "../tiles/pageStore"
import { focusAndSelect, focusSelectAndReveal } from "../tiles/selectionStore"
import { selectEntry } from "../workspace/appSwitch"
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
  /** The folder's session when the window opened; another folder ends the bookkeeping. */
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
 * Double-click / Enter on an image or video tile: the file fills the screen in
 * a frameless window of its own, with zoom, fit, the Panelyth player and
 * previous / next. When that window can't open, the in-app surface is used.
 */
export function openFullscreenAt(index: number): boolean {
  const item = getItem(index)
  const query = useFolderStore.getState().query
  if (!isMedia(item) || !query) return false
  const key = nextKey++
  hosted.set(key, { queryId: query.queryId, index, item })
  if (hosted.size > MAX_HOSTED) hosted.delete(hosted.keys().next().value!)
  void bridge.openMediaWindow(item.id, key, currentLocale()).catch(() => {
    hosted.delete(key)
    if (item.kind === "image") openViewerAt(index)
    else playInPane(index, { fullscreen: true })
  })
  return true
}

/** The folder still shows the session the window was opened from. */
const sameFolder = (window: HostedWindow): boolean =>
  useFolderStore.getState().query?.queryId === window.queryId

/**
 * The window's file may have moved in the folder since (a delete before it,
 * a new version): its index is looked up again. False when it left.
 */
async function relocate(window: HostedWindow): Promise<boolean> {
  if (getItem(window.index)?.id === window.item.id) return true
  if (!sameFolder(window)) return false
  const at = await bridge.indexOf(window.queryId, window.item.id).catch(() => null)
  if (!at || at.index < 0) return false
  window.index = at.index
  return true
}

async function answerStep(key: number, direction: -1 | 0 | 1): Promise<ContentItem | null> {
  const window = hosted.get(key)
  if (!window) return null
  if (direction === 0) return window.item
  await relocate(window)
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

/**
 * A file key in the media window, on the file it shows: the file becomes
 * the selection and the tile view's own command runs on it (Ctrl+C also puts
 * a picture on the OS clipboard). After a delete the window shows the next
 * file (the previous one at the end), or nothing.
 */
export async function runMediaCommand(
  key: number,
  command: MediaWindowCommand,
): Promise<MediaWindowCommandResult> {
  const window = hosted.get(key)
  if (!window) return { item: null, done: false }
  const refused = { item: window.item, done: false }
  if (!sameFolder(window) || !(await relocate(window))) return refused
  focusAndSelect(window.index, window.item.id)
  const ran = (): boolean => useJobsStore.getState().error === null
  switch (command) {
    case "copy":
      await copySelectionToClipboard()
      return { item: window.item, done: ran() }
    case "cut":
      await copySelection("cut")
      return { item: window.item, done: ran() }
    case "paste":
      // The clipboard may have been filled in the commander.
      await refreshClip()
      if (useJobsStore.getState().clip.mode === "") return refused
      await paste()
      return { item: window.item, done: ran() }
    case "trash":
    case "delete": {
      const next = (await findMedia(window.index + 1, 1)) ?? (await findMedia(window.index - 1, -1))
      if (command === "trash") await trashSelection()
      else {
        // The media window asked already: its own dialogs are in front of this window.
        const cur = currentSelection()
        if (cur) await deletePermanently(cur.selection, cur.count)
      }
      if (!ran()) return refused
      if (!next) {
        hosted.delete(key)
        return { item: null, done: true }
      }
      // The folder drops the deleted tile soon; relocate() finds the new index then.
      window.index = next.index
      window.item = next.item
      return { item: next.item, done: true }
    }
  }
}

/** The media window closed: the tile view selects the file it showed last and scrolls to it. */
function revealHosted(key: number): void {
  const window = hosted.get(key)
  hosted.delete(key)
  if (!window || !sameFolder(window)) return
  if (getItem(window.index)?.id === window.item.id)
    focusSelectAndReveal(window.index, window.item.id)
  else void selectEntry(window.item.id)
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
