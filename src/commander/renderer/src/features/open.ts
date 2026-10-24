import type { ContentItem } from "@panelyth/contracts"
import { create } from "zustand"
import { bridge, PanelythError } from "../bridge"
import { notice, READ_ONLY, refusedOnConnection } from "./files"
import { openDocumentWindow } from "./documents"
import { openLister, openMediaViewer } from "./viewers"
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
import { t } from "@panelyth/i18n"

// Open and edit (Stage C05, ADR-0027): media opens in Panelyth Viewer by
// default; other files use their system app. Program launching follows the
// "Run programs with Enter" setting (ask, always, never). F4 opens the
// configured editor; Shift+F4 creates a text file and opens it. Main resolves
// every entry id to its path and decides what is a program.

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
  error instanceof PanelythError
    ? ((error.details as { reason?: unknown } | undefined)?.reason as string | undefined)
    : undefined

const messageOf = (error: unknown): string =>
  error instanceof PanelythError ? error.message : String(error)

/** The cursor entry of a panel; null on ".." or while its page loads. */
export function cursorItem(side: Side): ContentItem | null {
  const p = useListingStore.getState()[side]
  const index = p.cursor - parentRows(p)
  return index >= 0 ? (pageStoreOf(side).getItem(index) ?? null) : null
}

/** Enter on a file. */
export async function openWithApp(item: ContentItem, side?: Side): Promise<void> {
  const settings = useSettingsStore.getState().settings
  // A file on a server is only ever shown, in the viewer or the lister, from
  // a temporary copy: nothing a server sends is started (ADR-0037).
  if (side && useListingStore.getState()[side].remote) {
    if ((item.kind === "image" || item.kind === "video") && openMediaViewer(item, side)) return
    openLister(side)
    return
  }
  if (
    settings.mediaOpen === "viewer" &&
    (item.kind === "image" || item.kind === "video") &&
    openMediaViewer(item, side)
  )
    return

  if (await openDocumentWindow(item)) return

  const mode = settings.runPrograms
  try {
    await bridge.shellOpen(item.id, mode === "always" ? true : undefined)
  } catch (error) {
    if (reasonOf(error) !== "program") {
      notice(t("{name} can't be opened: {reason}", { name: item.name, reason: messageOf(error) }))
      return
    }
    if (mode === "never")
      notice(
        t("{name} is a program. Running programs with Enter is off in Settings.", {
          name: item.name,
        }),
      )
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
    notice(t("{name} can't be started: {reason}", { name: p.name, reason: messageOf(error) }))
  }
}

export const cancelProgram = (): void => set({ program: null })

/**
 * Why a file did not open for editing: the built-in editor (ADR-0046) takes
 * text files of up to 8 MB; F3 still views the rest.
 */
function editRefused(name: string, error: unknown): void {
  const reason = reasonOf(error)
  if (reason === "binary") notice(t("{name} isn't a text file. F3 views it.", { name }))
  else if (reason === "tooLarge") {
    notice(t("{name} is too large to edit here (over 8 MB). F3 views it.", { name }))
  } else notice(t("{name} can't be edited: {reason}", { name, reason: messageOf(error) }))
}

/** F4: the editor from settings, or the built-in one (ADR-0046). */
export async function editCursor(side: Side): Promise<void> {
  const item = cursorItem(side)
  if (!item || item.kind === "dir") return
  if (refusedOnConnection(side)) return
  if (useListingStore.getState()[side].archive) {
    notice(t("Files inside an archive can't be edited. Copy them out with F5 first."))
    return
  }
  try {
    await bridge.shellEdit(item.id)
  } catch (error) {
    editRefused(item.name, error)
  }
}

/** Shift+F4. */
export function openNewFile(side: Side): void {
  const p = useListingStore.getState()[side]
  if (refusedOnConnection(side)) return
  if (p.archive) notice(t(READ_ONLY))
  else if (p.dirId !== null) set({ newFile: { side, error: null } })
}

/**
 * An archive that can't be entered: one this build does not read opens with
 * its default app; without 7-Zip that also happens, with the reason shown;
 * a damaged or protected archive only says why.
 */
export function archiveFailed(item: ContentItem, why: ArchiveOpenFailure, message: string): void {
  if (why === "other") {
    notice(t("{name} can't be opened: {reason}", { name: item.name, reason: message }))
    return
  }
  if (why === "noTool")
    notice(t("7-Zip isn't installed, so {name} opens with its default app.", { name: item.name }))
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
    await bridge.shellEdit(entryId).catch((error: unknown) => editRefused(name.trim(), error))
    return true
  } catch (error) {
    set({ newFile: { ...n, error: messageOf(error) } })
    return false
  }
}

/** Enter on a file goes through openWithApp (listing.enter keeps folders). */
export function startOpen(): () => void {
  setFileOpener((side, item) => openWithApp(item, side))
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
