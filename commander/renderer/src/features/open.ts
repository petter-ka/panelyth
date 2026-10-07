import type { ContentItem } from "@fastview/contracts"
import { create } from "zustand"
import { bridge, FastViewError } from "../bridge"
import { notice, READ_ONLY } from "./files"
import {
  focusEntry,
  pageStoreOf,
  parentRows,
  setArchiveFailureHandler,
  setFileOpener,
  useListingStore,
  type ArchiveOpenFailure,
} from "./listing"
import type { Side } from "./panels"
import { useSettingsStore } from "./settings"

// Open and edit (Stage C05, ADR-0027): Enter opens a file with its default
// app; a program opens only after the user confirmed it (setting "Run
// programs with Enter": ask, always, never). F4 opens the editor from
// settings, Shift+F4 creates a text file and opens it. Main resolves every
// entry id to its path and decides what is a program; nothing here sends a path.

interface OpenState {
  /** The confirmation before a program runs. */
  program: { entryId: number; name: string } | null
  /** Shift+F4: the name of the new text file. */
  newFile: { side: Side; error: string | null } | null
}

export const useOpenStore = create<OpenState>(() => ({ program: null, newFile: null }))

const set = useOpenStore.setState
const get = useOpenStore.getState

const reasonOf = (error: unknown): string | undefined =>
  error instanceof FastViewError
    ? ((error.details as { reason?: unknown } | undefined)?.reason as string | undefined)
    : undefined

const messageOf = (error: unknown): string =>
  error instanceof FastViewError ? error.message : String(error)

/** The cursor entry of a panel; null on ".." or while its page loads. */
export function cursorItem(side: Side): ContentItem | null {
  const p = useListingStore.getState()[side]
  const index = p.cursor - parentRows(p)
  return index >= 0 ? (pageStoreOf(side).getItem(index) ?? null) : null
}

/** Enter on a file. */
export async function openWithApp(item: ContentItem): Promise<void> {
  const mode = useSettingsStore.getState().settings.runPrograms
  try {
    await bridge.shellOpen(item.id, mode === "always" ? true : undefined)
  } catch (error) {
    if (reasonOf(error) !== "program") {
      notice(`${item.name} can't be opened: ${messageOf(error)}`)
      return
    }
    if (mode === "never")
      notice(`${item.name} is a program. Running programs with Enter is off in Settings.`)
    else set({ program: { entryId: item.id, name: item.name } })
  }
}

/** The confirmation's Run button. */
export async function runConfirmedProgram(): Promise<void> {
  const p = get().program
  if (!p) return
  set({ program: null })
  try {
    await bridge.shellOpen(p.entryId, true)
  } catch (error) {
    notice(`${p.name} can't be started: ${messageOf(error)}`)
  }
}

export const cancelProgram = (): void => set({ program: null })

/** F4: the editor from settings, or the system's text editor. */
export async function editCursor(side: Side): Promise<void> {
  const item = cursorItem(side)
  if (!item || item.kind === "dir") return
  if (useListingStore.getState()[side].archive) {
    notice("Files inside an archive can't be edited. Copy them out with F5 first.")
    return
  }
  try {
    await bridge.shellEdit(item.id)
  } catch (error) {
    notice(`${item.name} can't be edited: ${messageOf(error)}`)
  }
}

/** Shift+F4. */
export function openNewFile(side: Side): void {
  const p = useListingStore.getState()[side]
  if (p.archive) notice(READ_ONLY)
  else if (p.dirId !== null) set({ newFile: { side, error: null } })
}

/**
 * An archive that can't be entered: one this build does not read opens with
 * its default app; without 7-Zip that also happens, with the reason shown;
 * a damaged or protected archive only says why.
 */
export function archiveFailed(item: ContentItem, why: ArchiveOpenFailure, message: string): void {
  if (why === "other") {
    notice(`${item.name} can't be opened: ${message}`)
    return
  }
  if (why === "noTool") notice(`7-Zip isn't installed, so ${item.name} opens with its default app.`)
  void openWithApp(item)
}

export const closeNewFile = (): void => set({ newFile: null })

/** Creates the file (an existing one is kept), puts the cursor on it and opens the editor. */
export async function createTextFile(name: string): Promise<boolean> {
  const n = get().newFile
  const dirId = n ? useListingStore.getState()[n.side].dirId : null
  if (!n || dirId === null) return false
  try {
    const { entryId } = await bridge.mkfile(dirId, name.trim())
    set({ newFile: null })
    void focusEntry(n.side, entryId)
    await bridge.shellEdit(entryId).catch((error: unknown) => {
      notice(`${name.trim()} can't be edited: ${messageOf(error)}`)
    })
    return true
  } catch (error) {
    set({ newFile: { ...n, error: messageOf(error) } })
    return false
  }
}

/** Enter on a file goes through openWithApp (listing.enter keeps folders). */
export function startOpen(): () => void {
  setFileOpener((_side, item) => openWithApp(item))
  setArchiveFailureHandler((_side, item, why, message) => archiveFailed(item, why, message))
  return () => {
    setFileOpener(null)
    setArchiveFailureHandler(null)
  }
}

/** Tests. */
export function resetOpen(): void {
  set({ program: null, newFile: null })
}
