import type { ConflictPolicy, SelectionDescriptor } from "@fastview/contracts"
import { isMarked } from "@fastview/renderer-core"
import { create } from "zustand"
import { bridge, FastViewError } from "../bridge"
import { focusEntry, pageStoreOf, parentRows, useListingStore } from "./listing"
import { cursorDescriptor, marksDescriptor, marksOf, markNone } from "./marks"
import { otherSide, setActivePanel, usePanelsStore, type Side } from "./panels"
import { useTabsStore } from "./tabs"

// File operations (Stage C04, CFR-11, CFR-12, CFR-27): F5 copy, F6 move,
// Shift+F5 copy here under a new name, F2 / Shift+F6 rename in place, F7
// new folder, F8 / Delete trash, Shift+F8 / Shift+Delete delete, the
// internal clipboard, and drag and drop. Every command acts on the marks, or
// on the cursor entry when nothing is marked. Jobs run on the engine v2
// queue (ADR-0029); destinations are folder ids resolved in Go (ADR-0027).

export type CopyKind = "copy" | "move"

/** The conflict policies the copy dialog offers (UX-DESIGN "Dialogs"). */
export const POLICIES: readonly { value: ConflictPolicy; label: string }[] = [
  { value: "ask", label: "Ask" },
  { value: "replace", label: "Overwrite" },
  { value: "skip", label: "Skip" },
  { value: "replaceOlder", label: "Overwrite older" },
  { value: "renameNew", label: "Rename new" },
  { value: "renameExisting", label: "Rename existing" },
]

export interface CopyDialogState {
  kind: CopyKind
  side: Side
  source: SelectionDescriptor
  /** What is copied: "notes.txt" or "12 files and folders". */
  what: string
  count: number
  /** From Go (selection.info); null while it is computed. */
  bytes: number | null
  /** The destination as shown (editable); dirId is its folder while unedited. */
  destination: string
  destinationDirId: number | null
  /** Shift+F5: a single item copied into its own folder under this name. */
  name: string | null
  mask: string
  conflict: ConflictPolicy
  verify: boolean
  error: string | null
}

export interface DeleteDialogState {
  side: Side
  source: SelectionDescriptor
  what: string
  count: number
  bytes: number | null
  permanent: boolean
  /** Whether the folder's volume has a trash (null while asked). */
  trash: boolean | null
  /** The entry the cursor goes to once the items are gone. */
  next: number | null
}

export interface MkdirDialogState {
  side: Side
  error: string | null
}

export interface RenameState {
  side: Side
  /** View row and entry being renamed. */
  row: number
  entryId: number
  name: string
  isDir: boolean
  error: string | null
}

interface FilesState {
  copy: CopyDialogState | null
  remove: DeleteDialogState | null
  mkdir: MkdirDialogState | null
  rename: RenameState | null
  /** A short message in the status bar ("3 items on the clipboard"). */
  notice: string | null
}

export const useFilesStore = create<FilesState>(() => ({
  copy: null,
  remove: null,
  mkdir: null,
  rename: null,
  notice: null,
}))

const set = useFilesStore.setState
const get = useFilesStore.getState
const panel = (side: Side) => useListingStore.getState()[side]

let noticeTimer: ReturnType<typeof setTimeout> | null = null
export function notice(message: string): void {
  set({ notice: message })
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => set({ notice: null }), 5000)
}

/** The marks, or the cursor entry when nothing is marked (".." is never an operand). */
export function operand(side: Side): SelectionDescriptor | null {
  return marksDescriptor(side) ?? cursorDescriptor(side)
}

/** The cursor entry (loaded), or null on ".." or an unloaded row. */
function cursorItem(side: Side) {
  const p = panel(side)
  const index = p.cursor - parentRows(p)
  return index >= 0 ? (pageStoreOf(side).getItem(index) ?? null) : null
}

/** "notes.txt" for the cursor entry, "12 items" for marks. */
function describe(side: Side, count: number): string {
  if (!marksDescriptor(side)) {
    const item = cursorItem(side)
    if (item) return item.name
  }
  return `${count.toLocaleString()} ${count === 1 ? "item" : "items"}`
}

async function sizeOf(
  source: SelectionDescriptor,
): Promise<{ count: number; bytes: number } | null> {
  try {
    const info = await bridge.selectionInfo(source)
    return { count: info.count, bytes: info.bytes }
  } catch {
    return null
  }
}

function errorText(error: unknown): string {
  if (error instanceof FastViewError) return error.message
  return String(error)
}

// Copy and move --------------------------------------------------------------------

export interface CopyTarget {
  /** A folder path shown in the dialog (a tab, a drive root). */
  path: string
  /** Its folder id when known (a panel's open folder). */
  dirId: number | null
}

/** The other panel's folder: F5 / F6's default destination. */
export function otherPanelTarget(side: Side): CopyTarget | null {
  const p = panel(otherSide(side))
  return p.dirId === null ? null : { path: p.path, dirId: p.dirId }
}

/** F5 / F6 (and a drop): the dialog with the destination and the item count. */
export async function openCopy(
  side: Side,
  kind: CopyKind,
  target?: CopyTarget | null,
): Promise<void> {
  const source = operand(side)
  const dest = target ?? otherPanelTarget(side)
  if (!source || !dest) return
  const count = source.ranges.reduce((n, [a, b]) => n + b - a, 0) + source.include.length
  set({
    copy: {
      kind,
      side,
      source,
      what: describe(side, count),
      count,
      bytes: null,
      destination: dest.path,
      destinationDirId: dest.dirId,
      name: null,
      mask: "*.*",
      conflict: "ask",
      verify: false,
      error: null,
    },
  })
  const info = await sizeOf(source)
  const now = get().copy
  if (info && now?.source === source)
    set({ copy: { ...now, count: info.count, bytes: info.bytes } })
}

/** Shift+F5: the cursor entry copied into its own folder under a new name. */
export function openCopyHere(side: Side): void {
  const item = cursorItem(side)
  const source = cursorDescriptor(side)
  const p = panel(side)
  if (!item || !source || p.dirId === null) return
  set({
    copy: {
      kind: "copy",
      side,
      source,
      what: item.name,
      count: 1,
      bytes: item.kind === "dir" ? null : item.sizeBytes,
      destination: p.path,
      destinationDirId: p.dirId,
      name: item.name,
      mask: "*.*",
      conflict: "ask",
      verify: false,
      error: null,
    },
  })
}

export function updateCopy(change: Partial<CopyDialogState>): void {
  const c = get().copy
  if (!c) return
  // An edited destination is resolved again when the job starts.
  const edited = change.destination !== undefined && change.destination !== c.destination
  set({ copy: { ...c, ...change, ...(edited && { destinationDirId: null }), error: null } })
}

export const closeCopy = (): void => set({ copy: null })

const ALL_FILES = new Set(["", "*", "*.*"])

/**
 * Copy (now) or Queue: resolves an edited destination to its folder id in Go
 * (dir.open of the path the user typed), then starts the job. The marks are
 * cleared once it is queued, as in Total Commander.
 */
export async function startCopy(now: boolean): Promise<boolean> {
  const c = get().copy
  if (!c) return false
  let dirId = c.destinationDirId
  try {
    if (dirId === null) {
      const typed = c.destination.trim()
      if (typed === "") throw new Error("Enter a destination folder.")
      dirId = (await bridge.openDir(typed)).dirId
    }
    const mask = c.mask.trim()
    await bridge.startJob({
      kind: c.kind,
      source: { selection: c.source },
      destinationDirId: dirId,
      conflict: c.conflict,
      ...(c.verify && { verify: true }),
      ...(now && { now: true }),
      ...(!ALL_FILES.has(mask) && { mask }),
      ...(c.name !== null && { name: c.name.trim() }),
    })
  } catch (error) {
    const reason =
      error instanceof FastViewError ? (error.details as { reason?: string })?.reason : ""
    const message =
      error instanceof FastViewError &&
      (error.code === "NOT_FOUND" || error.code === "INVALID_PATH")
        ? "This folder doesn't exist. Check the destination."
        : reason === "notReady"
          ? "The destination drive is not ready."
          : errorText(error)
    if (get().copy) set({ copy: { ...get().copy!, error: message } })
    return false
  }
  set({ copy: null })
  if (marksDescriptor(c.side)) markNone(c.side)
  return true
}

// Delete -------------------------------------------------------------------------------

/**
 * The entry the cursor should land on after a delete: the first row after
 * the cursor that is not being deleted (loaded rows only).
 */
function nextSurvivor(side: Side): number | null {
  const p = panel(side)
  const store = pageStoreOf(side)
  const marks = marksOf(side)
  const marked = marksDescriptor(side) !== null
  const start = p.cursor - parentRows(p)
  for (let i = Math.max(0, start); i < start + 200; i++) {
    const item = store.getItem(i)
    if (!item) return null
    const gone = marked ? isMarked(marks, i, item.id) : i === start
    if (!gone) return item.id
  }
  return null
}

/** F8 / Delete (trash), Shift+F8 / Shift+Delete (permanent): the confirmation. */
export async function openDelete(side: Side, permanent: boolean): Promise<void> {
  const source = operand(side)
  const p = panel(side)
  if (!source || p.dirId === null) return
  const count = source.ranges.reduce((n, [a, b]) => n + b - a, 0) + source.include.length
  set({
    remove: {
      side,
      source,
      what: describe(side, count),
      count,
      bytes: null,
      permanent,
      trash: permanent ? true : null,
      next: nextSurvivor(side),
    },
  })
  const [info, trash] = await Promise.all([
    sizeOf(source),
    permanent ? Promise.resolve(true) : bridge.canTrash(p.dirId).catch(() => true),
  ])
  const now = get().remove
  if (now?.source !== source) return
  set({ remove: { ...now, trash, ...(info && { count: info.count, bytes: info.bytes }) } })
}

/** The trash is unavailable: the same items, deleted permanently. */
export function switchToPermanent(): void {
  const r = get().remove
  if (r) set({ remove: { ...r, permanent: true } })
}

export const closeDelete = (): void => set({ remove: null })

export async function confirmDelete(): Promise<void> {
  const r = get().remove
  if (!r) return
  set({ remove: null })
  try {
    await bridge.startJob({
      kind: r.permanent ? "delete" : "trash",
      source: { selection: r.source },
    })
    if (marksDescriptor(r.side)) markNone(r.side)
    if (r.next !== null) void focusEntry(r.side, r.next)
  } catch (error) {
    notice(errorText(error))
  }
}

// New folder and rename ---------------------------------------------------------------------

export function openMkdir(side: Side): void {
  if (panel(side).dirId !== null) set({ mkdir: { side, error: null } })
}

export const closeMkdir = (): void => set({ mkdir: null })

/** F7: "a/b/c" creates the chain; the cursor lands on the new folder. */
export async function createFolder(path: string): Promise<boolean> {
  const m = get().mkdir
  const dirId = m ? panel(m.side).dirId : null
  if (!m || dirId === null) return false
  try {
    const res = await bridge.mkdir(dirId, path)
    set({ mkdir: null })
    void focusEntry(m.side, res.entryId)
    return true
  } catch (error) {
    set({ mkdir: { ...m, error: errorText(error) } })
    return false
  }
}

/** F2 / Shift+F6: the inline editor on the cursor row. */
export function startRename(side: Side): void {
  const item = cursorItem(side)
  if (!item) return
  set({
    rename: {
      side,
      row: panel(side).cursor,
      entryId: item.id,
      name: item.name,
      isDir: item.kind === "dir",
      error: null,
    },
  })
}

export const cancelRename = (): void => set({ rename: null })

export async function commitRename(name: string): Promise<boolean> {
  const r = get().rename
  if (!r) return false
  const next = name.trim()
  if (next === "" || next === r.name) {
    set({ rename: null })
    return true
  }
  try {
    await bridge.rename(r.entryId, next)
    set({ rename: null })
    // The entry keeps its id; the cursor follows it to its new place.
    void focusEntry(r.side, r.entryId)
    return true
  } catch (error) {
    set({ rename: { ...r, error: errorText(error) } })
    return false
  }
}

// Clipboard ---------------------------------------------------------------------------------

/** Ctrl+C / Ctrl+X: the internal file clipboard (shared with the viewer). */
export async function clipboardSet(side: Side, mode: "copy" | "cut"): Promise<void> {
  const source = operand(side)
  if (!source) return
  try {
    const state = await bridge.clipSet(source, mode)
    notice(
      `${state.count.toLocaleString()} ${state.count === 1 ? "item" : "items"} ${mode === "cut" ? "cut" : "copied"}`,
    )
  } catch (error) {
    notice(errorText(error))
  }
}

/** Ctrl+V: paste into the panel's folder; conflicts are asked about. */
export async function clipboardPaste(side: Side): Promise<void> {
  const dirId = panel(side).dirId
  if (dirId === null) return
  try {
    await bridge.clipPaste(dirId, "ask")
  } catch (error) {
    notice(
      error instanceof FastViewError && error.code === "INVALID_ARGUMENT"
        ? "The clipboard is empty."
        : errorText(error),
    )
  }
}

/** Copy the names or the full paths of the marks (or the cursor entry) as text. */
export async function copyAsText(side: Side, namesOnly: boolean): Promise<void> {
  const source = operand(side)
  if (!source) return
  try {
    const res = await bridge.copyPaths(source, namesOnly)
    notice(
      `${res.count.toLocaleString()} ${namesOnly ? "names" : "paths"} copied${res.truncated ? " (the first 10,000)" : ""}`,
    )
  } catch (error) {
    notice(errorText(error))
  }
}

// Drag and drop -----------------------------------------------------------------------------

/** The data type of a panel drag (marks or the cursor entry of a side). */
export const DRAG_TYPE = "application/x-fastview-panel"

export function dragStart(side: Side, e: DragEvent): boolean {
  if (!operand(side) || !e.dataTransfer) return false
  e.dataTransfer.setData(DRAG_TYPE, side)
  e.dataTransfer.effectAllowed = "copyMove"
  return true
}

export function dragSource(e: DragEvent): Side | null {
  const v = e.dataTransfer?.getData(DRAG_TYPE)
  return v === "left" || v === "right" ? v : null
}

/** A drop on a panel, a tab or a drive: the copy dialog (Shift: move). */
export function dropOn(from: Side, target: CopyTarget, shift: boolean): void {
  setActivePanel(from)
  void openCopy(from, shift ? "move" : "copy", target)
}

/** A tab's folder as a drop target (its path; its id is looked up when the job starts). */
export function tabTarget(side: Side, index: number): CopyTarget | null {
  const t = useTabsStore.getState()[side]
  const tab = t.tabs[index]
  if (!tab?.path) return null
  if (index === t.active) return { path: panel(side).path, dirId: panel(side).dirId }
  return { path: tab.path, dirId: null }
}

export const activeSide = (): Side => usePanelsStore.getState().active

/** Tests. */
export function resetFiles(): void {
  if (noticeTimer) clearTimeout(noticeTimer)
  set({ copy: null, remove: null, mkdir: null, rename: null, notice: null })
}
