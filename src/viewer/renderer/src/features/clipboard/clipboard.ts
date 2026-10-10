import type { ContentItem } from "@panelyth/contracts"
import { create } from "zustand"
import { bridge } from "../../bridge"
import { copySelection, currentSelection, useJobsStore } from "../jobs/jobsStore"
import { getItem } from "../tiles/pageStore"
import { selectionCount, useSelectionStore } from "../tiles/selectionStore"
import { useFolderStore } from "../folder/folderStore"
import { plural } from "../../lib/format"

/**
 * Copying to the OS clipboard (Stage 08.6). Ctrl+C on one picture puts the
 * picture itself on the clipboard, so it pastes into Paint, Word or a chat;
 * the selection also goes to the internal file clipboard as before, so
 * Ctrl+V in another folder still copies the file. Go decodes the picture
 * (any indexed format, EXIF orientation applied); main only forwards a PNG.
 */

export interface Notice {
  id: number
  text: string
  tone: "info" | "error"
}

export const useNoticeStore = create<{ notice: Notice | null }>(() => ({ notice: null }))

const NOTICE_MS = 2500
/** "Copying picture…" shows only when the copy takes longer than this. */
const SLOW_MS = 200

let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null

/** A short status message near the bottom of the window. */
export function notify(text: string, tone: Notice["tone"] = "info", sticky = false): number {
  const id = ++seq
  useNoticeStore.setState({ notice: { id, text, tone } })
  if (timer) clearTimeout(timer)
  timer = sticky
    ? null
    : setTimeout(() => {
        if (useNoticeStore.getState().notice?.id === id) useNoticeStore.setState({ notice: null })
      }, NOTICE_MS)
  return id
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let copying: Promise<void> | null = null

/** Puts one indexed image on the OS clipboard as a picture. */
export function copyImage(entryId: number): Promise<void> {
  // Repeated Ctrl+C while a big picture is still being prepared: one copy.
  if (copying) return copying
  const slow = setTimeout(() => notify("Copying picture…", "info", true), SLOW_MS)
  copying = bridge
    .copyImage(entryId)
    .then(() => {
      notify("Picture copied to the clipboard")
    })
    .catch((error: unknown) => {
      notify(`Couldn't copy the picture: ${errorText(error)}`, "error")
    })
    .finally(() => {
      clearTimeout(slow)
      copying = null
    })
  return copying
}

/** The one selected entry, when exactly one is selected and its page is loaded. */
export function singleSelectedItem(): ContentItem | null {
  const s = useSelectionStore.getState()
  if (selectionCount(s) !== 1 || s.selectedId === null) return null
  const at = getItem(s.focusIndex)
  return at?.id === s.selectedId ? at : null
}

/**
 * Ctrl+C in the tile view: the files go to the internal clipboard (paste in
 * Panelyth) and a single picture also goes to the OS clipboard.
 */
export async function copySelectionToClipboard(): Promise<void> {
  const item = singleSelectedItem()
  if (item?.kind === "image") {
    void copySelection("copy")
    await copyImage(item.id)
    return
  }
  const count = currentSelection()?.count ?? 0
  if (count === 0) return
  await copySelection("copy")
  if (useJobsStore.getState().clip.mode === "copy")
    notify(`${plural(count, "item", "items")} copied. Paste into another folder with Ctrl+V.`)
}

/** Copies an entry's full path (resolved in main; the renderer never sees it). */
export async function copyEntryPath(entryId: number): Promise<void> {
  const query = useFolderStore.getState().query
  if (!query) return
  try {
    const { count } = await bridge.copyPaths({
      queryId: query.queryId,
      version: query.version,
      ranges: [],
      include: [entryId],
      exclude: [],
    })
    if (count > 0) notify("Path copied")
  } catch (error) {
    notify(`Couldn't copy the path: ${errorText(error)}`, "error")
  }
}

/** Copies a file name as text. */
export async function copyName(name: string): Promise<void> {
  try {
    await bridge.copyText(name)
    notify("Name copied")
  } catch (error) {
    notify(`Couldn't copy the name: ${errorText(error)}`, "error")
  }
}
