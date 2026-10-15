import type { ArchiveWarning, ConflictPolicy, SelectionDescriptor } from "@panelyth/contracts"
import { beginOwnDrag, endOwnDrag, isMarked, ownDrag } from "@panelyth/renderer-core"
import { create } from "zustand"
import { bridge, PanelythError } from "../bridge"
import {
  focusEntry,
  focusName,
  pageStoreOf,
  parentRows,
  remoteMessage,
  remoteUrl,
  useListingStore,
} from "./listing"
import { cursorDescriptor, marksDescriptor, marksOf, markNone } from "./marks"
import { otherSide, setActivePanel, usePanelsStore, type Side } from "./panels"
import { useSettingsStore } from "./settings"
import { useTabsStore } from "./tabs"
import { msg, t } from "@panelyth/i18n"

// File operations (Stage C04, CFR-11, CFR-12, CFR-27): F5 copy, F6 move,
// Shift+F5 copy here under a new name, F2 / Shift+F6 rename in place, F7
// new folder, F8 / Delete trash, Shift+F8 / Shift+Delete delete, the
// internal clipboard, and drag and drop. Every command acts on the marks, or
// on the cursor entry when nothing is marked. Jobs run on the engine v2
// queue (ADR-0029); destinations are folder ids resolved in Go (ADR-0027).

/**
 * "extract": F5 from an archive panel copies its entries out (Stage C07).
 * "download" and "upload": between a connection and this computer (Stage
 * C10.5); F6 is the same job with `move`.
 */
export type CopyKind = "copy" | "move" | "extract" | "download" | "upload"

/** What every changing command says inside an archive (ADR-0030: read-only). */
/** Source text: translate with t() where it is shown (ADR-0034). */
export const READ_ONLY = msg("Archives are read-only here. Copy files out with F5.")
const INTO_ARCHIVE = msg("Files can't be copied into an archive. Pack them with Alt+F5.")

/** Whether a panel shows an archive (Stage C07). */
export const inArchive = (side: Side): boolean => useListingStore.getState()[side].archive !== null

/** Whether a panel shows a folder of a connection (Stage C10.5, ADR-0037). */
export const inRemote = (side: Side): boolean => useListingStore.getState()[side].remote !== null

/** What a command that needs files of this computer says on a connection. */
export const NOT_ON_CONNECTION = msg(
  "This is not available on a connection. Copy the files to this computer first.",
)
const BETWEEN_SERVERS = msg(
  "Files can't be copied from one server to another. Copy them to this computer first.",
)

/** True, with that notice, when the panel shows a connection. */
export function refusedOnConnection(side: Side): boolean {
  if (!inRemote(side)) return false
  notice(t(NOT_ON_CONNECTION))
  return true
}

/** The conflict policies the copy dialog offers (UX-DESIGN "Dialogs"). */
export const POLICIES: readonly { value: ConflictPolicy; label: string }[] = [
  { value: "ask", label: msg("Ask") },
  { value: "replace", label: msg("Overwrite") },
  { value: "skip", label: msg("Skip") },
  { value: "replaceOlder", label: msg("Overwrite older") },
  { value: "renameNew", label: msg("Rename new") },
  { value: "renameExisting", label: msg("Rename existing") },
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
  /** upload: the folder on the server (the destination is then not edited). */
  remoteDirId: number | null
  /** download, upload: F6, each source is removed once its copy is whole. */
  move: boolean
  /** Shift+F5: a single item copied into its own folder under this name. */
  name: string | null
  mask: string
  conflict: ConflictPolicy
  verify: boolean
  /** extract: create links stored in the archive (inside the target only). */
  links: boolean
  /** extract: archive.check's warnings ("space", "ratio"), once known. */
  warnings: ArchiveWarning[]
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
  /** On a connection: deleted on the server, which has no trash. */
  remote: boolean
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
  return t("{count, plural, one {# item} other {# items}}", { count })
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
  if (error instanceof PanelythError) return error.message
  return String(error)
}

/** A failed command on a connection, in the user's language (details.reason). */
function remoteErrorText(error: unknown): string {
  if (!(error instanceof PanelythError)) return String(error)
  const reason = (error.details as { reason?: unknown } | undefined)?.reason
  return remoteMessage(reason, error.message)
}

// Copy and move --------------------------------------------------------------------

export interface CopyTarget {
  /** A folder path shown in the dialog (a tab, a drive root). */
  path: string
  /** Its folder id when known (a panel's open folder). */
  dirId: number | null
  /** A folder of a connection (its panel shows it): the copy is an upload. */
  remoteDirId?: number
}

const defaults = () => useSettingsStore.getState().settings

/** The other panel's folder: F5 / F6's default destination. */
export function otherPanelTarget(side: Side): CopyTarget | null {
  return panelTarget(otherSide(side))
}

/** A panel's folder as a destination: the folder it shows, on this computer or on a server. */
export function panelTarget(side: Side): CopyTarget | null {
  const p = panel(side)
  if (p.dirId === null) return null
  if (p.remote) return { path: remoteUrl(p.remote), dirId: null, remoteDirId: p.remote.dirId }
  return { path: p.path, dirId: p.dirId }
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
  if (!target && inArchive(otherSide(side))) {
    notice(t(INTO_ARCHIVE))
    return
  }
  // Between a connection and this computer (Stage C10.5): a download or an
  // upload; F6 is the same job, and removes each source once its copy is whole.
  const fromServer = inRemote(side)
  const toServer = dest.remoteDirId !== undefined
  if (fromServer && toServer) {
    notice(t(BETWEEN_SERVERS))
    return
  }
  const move = kind === "move" && (fromServer || toServer)
  if (toServer && inArchive(side)) {
    notice(t("Copy the files out of the archive first, then to the server."))
    return
  }
  if (fromServer) kind = "download"
  else if (toServer) kind = "upload"
  else if (inArchive(side)) {
    if (kind === "move") {
      notice(t(READ_ONLY))
      return
    }
    kind = "extract"
  }
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
      remoteDirId: dest.remoteDirId ?? null,
      move,
      name: null,
      mask: "*.*",
      // Settings → Operations: what the dialog starts with.
      conflict: defaults().copyConflict,
      verify: defaults().copyVerify,
      links: true,
      warnings: [],
      error: null,
    },
  })
  const info = await sizeOf(source)
  const now = get().copy
  if (info && now?.source === source)
    set({ copy: { ...now, count: info.count, bytes: info.bytes } })
  // Copying out of an archive: too little space, or a bomb, is said first.
  if (kind === "extract" && dest.dirId !== null) {
    const check = await bridge.checkArchive(source, dest.dirId).catch(() => null)
    const later = get().copy
    if (check && later?.source === source) set({ copy: { ...later, warnings: check.warnings } })
  }
}

/** Shift+F5: the cursor entry copied into its own folder under a new name. */
export function openCopyHere(side: Side): void {
  const item = cursorItem(side)
  const source = cursorDescriptor(side)
  const p = panel(side)
  if (!item || !source || p.dirId === null) return
  if (refusedOnConnection(side)) return
  if (p.archive) {
    notice(t(READ_ONLY))
    return
  }
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
      remoteDirId: null,
      move: false,
      name: item.name,
      mask: "*.*",
      conflict: defaults().copyConflict,
      verify: defaults().copyVerify,
      links: true,
      warnings: [],
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
    if (c.kind === "upload" && c.remoteDirId !== null) {
      await bridge.startJob({
        kind: "upload",
        source: { selection: c.source },
        remoteDirId: c.remoteDirId,
        conflict: c.conflict,
        ...(c.move && { move: true }),
      })
      set({ copy: null })
      if (marksDescriptor(c.side)) markNone(c.side)
      return true
    }
    if (dirId === null) {
      const typed = c.destination.trim()
      if (typed === "") throw new Error(t("Enter a destination folder."))
      dirId = (await bridge.openDir(typed)).dirId
    }
    const mask = c.mask.trim()
    if (c.kind === "download") {
      await bridge.startJob({
        kind: "download",
        source: { selection: c.source },
        destinationDirId: dirId,
        conflict: c.conflict,
        ...(c.move && { move: true }),
      })
    } else if (c.kind === "upload") {
      throw new Error(t("The connection is closed."))
    } else if (c.kind === "extract") {
      await bridge.startJob({
        kind: "extract",
        source: { selection: c.source },
        destinationDirId: dirId,
        conflict: c.conflict,
        links: c.links,
      })
    } else {
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
    }
  } catch (error) {
    const reason =
      error instanceof PanelythError ? (error.details as { reason?: string })?.reason : ""
    const message =
      error instanceof PanelythError &&
      (error.code === "NOT_FOUND" || error.code === "INVALID_PATH")
        ? t("This folder doesn't exist. Check the destination.")
        : reason === "notReady"
          ? t("The destination drive is not ready.")
          : c.kind === "download" || c.kind === "upload"
            ? remoteErrorText(error)
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
  if (p.archive) {
    notice(t(READ_ONLY))
    return
  }
  const count = source.ranges.reduce((n, [a, b]) => n + b - a, 0) + source.include.length
  // A server has no trash: F8 there always asks, and says it is for good.
  const remote = p.remote !== null
  if (remote) permanent = true
  const request: DeleteDialogState = {
    side,
    source,
    what: describe(side, count),
    count,
    bytes: null,
    permanent,
    trash: permanent ? true : null,
    next: nextSurvivor(side),
    remote,
  }
  // Settings → Confirmations: the trash needs no question (the items can be
  // taken back). Without a trash the dialog still asks, as a permanent delete does.
  if (!permanent && !defaults().confirmTrash) {
    if (await bridge.canTrash(p.dirId).catch(() => false)) return startDelete(request)
  }
  set({ remove: request })
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
  await startDelete(r)
}

async function startDelete(r: DeleteDialogState): Promise<void> {
  try {
    await bridge.startJob({
      kind: r.remote ? "remoteDelete" : r.permanent ? "delete" : "trash",
      source: { selection: r.source },
    })
    if (marksDescriptor(r.side)) markNone(r.side)
    if (r.next !== null) void focusEntry(r.side, r.next)
  } catch (error) {
    notice(r.remote ? remoteErrorText(error) : errorText(error))
  }
}

// New folder and rename ---------------------------------------------------------------------

export function openMkdir(side: Side): void {
  if (panel(side).archive) notice(t(READ_ONLY))
  else if (panel(side).dirId !== null) set({ mkdir: { side, error: null } })
}

export const closeMkdir = (): void => set({ mkdir: null })

/** F7: "a/b/c" creates the chain; the cursor lands on the new folder. */
export async function createFolder(path: string): Promise<boolean> {
  const m = get().mkdir
  const dirId = m ? panel(m.side).dirId : null
  if (!m || dirId === null) return false
  // On a connection: one folder in the folder shown; the server lists it again.
  const remote = panel(m.side).remote
  if (remote) {
    const name = path.trim()
    try {
      await bridge.remoteMkdir(remote.dirId, name)
      set({ mkdir: null })
      void focusName(m.side, name)
      return true
    } catch (error) {
      set({ mkdir: { ...m, error: remoteErrorText(error) } })
      return false
    }
  }
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
  if (panel(side).archive) {
    notice(t(READ_ONLY))
    return
  }
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
  if (inRemote(r.side)) {
    try {
      await bridge.remoteRename(r.entryId, next)
      set({ rename: null })
      // On a server the renamed entry is a new one: the cursor finds it by name.
      void focusName(r.side, next)
      return true
    } catch (error) {
      set({ rename: { ...r, error: remoteErrorText(error) } })
      return false
    }
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
  if (refusedOnConnection(side)) return
  if (panel(side).archive) {
    notice(t(READ_ONLY))
    return
  }
  try {
    const state = await bridge.clipSet(source, mode)
    notice(
      mode === "cut"
        ? t("{count, plural, one {# item} other {# items}} cut", { count: state.count })
        : t("{count, plural, one {# item} other {# items}} copied", { count: state.count }),
    )
  } catch (error) {
    notice(errorText(error))
  }
}

/** Ctrl+V: paste into the panel's folder; conflicts are asked about. */
export async function clipboardPaste(side: Side): Promise<void> {
  const dirId = panel(side).dirId
  if (dirId === null) return
  if (refusedOnConnection(side)) return
  if (panel(side).archive) {
    notice(t(INTO_ARCHIVE))
    return
  }
  try {
    await bridge.clipPaste(dirId, "ask")
  } catch (error) {
    notice(
      error instanceof PanelythError && error.code === "INVALID_ARGUMENT"
        ? t("The clipboard is empty.")
        : errorText(error),
    )
  }
}

/** Copy the names or the full paths of the marks (or the cursor entry) as text. */
export async function copyAsText(side: Side, namesOnly: boolean): Promise<void> {
  const source = operand(side)
  if (!source) return
  if (refusedOnConnection(side)) return
  try {
    const res = await bridge.copyPaths(source, namesOnly)
    const copied = namesOnly
      ? t("{count, plural, one {# name} other {# names}} copied", { count: res.count })
      : t("{count, plural, one {# path} other {# paths}} copied", { count: res.count })
    notice(res.truncated ? t("{copied} (the first 10,000)", { copied }) : copied)
  } catch (error) {
    notice(errorText(error))
  }
}

// Drag and drop -----------------------------------------------------------------------------

/** The data type of a panel drag out of an archive or a connection (marks or the cursor entry of a side). */
export const DRAG_TYPE = "application/x-panelyth-panel"

const TOO_MANY_TO_DRAG = msg("Too many items to drag at once (at most 10,000).")

/**
 * Starts a drag of the panel's marks (or its cursor entry); false when there
 * is nothing to drag. Files of this computer go out as the OS's drag
 * (ADR-0040), so other apps take them and the panels still do; entries of an
 * archive or a connection have no file to give, so they drag inside the app.
 */
export function dragStart(side: Side, e: DragEvent): boolean {
  const selection = operand(side)
  if (!selection || !e.dataTransfer) return false
  if (inArchive(side) || inRemote(side)) {
    e.dataTransfer.setData(DRAG_TYPE, side)
    e.dataTransfer.effectAllowed = "copyMove"
    return true
  }
  e.preventDefault()
  beginOwnDrag(side)
  void bridge.dragStart(selection).then(
    ({ truncated }) => {
      if (!truncated) return
      endOwnDrag()
      notice(t(TOO_MANY_TO_DRAG))
    },
    () => endOwnDrag(),
  )
  return true
}

/** The panel a drag over this view comes from, or null for anything else. */
export function dragSource(e: DragEvent): Side | null {
  const own = ownDrag<Side>(e.dataTransfer)
  if (own) return own
  const v = e.dataTransfer?.getData(DRAG_TYPE)
  return v === "left" || v === "right" ? v : null
}

/** A panel's drag is over this view (getData is empty until the drop, the types are not). */
export const isPanelDrag = (data: DataTransfer | null): boolean =>
  !!data && (data.types.includes(DRAG_TYPE) || ownDrag(data) !== null)

/** A drop on a panel, a tab or a drive: the copy dialog (Shift: move). */
export function dropOn(from: Side, target: CopyTarget, shift: boolean): void {
  setActivePanel(from)
  const source = operand(from)
  // Settings → Confirmations: a drop starts at once, with the default policy.
  // Out of an archive, or onto a folder not open yet, the dialog still shows.
  // To or from a connection it shows as well: a transfer is never started by a slip.
  if (
    !defaults().confirmDrop &&
    source &&
    target.dirId !== null &&
    !inArchive(from) &&
    !inRemote(from)
  ) {
    void bridge
      .startJob({
        kind: shift ? "move" : "copy",
        source: { selection: source },
        destinationDirId: target.dirId,
        conflict: defaults().copyConflict,
        ...(defaults().copyVerify && { verify: true }),
      })
      .then(() => {
        if (marksDescriptor(from)) markNone(from)
      })
      .catch((error: unknown) => notice(errorText(error)))
    return
  }
  void openCopy(from, shift ? "move" : "copy", target)
}

/** A tab's folder as a drop target (its path; its id is looked up when the job starts). */
export function tabTarget(side: Side, index: number): CopyTarget | null {
  const t = useTabsStore.getState()[side]
  const tab = t.tabs[index]
  if (!tab?.path) return null
  if (index === t.active) return panelTarget(side)
  // A tab on a connection that is not shown has no folder to drop on.
  if (tab.remote) return null
  return { path: tab.path, dirId: null }
}

export const activeSide = (): Side => usePanelsStore.getState().active

/** Tests. */
export function resetFiles(): void {
  if (noticeTimer) clearTimeout(noticeTimer)
  set({ copy: null, remove: null, mkdir: null, rename: null, notice: null })
}
