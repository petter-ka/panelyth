import {
  type ArchiveFormat,
  type ContentItem,
  type Crumb,
  type DirOpenResult,
  type IndexProgress,
  type QueryDescriptor,
  type QuerySnapshot,
  type SortDirection,
  type SortField,
  type SortKey,
} from "@panelyth/contracts"
import { createPageStore, type PageStore } from "@panelyth/renderer-core"
import { create } from "zustand"
import { bridge, PanelythError, isBridgeAvailable } from "../bridge"
import { usePanelsStore, type Side } from "./panels"
import { thumbsOf } from "./thumbs"
import { t } from "@panelyth/i18n"

// Panel listings (Stage C01, ADR-0028): one query session per panel in the
// all-entries scope (ADR-0026), its pages in a page store outside React
// state (ADR-0011). React sees only the session snapshot and the cursor.

export const SIDES: readonly Side[] = ["left", "right"]

/** The Full view's columns; Name takes the remaining width. */
export type ColumnId = "name" | "ext" | "size" | "date" | "attr"
export type ColumnWidths = Record<Exclude<ColumnId, "name">, number> & { name?: number }
export type ColumnOrder = ColumnId[]
export type ColumnVisibility = Record<ColumnId, boolean>
export interface ColumnPinning {
  start: ColumnId[]
  end: ColumnId[]
}
export interface ColumnLayout {
  order: ColumnOrder
  visibility: ColumnVisibility
  pinning: ColumnPinning
}
export const DEFAULT_COLUMNS: ColumnWidths = { ext: 64, size: 112, date: 168, attr: 56 }
export const DEFAULT_COLUMN_LAYOUT: ColumnLayout = {
  order: ["name", "ext", "size", "date", "attr"],
  visibility: { name: true, ext: true, size: true, date: true, attr: true },
  pinning: { start: [], end: [] },
}
export const COLUMN_LIMITS = { min: 36, max: 480, nameMin: 120, nameMax: 1600 }

/** The sort field behind each column (Go sorts, ADR-0028). */
export const COLUMN_SORT: Record<ColumnId, SortField> = {
  name: "name",
  ext: "type",
  size: "size",
  date: "modified",
  attr: "attrs",
}

export const DEFAULT_SORT: SortKey = { field: "name", direction: "asc" }

/** Full (table, Ctrl+F2) or Brief (names in columns, Ctrl+F1); per tab (ADR-0028). */
/** Full (table), Brief (name columns) or Thumbnails (tiles; Stage C10). */
export type ViewMode = "full" | "brief" | "thumbs"
export const VIEW_MODES: readonly ViewMode[] = ["full", "brief", "thumbs"]
export const readView = (v: unknown): ViewMode =>
  VIEW_MODES.includes(v as ViewMode) ? (v as ViewMode) : "full"

export type PanelErrorKind = "notFound" | "denied" | "notReady" | "network" | "remote" | "other"

export interface PanelError {
  kind: PanelErrorKind
  message: string
}

/** Search results shown in a panel (Stage C06, "Feed to panel"). */
export interface FindLocation {
  findId: number
  /** What was searched, for the path bar. */
  label: string
}

/**
 * An open archive shown in a panel (Stage C07, ADR-0030): read-only, its
 * folders listed from Go's listing. The panel's folder stays the one holding
 * the archive; ".." at the archive's root returns there.
 */
export interface ArchiveLocation {
  archiveId: number
  /** The archive file's entry in the folder (the cursor lands on it when leaving). */
  entryId: number
  name: string
  format: ArchiveFormat
  /** The folders entered inside the archive, outermost first. */
  dirs: { id: number; name: string }[]
  /** Entries with unsafe names that are not listed (zip-slip). */
  rejected: number
}

/**
 * A folder of a connection shown in a panel (Stage C10.5, ADR-0037). Like an
 * archive, it is a location over the panel's folder: `dirId` and `path` of
 * the panel stay the last local folder, and leaving the connection shows it
 * again. Rows come from the folder's listing in Go.
 */
export interface RemoteLocation {
  remoteId: number
  /** The saved connection it was opened from; null for a quick connect. */
  connectionId: number | null
  /** What the drive bar calls it: the connection's name, or user@host. */
  label: string
  host: string
  port: number
  user: string
  /** The connection uses TLS; without it the path bar says "Not encrypted". */
  encrypted: boolean
  /** The folder's id from remote.open, its path on the server and its ancestors. */
  dirId: number
  path: string
  crumbs: Crumb[]
  /** Entries the listing left out because their names cannot be listed. */
  rejected: number
}

/** What stays the same while a panel moves between the folders of a connection. */
export type RemoteBase = Omit<RemoteLocation, "dirId" | "path" | "crumbs" | "rejected">

/**
 * A tab that was on a connection which is not open: after a restart, or once
 * the connection closed. Nothing connects on its own: the panel says "Not
 * connected" and offers Connect.
 */
export interface DisconnectedLocation extends Omit<RemoteBase, "remoteId"> {
  /** Where the tab was on the server. */
  path: string
}

/** "ftp://alice@example.org/pub/photos" for the path bar and for destinations. */
export function remoteUrl(r: Pick<RemoteLocation, "host" | "port" | "user" | "path">): string {
  const host = r.host.includes(":") ? `[${r.host}]` : r.host
  const port = r.port === 21 ? "" : `:${r.port}`
  return `ftp://${r.user ? `${r.user}@` : ""}${host}${port}${r.path}`
}

export interface PanelState {
  /** The open folder; null before the first listing. */
  dirId: number | null
  path: string
  name: string
  /** Root first, ending with this folder (from Go; never parsed here). */
  crumbs: Crumb[]
  scanId: number
  progress: IndexProgress | null
  /** A navigation is in flight; the previous rows stay until the new ones arrive. */
  loading: boolean
  /** What `loading` is opening: a path (a drive, a place) or a folder's entry id; else null. */
  loadingTarget: string | number | null
  /** The last navigation failed; the previous listing (if any) is kept behind it. */
  error: PanelError | null
  query: QuerySnapshot | null
  sort: SortKey
  showHidden: boolean
  view: ViewMode
  /** Row index in the view; row 0 is ".." when the folder has a parent. */
  cursor: number
  columns: ColumnWidths
  columnOrder: ColumnOrder
  columnVisibility: ColumnVisibility
  columnPinning: ColumnPinning
  /** Increments when the view should bring the cursor into view. */
  revealToken: number
  /** Visited folders of this panel (Alt+← / Alt+→); `historyIndex` is the current one. */
  history: string[]
  historyIndex: number
  /**
   * Stage C06: the folder's subtree as one flat list of files (Ctrl+B), or a
   * search's results in place of the folder (Feed to panel). ".." leaves
   * either and shows the folder again.
   */
  branch: boolean
  find: FindLocation | null
  /** Stage C07: inside an archive. */
  archive: ArchiveLocation | null
  /** Stage C10.5: on a connection, or a tab whose connection is not open. */
  remote: RemoteLocation | null
  disconnected: DisconnectedLocation | null
  /** The panel waits for a server to list a folder (it can be stopped). */
  remoteBusy: boolean
  /** The quick filter (Ctrl+S): a name mask on the files; "" = none. Cleared by a folder change. */
  filter: string
}

const MAX_HISTORY = 50

const emptyPanel = (): PanelState => ({
  dirId: null,
  path: "",
  name: "",
  crumbs: [],
  scanId: 0,
  progress: null,
  loading: false,
  loadingTarget: null,
  error: null,
  query: null,
  sort: DEFAULT_SORT,
  showHidden: true,
  view: "full",
  cursor: 0,
  columns: { ...DEFAULT_COLUMNS },
  columnOrder: [...DEFAULT_COLUMN_LAYOUT.order],
  columnVisibility: { ...DEFAULT_COLUMN_LAYOUT.visibility },
  columnPinning: { start: [], end: [] },
  revealToken: 0,
  history: [],
  historyIndex: -1,
  branch: false,
  find: null,
  archive: null,
  remote: null,
  disconnected: null,
  remoteBusy: false,
  filter: "",
})

export const useListingStore = create<Record<Side, PanelState>>(() => ({
  left: emptyPanel(),
  right: emptyPanel(),
}))

const getPanel = (side: Side): PanelState => useListingStore.getState()[side]

export function patch(side: Side, value: Partial<PanelState>): void {
  useListingStore.setState((s) => ({ [side]: { ...s[side], ...value } }))
}

// Page stores ---------------------------------------------------------------

export const isExpired = (error: unknown): boolean =>
  error instanceof PanelythError && error.code === "NOT_FOUND"

// In the Thumbnails view a page brings the cached thumbnails of its entries
// (the viewer's pages do the same); the other views ask for none.
const makeStore = (side: Side): PageStore =>
  createPageStore({
    fetch: async (q, offset, limit) => {
      const thumbs = thumbsOf(side)
      const profile = getPanel(side).view === "thumbs" ? thumbs.getProfile() : null
      const res = await bridge.page(q, offset, limit, profile)
      if (profile) thumbs.seed(res.items, profile)
      return res
    },
    isExpired,
  })

const stores: Record<Side, PageStore> = { left: makeStore("left"), right: makeStore("right") }

export const pageStoreOf = (side: Side): PageStore => stores[side]

function bindExpired(): void {
  for (const side of SIDES) {
    // The session was evicted or the sidecar restarted: reopen it in place.
    stores[side].setExpiredHandler(() => void reopenQuery(side))
  }
}
bindExpired()

// Rows ------------------------------------------------------------------------

/**
 * 1 when row 0 is the synthetic "..": the folder has a parent, or the panel
 * shows a branch view, search results or an archive (".." goes back).
 */
export const parentRows = (p: PanelState): number =>
  p.crumbs.length > 1 || p.branch || p.find !== null || p.archive !== null || p.remote !== null
    ? 1
    : 0

/** A branch view or search results: rows come from many folders. */
export const spansFolders = (p: PanelState): boolean => p.branch || p.find !== null

export const rowCount = (p: PanelState): number =>
  p.dirId === null ? 0 : parentRows(p) + (p.query?.total ?? 0)

/** The entry id under the cursor; null on ".." or while its page is not loaded. */
export function cursorEntryId(side: Side): number | null {
  const p = getPanel(side)
  const index = p.cursor - parentRows(p)
  return index >= 0 ? (stores[side].getItem(index)?.id ?? null) : null
}

// Navigation --------------------------------------------------------------------

const seqs: Record<Side, number> = { left: 0, right: 0 }
/** The navigation that failed last, for Retry on the error state. */
const failed: Record<Side, (() => Promise<void>) | null> = { left: null, right: null }

type DescriptorState = Pick<
  PanelState,
  "sort" | "showHidden" | "branch" | "find" | "filter" | "archive" | "remote"
>

function descriptor(dirId: number, p: DescriptorState): QueryDescriptor {
  return {
    dirId,
    recursive: p.branch,
    sort: [p.sort],
    kinds: [],
    search: "",
    exts: [],
    favorite: false,
    minRating: 0,
    tags: [],
    scope: "all",
    showHidden: p.showHidden,
    ...(p.filter !== "" && { nameMask: p.filter }),
    ...(p.find && { findId: p.find.findId }),
    ...(p.archive && {
      archiveId: p.archive.archiveId,
      archiveDirId: p.archive.dirs.at(-1)?.id ?? 0,
    }),
    ...(p.remote && { remoteId: p.remote.remoteId, remoteDirId: p.remote.dirId }),
  }
}

/** Why a command on a connection failed, in the user's language (details.reason, ADR-0037). */
export function remoteMessage(reason: unknown, fallback: string): string {
  switch (reason) {
    case "closed":
      return t("The connection is closed.")
    case "timeout":
      return t("The server did not answer in time.")
    case "unreachable":
      return t("The server could not be reached.")
    case "host":
      return t("The server's name could not be found.")
    case "auth":
      return t("The server refused the user name or the password.")
    case "tlsRequired":
      return t("The server does not offer encryption (TLS).")
    case "certificate":
      return t("The server's certificate could not be verified.")
    case "notFound":
      return t("There is no such file or folder on the server.")
    case "name":
      return t("This name can't be used on a server.")
    case "tooLarge":
      return t("The connection has listed too many entries. Connect again to go on.")
    case "unsupported":
      return t("The server does not support this.")
    case "refused":
      // The server's own words.
      return t("The server said: {message}", { message: fallback })
  }
  return fallback
}

const REMOTE_REASONS: ReadonlySet<unknown> = new Set([
  "closed",
  "timeout",
  "unreachable",
  "host",
  "auth",
  "tlsRequired",
  "certificate",
  "refused",
  "tooLarge",
  "unsupported",
  "notFound",
  "name",
])

export function toPanelError(error: unknown): PanelError {
  if (!(error instanceof PanelythError)) return { kind: "other", message: String(error) }
  const reason = (error.details as { reason?: unknown } | undefined)?.reason
  if (REMOTE_REASONS.has(reason))
    return { kind: "remote", message: remoteMessage(reason, error.message) }
  switch (true) {
    case error.code === "NOT_FOUND":
      return { kind: "notFound", message: t("This folder doesn't exist anymore.") }
    case error.code === "PERMISSION_DENIED":
      return { kind: "denied", message: t("You don't have permission to open this folder.") }
    case reason === "notReady":
      return {
        kind: "notReady",
        message: t("The drive is not ready. Insert a disk or reconnect it."),
      }
    case reason === "network":
      return { kind: "network", message: t("The network location can't be reached.") }
    default:
      return { kind: "other", message: error.message }
  }
}

interface NavigateOptions {
  /** Put the cursor on this entry (the folder just left, a carried-over focus). */
  focusId?: number | null
  /** Throw instead of showing the error state (the path bar shows it inline). */
  inline?: boolean
  /** Back/forward move within the history instead of adding to it. */
  historyIndex?: number
  /** A tab being shown (tabs.ts): never branches off a locked tab. */
  tabLoad?: boolean
  /** Stage C06: show the folder as a branch view (its subtree's files). */
  branch?: boolean
}

function recordHistory(p: PanelState, path: string, jump?: number) {
  if (jump !== undefined) return { historyIndex: jump }
  if (p.history[p.historyIndex] === path) return {}
  const history = [...p.history.slice(0, p.historyIndex + 1), path].slice(-MAX_HISTORY)
  return { history, historyIndex: history.length - 1 }
}

/** dir.open → query.open → cursor; stale answers are dropped per panel. */
async function navigate(
  side: Side,
  open: () => Promise<DirOpenResult>,
  options: NavigateOptions = {},
  target: string | number | null = null,
): Promise<void> {
  // Leaving for a folder of this computer: a listing of a server is not waited for.
  stopRemoteListing(side)
  const seq = ++seqs[side]
  patch(side, { loading: true, loadingTarget: target })
  try {
    const dir = await open()
    if (seq !== seqs[side]) return
    const branch = options.branch === true
    // The quick filter stays while the panel shows the same folder.
    const filter = getPanel(side).dirId === dir.dirId ? getPanel(side).filter : ""
    const snapshot = await bridge.openQuery(
      descriptor(dir.dirId, {
        ...getPanel(side),
        branch,
        find: null,
        archive: null,
        remote: null,
        filter,
      }),
    )
    if (seq !== seqs[side]) {
      void bridge.closeQuery(snapshot.queryId).catch(() => undefined)
      return
    }
    const parent = dir.crumbs.length > 1 || branch ? 1 : 0
    let cursor = 0
    if (options.focusId) {
      const at = await bridge.indexOf(snapshot.queryId, options.focusId).catch(() => null)
      if (seq !== seqs[side]) {
        void bridge.closeQuery(snapshot.queryId).catch(() => undefined)
        return
      }
      if (at && at.index >= 0) cursor = at.index + parent
    }
    const before = getPanel(side)
    // A locked tab keeps its folder: the new one opens in a new tab (tabs.ts).
    if (
      before.dirId !== null &&
      before.dirId !== dir.dirId &&
      options.historyIndex === undefined &&
      !options.tabLoad
    ) {
      folderChangeHook?.(side)
    }
    const previous = getPanel(side).query
    if (previous && previous.queryId !== snapshot.queryId && !isParked(previous.queryId)) {
      void bridge.closeQuery(previous.queryId).catch(() => undefined)
    }
    stores[side].reset(snapshot)
    sessionChanged(side, { kind: "reset" })
    pendingFocus[side] = null
    pendingName[side] = null
    const p = getPanel(side)
    patch(side, {
      dirId: dir.dirId,
      path: dir.path,
      name: dir.name,
      crumbs: dir.crumbs,
      scanId: dir.scanId,
      progress: progressByScan.get(dir.scanId) ?? null,
      loading: false,
      error: null,
      query: snapshot,
      cursor,
      revealToken: p.revealToken + 1,
      branch,
      find: null,
      archive: null,
      remote: null,
      disconnected: null,
      filter,
      ...recordHistory(p, dir.path, options.historyIndex),
    })
    // A connection this panel just left closes when nothing else shows it.
    if (before.remote) releaseRemote(before.remote.remoteId)
    schedulePersist()
    if (side === usePanelsStore.getState().active) listeners.forEach((l) => l(side))
  } catch (error) {
    if (seq !== seqs[side]) return
    patch(side, { loading: false })
    if (options.inline) throw error
    failed[side] = () => navigate(side, open, options, target)
    patch(side, { error: toPanelError(error) })
  }
}

/** True once the panel was asked to open a folder (the startup restore leaves it alone then). */
export const hasNavigated = (side: Side): boolean => seqs[side] > 0

/** Retry on the error state: the navigation that failed, again. */
export function retry(side: Side): Promise<void> {
  return failed[side]?.() ?? refresh(side)
}

/** Home on the error state (and the first-run location). */
export async function openHome(side: Side): Promise<void> {
  const home = await bridge.homePath().catch(() => null)
  if (home) await openPath(side, home)
}

// Each panel's scans run in its own lane, so one panel never stops the
// other's listing or branch view (Stage C06).
export const openPath = (side: Side, path: string, options?: NavigateOptions): Promise<void> =>
  navigate(side, () => bridge.openDir(path, side, options?.branch === true), options, path)

export const openFolderEntry = (
  side: Side,
  entryId: number,
  options?: NavigateOptions,
): Promise<void> => navigate(side, () => bridge.openDirEntry(entryId, side), options, entryId)

/** "Go to file" (Stage C06): the entry's folder, with the cursor on the entry. */
export const goToEntry = (side: Side, entryId: number): Promise<void> =>
  navigate(side, () => bridge.openContaining(entryId, side), { focusId: entryId })

/**
 * Backspace, Ctrl+PgUp, Enter on "..": the cursor lands on the folder just
 * left. In a branch view or search results it shows the folder again.
 */
/** Whether goUp moves: off a server or out of an archive, results or a branch, or to a parent folder. */
export const canGoUp = (p: PanelState): boolean =>
  p.remote !== null ||
  p.archive !== null ||
  (p.dirId !== null && (spansFolders(p) || p.crumbs.length > 1))

export function goUp(side: Side): Promise<void> {
  const p = getPanel(side)
  if (p.remote) {
    // Up on the server; from its root, back to the folder of this computer.
    const parent = p.remote.crumbs.at(-2)
    if (!parent) return openPath(side, p.path)
    return openRemoteDir(side, p.remote, parent.path, { focusId: p.remote.dirId })
  }
  if (p.archive) {
    const left = p.archive.dirs.at(-1)
    if (!left) return openPath(side, p.path, { focusId: p.archive.entryId })
    return showArchive(side, { ...p.archive, dirs: p.archive.dirs.slice(0, -1) }, left.id)
  }
  if (p.dirId !== null && spansFolders(p)) return openPath(side, p.path)
  const parent = p.crumbs.at(-2)
  if (!parent || p.dirId === null) return Promise.resolve()
  return openPath(side, parent.path, { focusId: p.dirId })
}

/** Ctrl+B: the folder's subtree as one flat list of files, or back to the folder. */
export function toggleBranch(side: Side): Promise<void> {
  const p = getPanel(side)
  if (p.dirId === null || p.find || p.archive || p.remote) return Promise.resolve()
  return openPath(side, p.path, { branch: !p.branch, focusId: cursorEntryId(side) })
}

/** Ctrl+S: the quick filter; "" clears it. A new session, never a rescan. */
export function setFilter(side: Side, mask: string): void {
  const filter = mask.trim()
  if (getPanel(side).filter === filter) return
  patch(side, { filter })
  void reopenQuery(side)
}

/**
 * Feed to panel (Stage C06): the search's results in place of the folder,
 * in the panel's sort; ".." shows the folder again. Results keep arriving
 * while the search runs.
 */
export async function showFindResults(side: Side, find: FindLocation): Promise<void> {
  const p = getPanel(side)
  if (p.dirId === null) return
  const seq = ++seqs[side]
  const snapshot = await bridge.openQuery(
    descriptor(p.dirId, { ...p, branch: false, find, archive: null, remote: null, filter: "" }),
  )
  if (seq !== seqs[side]) {
    void bridge.closeQuery(snapshot.queryId).catch(() => undefined)
    return
  }
  const previous = getPanel(side).query
  if (previous && previous.queryId !== snapshot.queryId && !isParked(previous.queryId)) {
    void bridge.closeQuery(previous.queryId).catch(() => undefined)
  }
  stores[side].reset(snapshot)
  sessionChanged(side, { kind: "reset" })
  pendingFocus[side] = null
  patch(side, {
    query: snapshot,
    branch: false,
    find,
    archive: null,
    remote: null,
    disconnected: null,
    filter: "",
    error: null,
    loading: false,
    scanId: 0,
    progress: null,
    cursor: 0,
    revealToken: getPanel(side).revealToken + 1,
  })
  if (p.remote) releaseRemote(p.remote.remoteId)
  if (side === usePanelsStore.getState().active) listeners.forEach((l) => l(side))
}

// Archives (Stage C07, ADR-0030) ------------------------------------------------

/** Archive file names the commander tries to open (Go decides; 7-Zip formats need the tool). */
const ARCHIVE_NAME =
  /\.(zip|tar|tgz|tbz2?|gz|7z|rar|xz|txz|lzma|bz2|cab|iso|arj|lzh|lha|wim|zst|tzst|cpio|rpm|deb)$/i

export const isArchiveName = (name: string): boolean => ARCHIVE_NAME.test(name)

/** "D:\\Photos\\set.zip\\docs\\2026" for the path bar (the folder's own separator). */
export function archivePath(folder: string, a: ArchiveLocation): string {
  const sep = folder.includes("\\") ? "\\" : "/"
  const base = folder.endsWith(sep) ? folder.slice(0, -1) : folder
  return [base, a.name, ...a.dirs.map((d) => d.name)].join(sep)
}

/** Why an archive can't be opened, from archive.open's error. */
export type ArchiveOpenFailure = "notArchive" | "noTool" | "other"

type ArchiveFailureHandler = (
  side: Side,
  item: ContentItem,
  why: ArchiveOpenFailure,
  message: string,
) => void
let archiveFailure: ArchiveFailureHandler | null = null

/** open.ts: what happens when an archive can't be entered (open it with its app, say why). */
export function setArchiveFailureHandler(handler: ArchiveFailureHandler | null): void {
  archiveFailure = handler
}

/**
 * Enter (or Ctrl+PgDn) on an archive: Go lists it once, then its root opens
 * in the panel like a folder. Leaving goes back with the cursor on the file.
 */
export async function enterArchive(side: Side, item: ContentItem): Promise<void> {
  const p = getPanel(side)
  if (p.dirId === null) return
  const seq = ++seqs[side]
  patch(side, { loading: true, loadingTarget: item.id })
  try {
    const opened = await bridge.openArchive(item.id)
    if (seq !== seqs[side]) {
      void bridge.closeArchive(opened.archiveId).catch(() => undefined)
      return
    }
    await showArchive(side, {
      archiveId: opened.archiveId,
      entryId: item.id,
      name: item.name,
      format: opened.format,
      dirs: [],
      rejected: opened.rejected,
    })
  } catch (error) {
    if (seq !== seqs[side]) return
    patch(side, { loading: false })
    const reason =
      error instanceof PanelythError
        ? (error.details as { reason?: string } | undefined)?.reason
        : undefined
    const why: ArchiveOpenFailure =
      reason === "notArchive" ? "notArchive" : reason === "noTool" ? "noTool" : "other"
    archiveFailure?.(side, item, why, error instanceof Error ? error.message : String(error))
  }
}

/**
 * Shows a folder of an open archive (a new session over Go's listing);
 * focusId puts the cursor on an entry (the folder just left).
 */
async function showArchive(side: Side, archive: ArchiveLocation, focusId?: number): Promise<void> {
  const p = getPanel(side)
  if (p.dirId === null) return
  const seq = ++seqs[side]
  try {
    const snapshot = await bridge.openQuery(
      descriptor(p.dirId, { ...p, branch: false, find: null, archive, remote: null, filter: "" }),
    )
    let cursor = 0
    if (focusId !== undefined) {
      const at = await bridge.indexOf(snapshot.queryId, focusId).catch(() => null)
      if (at && at.index >= 0) cursor = at.index + 1
    }
    if (seq !== seqs[side]) {
      void bridge.closeQuery(snapshot.queryId).catch(() => undefined)
      return
    }
    const previous = getPanel(side).query
    if (previous && previous.queryId !== snapshot.queryId && !isParked(previous.queryId)) {
      void bridge.closeQuery(previous.queryId).catch(() => undefined)
    }
    stores[side].reset(snapshot)
    sessionChanged(side, { kind: "reset" })
    pendingFocus[side] = null
    patch(side, {
      query: snapshot,
      branch: false,
      find: null,
      archive,
      filter: "",
      error: null,
      loading: false,
      scanId: 0,
      progress: null,
      cursor,
      revealToken: getPanel(side).revealToken + 1,
    })
    if (side === usePanelsStore.getState().active) listeners.forEach((l) => l(side))
  } catch (error) {
    if (seq !== seqs[side]) return
    // The archive was closed (a sidecar restart): the folder again.
    if (isExpired(error)) void openPath(side, p.path, { focusId: archive.entryId })
    else patch(side, { error: toPanelError(error), loading: false })
  }
}

/** Alt+← / Alt+→: the panel's previous or next folder. */
export function goHistory(side: Side, step: -1 | 1): Promise<void> {
  return jumpHistory(side, getPanel(side).historyIndex + step)
}

/** The history menu (Alt+↓): any folder of the tab's history, keeping the history. */
export function jumpHistory(side: Side, index: number): Promise<void> {
  const p = getPanel(side)
  const path = p.history[index]
  if (path === undefined || index === p.historyIndex) return Promise.resolve()
  return openPath(side, path, { historyIndex: index })
}

/** Ctrl+\: the root of the panel's drive or file system. */
/** Whether goRoot moves: not already at the drive's (or the server's) root. */
export const canGoRoot = (p: PanelState): boolean =>
  p.remote ? p.remote.path !== "/" : p.crumbs.length > 1

export function goRoot(side: Side): Promise<void> {
  const remote = getPanel(side).remote
  if (remote) {
    return remote.path === "/" ? Promise.resolve() : openRemoteDir(side, remote, "/")
  }
  const root = getPanel(side).crumbs[0]
  return root && getPanel(side).crumbs.length > 1 ? openPath(side, root.path) : Promise.resolve()
}

/**
 * Ctrl+← / Ctrl+→: the folder under the active panel's cursor (".." is the
 * parent; a file means the panel's own folder) opens in the left or right
 * panel.
 */
export function openIn(target: Side, from: Side): Promise<void> {
  const p = getPanel(from)
  // A folder of a connection opens in its own panel only.
  if (p.remote) return Promise.resolve()
  // Inside an archive: the folder holding it.
  if (p.archive && p.dirId !== null) {
    return target === from ? Promise.resolve() : openFolderEntry(target, p.dirId)
  }
  if (p.dirId === null) return Promise.resolve()
  const index = p.cursor - parentRows(p)
  if (index < 0) {
    const parent = p.crumbs.at(-2)
    return parent ? openPath(target, parent.path) : Promise.resolve()
  }
  const item = stores[from].getItem(index)
  if (item?.kind === "dir") return openFolderEntry(target, item.id)
  return target === from ? Promise.resolve() : openFolderEntry(target, p.dirId)
}

/**
 * Ctrl+U: the panels trade places: folders, sessions, sorts, cursors and
 * history (marks follow in marks.ts). In-flight navigations are dropped.
 */
export function swapPanels(): void {
  // A listing a server has not answered yet belongs to the side that asked: it is not carried across.
  stopRemoteListing("left")
  stopRemoteListing("right")
  seqs.left++
  seqs.right++
  ;[stores.left, stores.right] = [stores.right, stores.left]
  ;[failed.left, failed.right] = [failed.right, failed.left]
  bindExpired()
  const { left, right } = useListingStore.getState()
  useListingStore.setState({
    left: { ...right, revealToken: right.revealToken + 1 },
    right: { ...left, revealToken: left.revealToken + 1 },
  })
  schedulePersist()
  listeners.forEach((l) => l(usePanelsStore.getState().active))
}

type FileOpener = (side: Side, item: ContentItem) => Promise<void>
let fileOpener: FileOpener | null = null

/** Enter on a file (Stage C05, features/open.ts): routes media to the shared overlay by default. */
export function setFileOpener(opener: FileOpener | null): void {
  fileOpener = opener
}

/** Enter and double-click: folders open in the panel; files use the configured opener. */
export function enter(side: Side): Promise<void> {
  const p = getPanel(side)
  const index = p.cursor - parentRows(p)
  if (index < 0) return goUp(side)
  const item = stores[side].getItem(index)
  if (item?.kind === "dir" && p.remote) return openRemoteDir(side, p.remote, item.id)
  if (item?.kind === "dir" && p.archive) {
    return showArchive(side, {
      ...p.archive,
      dirs: [...p.archive.dirs, { id: item.id, name: item.name }],
    })
  }
  if (item?.kind === "dir") return openFolderEntry(side, item.id)
  if (item && !p.archive && !p.remote && isArchiveName(item.name)) return enterArchive(side, item)
  if (item && fileOpener) return fileOpener(side, item)
  return Promise.resolve()
}

/** Ctrl+PgDn: enters the archive under the cursor (Enter does too). */
export function enterArchiveAtCursor(side: Side): Promise<void> {
  const p = getPanel(side)
  const index = p.cursor - parentRows(p)
  const item = index >= 0 ? stores[side].getItem(index) : undefined
  if (!item || item.kind === "dir" || p.archive || p.remote) return Promise.resolve()
  return enterArchive(side, item)
}

/** Ctrl+R: re-list the folder; the session stays, so the cursor and scroll stay too. */
export async function refresh(side: Side): Promise<void> {
  const p = getPanel(side)
  if (!p.path) return
  // A folder of a connection is read from the server again; its session
  // shows the new listing when Go has it (query.invalidated).
  if (p.remote) {
    const remote = p.remote
    if (p.error || !p.query) return openRemoteDir(side, remote, remote.path)
    try {
      await bridge.remoteOpen(remote.remoteId, remote.path)
    } catch (error) {
      if (getPanel(side).remote?.remoteId === remote.remoteId)
        remoteFailed(side, remote, error, () => refresh(side))
    }
    return
  }
  if (p.error || !p.query) return openPath(side, p.path, { branch: p.branch })
  // Search results follow file changes on their own; an archive is read once.
  if (p.find || p.archive) return
  try {
    const dir = await bridge.openDir(p.path, side, p.branch)
    if (getPanel(side).dirId !== dir.dirId) return
    patch(side, { scanId: dir.scanId, crumbs: dir.crumbs, progress: null })
  } catch (error) {
    patch(side, { error: toPanelError(error) })
  }
}

/** Esc on the error state: back to the listing that is still loaded behind it. */
export function dismissError(side: Side): void {
  patch(side, { error: null })
}

/** Reopens the session with the panel's sort and hidden setting; the cursor follows its entry. */
async function reopenQuery(side: Side): Promise<void> {
  const p = getPanel(side)
  if (p.dirId === null) return
  const seq = ++seqs[side]
  const focusId = cursorEntryId(side)
  try {
    const snapshot = await bridge.openQuery(descriptor(p.dirId, p))
    let cursor = parentRows(p) > 0 && p.cursor === 0 ? 0 : -1
    if (cursor < 0 && focusId !== null) {
      const at = await bridge.indexOf(snapshot.queryId, focusId).catch(() => null)
      if (at && at.index >= 0) cursor = at.index + parentRows(p)
    }
    if (seq !== seqs[side]) {
      void bridge.closeQuery(snapshot.queryId).catch(() => undefined)
      return
    }
    const previous = getPanel(side).query
    if (previous && previous.queryId !== snapshot.queryId && !isParked(previous.queryId)) {
      void bridge.closeQuery(previous.queryId).catch(() => undefined)
    }
    stores[side].reset(snapshot)
    sessionChanged(side, { kind: "reset" })
    patch(side, {
      query: snapshot,
      cursor: cursor >= 0 ? cursor : 0,
      revealToken: getPanel(side).revealToken + 1,
    })
  } catch (error) {
    if (seq !== seqs[side]) return
    // The results of a search that was forgotten, or a closed archive: the folder again.
    if (p.remote) remoteFailed(side, p.remote, error, () => reopenQuery(side))
    else if ((p.find || p.archive) && isExpired(error))
      void openPath(side, p.path, p.archive ? { focusId: p.archive.entryId } : undefined)
    else patch(side, { error: toPanelError(error) })
  }
}

// Tab sessions (Stage C03, ADR-0028) ------------------------------------------------
// Only the visible tab holds a session. A tab being left parks its session
// for a short grace period, so switching back and forth reuses it; then it
// closes. Invalidations keep a parked snapshot current.

export const TAB_GRACE_MS = 3000

interface ParkedSession {
  dirId: number
  path: string
  name: string
  crumbs: Crumb[]
  query: QuerySnapshot
  branch: boolean
  find: FindLocation | null
  archive: ArchiveLocation | null
  remote: RemoteLocation | null
  filter: string
  timer: ReturnType<typeof setTimeout>
}

const parked = new Map<number, ParkedSession>()

const isParked = (queryId: number): boolean =>
  [...parked.values()].some((s) => s.query.queryId === queryId)

/** Tests and benchmarks: the parked sessions' query ids. */
export const parkedQueryIds = (): number[] => [...parked.values()].map((s) => s.query.queryId)

/** Closes a parked session now (its tab closed, or the grace period ended). */
export function dropParked(tabId: number): void {
  const s = parked.get(tabId)
  if (!s) return
  clearTimeout(s.timer)
  parked.delete(tabId)
  // Still on screen behind a failed navigation: the next navigation closes it.
  if (SIDES.some((side) => getPanel(side).query?.queryId === s.query.queryId)) return
  void bridge.closeQuery(s.query.queryId).catch(() => undefined)
  if (s.remote) releaseRemote(s.remote.remoteId)
}

/** A tab is being left: its session stays open for TAB_GRACE_MS. */
export function parkSession(side: Side, tabId: number): void {
  const p = getPanel(side)
  dropParked(tabId)
  if (!p.query || p.dirId === null) return
  parked.set(tabId, {
    dirId: p.dirId,
    path: p.path,
    name: p.name,
    crumbs: p.crumbs,
    query: p.query,
    branch: p.branch,
    find: p.find,
    archive: p.archive,
    remote: p.remote,
    filter: p.filter,
    timer: setTimeout(() => dropParked(tabId), TAB_GRACE_MS),
  })
}

/** Drops in-flight navigations of a panel (a tab switch supersedes them). */
export function cancelNavigation(side: Side): void {
  stopRemoteListing(side)
  seqs[side]++
  failed[side] = null
}

/**
 * Shows a tab's parked session again, if it is still open: rows come from
 * the session at once, the cursor goes back to its entry, and the folder is
 * re-listed in the background. False when nothing was parked.
 */
export function adoptSession(side: Side, tabId: number, focusId: number | null): boolean {
  const s = parked.get(tabId)
  if (!s) return false
  clearTimeout(s.timer)
  parked.delete(tabId)
  const seq = ++seqs[side]
  const previous = getPanel(side).query
  if (previous && previous.queryId !== s.query.queryId && !isParked(previous.queryId)) {
    void bridge.closeQuery(previous.queryId).catch(() => undefined)
  }
  stores[side].reset(s.query)
  sessionChanged(side, { kind: "reset" })
  const p = getPanel(side)
  patch(side, {
    dirId: s.dirId,
    path: s.path,
    name: s.name,
    crumbs: s.crumbs,
    scanId: 0,
    progress: null,
    loading: false,
    error: null,
    query: s.query,
    branch: s.branch,
    find: s.find,
    archive: s.archive,
    remote: s.remote,
    disconnected: null,
    filter: s.filter,
    cursor: 0,
    revealToken: p.revealToken + 1,
  })
  if (side === usePanelsStore.getState().active) listeners.forEach((l) => l(side))
  void (async () => {
    if (focusId !== null) {
      const at = await bridge.indexOf(s.query.queryId, focusId).catch(() => null)
      if (seq !== seqs[side]) return
      if (at && at.index >= 0) {
        patch(side, {
          cursor: at.index + parentRows(getPanel(side)),
          revealToken: getPanel(side).revealToken + 1,
        })
      }
    }
    // A local folder is listed again in the background; a server is asked
    // nothing just because a tab is shown again (Ctrl+R reads it again).
    if (seq === seqs[side] && !s.remote) await refresh(side)
  })()
  return true
}

// Connections (Stage C10.5, ADR-0037) ---------------------------------------------------

interface RemoteOpenOptions {
  /** Put the cursor on this entry (the folder just left). */
  focusId?: number
  /** Throw instead of showing the error state (the path bar shows it inline). */
  inline?: boolean
}

// Connects and listings that can be cancelled share one numbering (remote.cancel).
let lastAttempt = 0
export const nextRemoteAttempt = (): number => ++lastAttempt

/** The listing of a server each panel waits for, by its attempt. */
const pendingRemote: Record<Side, number | null> = { left: null, right: null }

/**
 * Stops the listing a panel waits for (Stop, Esc, or the panel moved on): a
 * server that does not answer would hold it for the command timeout.
 */
export function stopRemoteListing(side: Side): boolean {
  const attempt = pendingRemote[side]
  if (attempt === null) return false
  pendingRemote[side] = null
  seqs[side]++
  patch(side, { loading: false, loadingTarget: null, remoteBusy: false })
  void bridge.remoteCancel(attempt).catch(() => undefined)
  return true
}

/** Other places that still show a connection (tabs.ts: tabs that are not visible). */
let remoteHolders: (() => Iterable<number>) | null = null
export function setRemoteHolders(holders: (() => Iterable<number>) | null): void {
  remoteHolders = holders
}

/**
 * A panel, a parked session or a tab stopped showing a connection: when
 * nothing shows it any more, it is closed. Connections are not kept open
 * behind the user's back.
 */
export function releaseRemote(remoteId: number): void {
  const shown =
    SIDES.some((side) => getPanel(side).remote?.remoteId === remoteId) ||
    [...parked.values()].some((s) => s.remote?.remoteId === remoteId) ||
    [...(remoteHolders?.() ?? [])].includes(remoteId)
  if (!shown && isBridgeAvailable()) void bridge.remoteDisconnect(remoteId).catch(() => undefined)
}

const reasonOf = (error: unknown): unknown =>
  error instanceof PanelythError
    ? (error.details as { reason?: unknown } | undefined)?.reason
    : undefined

/**
 * A command on a connection failed in a panel. A connection that is closed
 * becomes "Not connected" there (with Connect); anything else is the error
 * state with Retry.
 */
function remoteFailed(
  side: Side,
  remote: RemoteBase & { path: string },
  error: unknown,
  again: () => Promise<void>,
): void {
  if (reasonOf(error) !== "closed" && !isExpired(error)) {
    failed[side] = again
    patch(side, { loading: false, error: toPanelError(error) })
    return
  }
  const p = getPanel(side)
  // Rows of the closed connection go; a folder of this computer shown behind stays.
  if (p.remote) {
    if (p.query && !isParked(p.query.queryId))
      void bridge.closeQuery(p.query.queryId).catch(() => undefined)
    stores[side].reset(null)
    patch(side, { remote: null, query: null, cursor: 0 })
    sessionChanged(side, { kind: "reset" })
  }
  patch(side, {
    loading: false,
    error: null,
    disconnected: {
      connectionId: remote.connectionId,
      label: remote.label,
      host: remote.host,
      port: remote.port,
      user: remote.user,
      encrypted: remote.encrypted,
      path: remote.path,
    },
  })
  schedulePersist()
}

/**
 * Shows a folder of a connection in a panel: the server lists it once
 * (remote.open), then a session over that listing is the panel's rows, as
 * for any folder. `folder` is a path on the server or a folder's entry id.
 */
export async function openRemoteDir(
  side: Side,
  base: RemoteBase,
  folder: string | number,
  options: RemoteOpenOptions = {},
): Promise<void> {
  const p = getPanel(side)
  if (p.dirId === null) return
  // A listing this one replaces is not left waiting on the server.
  stopRemoteListing(side)
  const seq = ++seqs[side]
  const attempt = nextRemoteAttempt()
  pendingRemote[side] = attempt
  // No loadingTarget: it names a drive being opened, and "/" is one elsewhere.
  patch(side, { loading: true, loadingTarget: null, remoteBusy: true })
  const done = (): void => {
    if (pendingRemote[side] !== attempt) return
    pendingRemote[side] = null
    patch(side, { remoteBusy: false })
  }
  const remote: RemoteBase = {
    remoteId: base.remoteId,
    connectionId: base.connectionId,
    label: base.label,
    host: base.host,
    port: base.port,
    user: base.user,
    encrypted: base.encrypted,
  }
  try {
    const dir = await bridge.remoteOpen(remote.remoteId, folder, attempt).finally(done)
    if (seq !== seqs[side]) return
    const location: RemoteLocation = {
      ...remote,
      dirId: dir.remoteDirId,
      path: dir.path,
      crumbs: dir.crumbs,
      rejected: dir.rejected,
    }
    const now = getPanel(side)
    const snapshot = await bridge.openQuery(
      descriptor(p.dirId, {
        ...now,
        branch: false,
        find: null,
        archive: null,
        remote: location,
        filter: "",
      }),
    )
    let cursor = 0
    if (options.focusId !== undefined) {
      const at = await bridge.indexOf(snapshot.queryId, options.focusId).catch(() => null)
      if (at && at.index >= 0) cursor = at.index + 1
    }
    if (seq !== seqs[side]) {
      void bridge.closeQuery(snapshot.queryId).catch(() => undefined)
      return
    }
    const before = getPanel(side)
    const previous = before.query
    if (previous && previous.queryId !== snapshot.queryId && !isParked(previous.queryId)) {
      void bridge.closeQuery(previous.queryId).catch(() => undefined)
    }
    stores[side].reset(snapshot)
    sessionChanged(side, { kind: "reset" })
    pendingFocus[side] = null
    pendingName[side] = null
    patch(side, {
      query: snapshot,
      branch: false,
      find: null,
      archive: null,
      remote: location,
      disconnected: null,
      filter: "",
      error: null,
      loading: false,
      scanId: 0,
      progress: null,
      cursor,
      revealToken: before.revealToken + 1,
    })
    // Another connection was showing here: it closes when nothing else shows it.
    if (before.remote && before.remote.remoteId !== remote.remoteId)
      releaseRemote(before.remote.remoteId)
    schedulePersist()
    if (side === usePanelsStore.getState().active) listeners.forEach((l) => l(side))
  } catch (error) {
    if (seq !== seqs[side]) return
    patch(side, { loading: false })
    if (options.inline) throw error
    const shown = getPanel(side).remote
    const path =
      typeof folder === "string" ? folder : shown?.remoteId === remote.remoteId ? shown.path : "/"
    remoteFailed(side, { ...remote, path }, error, () => openRemoteDir(side, base, folder, options))
  }
}

/** The panel shows that its tab's connection is not open (tabs.ts, session.ts). */
export function showDisconnected(side: Side, disconnected: DisconnectedLocation | null): void {
  patch(side, { disconnected })
}

/**
 * "Show the folder" on "Not connected": the tab stops being a tab of the
 * connection and shows the folder of this computer it had behind it.
 */
export function leaveDisconnected(side: Side): Promise<void> {
  const p = getPanel(side)
  if (!p.disconnected) return Promise.resolve()
  patch(side, { disconnected: null })
  schedulePersist()
  return p.query ? Promise.resolve() : openPath(side, p.path)
}

/**
 * A connection was closed (Disconnect, or the server is gone): panels that
 * show it go back to their folder of this computer, and parked sessions over
 * it are dropped.
 */
export function remoteClosed(remoteId: number): void {
  for (const [tabId, s] of [...parked]) {
    if (s.remote?.remoteId === remoteId) dropParked(tabId)
  }
  for (const side of SIDES) {
    const p = getPanel(side)
    if (p.remote?.remoteId === remoteId) void openPath(side, p.path)
  }
}

let folderChangeHook: ((side: Side) => void) | null = null

/** tabs.ts: called before a panel shows another folder (a locked tab branches off). */
export function setFolderChangeHook(hook: ((side: Side) => void) | null): void {
  folderChangeHook = hook
}

/** Ctrl+F1 / Ctrl+F2 / Ctrl+Shift+F1: the Brief, the Full or the Thumbnails view. */
export function setView(side: Side, view: ViewMode): void {
  if (getPanel(side).view === view) return
  patch(side, { view, revealToken: getPanel(side).revealToken + 1 })
  schedulePersist()
}

/** A header click or Ctrl+F3…F6: that column ascending, or reversed when it already sorts. */
export function toggleSort(side: Side, field: SortField): void {
  const { sort } = getPanel(side)
  const direction: SortDirection = sort.field === field && sort.direction === "asc" ? "desc" : "asc"
  setSort(side, { field, direction })
}

export function setSort(side: Side, sort: SortKey): void {
  const p = getPanel(side)
  if (p.sort.field === sort.field && p.sort.direction === sort.direction) return
  patch(side, { sort })
  schedulePersist()
  void reopenQuery(side)
}

/** Ctrl+H: hidden and system entries on or off (a new session; no rescan). */
export function toggleHidden(side: Side): void {
  setHidden(side, !getPanel(side).showHidden)
}

/** Hidden and system entries (dot-names too) on or off in one panel. */
export function setHidden(side: Side, showHidden: boolean): void {
  if (getPanel(side).showHidden === showHidden) return
  patch(side, { showHidden })
  schedulePersist()
  void reopenQuery(side)
}

export function setColumns(side: Side, columns: ColumnWidths): void {
  patch(side, { columns })
  schedulePersist()
}

/** Persists the table's visual layout alongside its widths for this panel. */
export function setColumnLayout(side: Side, layout: ColumnLayout): void {
  patch(side, {
    columnOrder: layout.order,
    columnVisibility: layout.visibility,
    columnPinning: layout.pinning,
  })
  schedulePersist()
}

/** Moves the cursor, clamped to the rows (arrows, PgUp/PgDn, Home/End, click). */
export function moveCursor(side: Side, index: number): void {
  const p = getPanel(side)
  const last = rowCount(p) - 1
  const cursor = Math.max(0, Math.min(last, index))
  if (cursor !== p.cursor) patch(side, { cursor })
}

/** Stop in the status line: cancels the folder's listing scan. */
export function stopListing(side: Side): void {
  const { scanId } = getPanel(side)
  if (scanId) void bridge.cancelScan(scanId).catch(() => undefined)
}

/**
 * A panel's session changed: "reset" for a new session (navigation, sort,
 * hidden toggle), "invalidated" when the same session got a new version
 * (marks are rebased, marks.ts).
 */
export type SessionChange =
  { kind: "reset" } | { kind: "invalidated"; queryId: number; from: number; to: number }
const sessionListeners = new Set<(side: Side, change: SessionChange) => void>()
export function onSessionChanged(
  listener: (side: Side, change: SessionChange) => void,
): () => void {
  sessionListeners.add(listener)
  return () => sessionListeners.delete(listener)
}
const sessionChanged = (side: Side, change: SessionChange): void =>
  sessionListeners.forEach((l) => l(side, change))

// The active panel changed folder: the shared context follows (carry.ts).
const listeners = new Set<(side: Side) => void>()
export function onActiveFolderChanged(listener: (side: Side) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Events: invalidation, progress, visibility -------------------------------------

const progressByScan = new Map<number, IndexProgress>()
let visible = true
const pendingInvalidation: Record<Side, QuerySnapshot | null> = { left: null, right: null }

export const isCommanderVisible = (): boolean => visible

// After a file operation (Stage C04) the cursor goes to an entry that may
// not be in the session yet: the new folder, the renamed entry, the entry
// after the deleted ones. It is placed when an invalidation brings it in.
const pendingFocus: Record<Side, number | null> = { left: null, right: null }

/** Puts the cursor on the entry now if the session has it, else after the next invalidation that does. */
export async function focusEntry(side: Side, entryId: number): Promise<void> {
  const query = getPanel(side).query
  if (!query) return
  pendingFocus[side] = entryId
  const at = await bridge.indexOf(query.queryId, entryId).catch(() => null)
  if (!at || at.index < 0 || getPanel(side).query?.queryId !== query.queryId) return
  if (pendingFocus[side] !== entryId) return // a later request won
  pendingFocus[side] = null
  const p = getPanel(side)
  patch(side, { cursor: at.index + parentRows(p), revealToken: p.revealToken + 1 })
}

// A connection's new folder or renamed entry has no id until the server
// listed it: the cursor goes to it by its name (Stage C10.5).
const pendingName: Record<Side, string | null> = { left: null, right: null }

/**
 * Puts the cursor on the entry with this name now if the session lists it,
 * else when the next invalidation brings it in.
 */
export async function focusName(side: Side, name: string): Promise<void> {
  // "*" and "?" are wildcards to query.locate.
  if (/[*?]/.test(name)) return
  pendingName[side] = name
  await placeOnName(side)
}

/** True once the cursor is on the awaited name. */
async function placeOnName(side: Side): Promise<boolean> {
  const name = pendingName[side]
  const query = getPanel(side).query
  if (name === null || !query) return false
  const still = (): boolean =>
    pendingName[side] === name && getPanel(side).query?.queryId === query.queryId
  const at = await bridge.locate(query.queryId, name, 0, "forward").catch(() => null)
  if (!at || at.index < 0 || !still()) return false
  const item = await stores[side].ensureIndex(at.index).catch(() => undefined)
  if (item?.name !== name || !still()) return false
  pendingName[side] = null
  const p = getPanel(side)
  patch(side, { cursor: at.index + parentRows(p), revealToken: p.revealToken + 1 })
  return true
}

async function applyInvalidation(side: Side, snapshot: QuerySnapshot): Promise<void> {
  const p = getPanel(side)
  if (p.query?.queryId !== snapshot.queryId || snapshot.version <= p.query.version) return
  // The cursor follows its entry when rows move (inserted or removed above
  // it), or goes to the entry a file operation asked for.
  const pending = pendingFocus[side]
  const focusId = pending ?? cursorEntryId(side)
  const from = p.query.version
  stores[side].invalidate(snapshot)
  patch(side, { query: snapshot })
  sessionChanged(side, {
    kind: "invalidated",
    queryId: snapshot.queryId,
    from,
    to: snapshot.version,
  })
  // An entry awaited by its name (a server's new folder): this listing has it, or it never comes.
  if (pendingName[side] !== null) {
    const placed = await placeOnName(side)
    pendingName[side] = null
    if (placed) return
  }
  if (focusId === null) {
    moveCursor(side, getPanel(side).cursor)
    return
  }
  const cursorBefore = getPanel(side).cursor
  const at = await bridge.indexOf(snapshot.queryId, focusId).catch(() => null)
  const now = getPanel(side)
  if (!at || now.query?.queryId !== snapshot.queryId) return
  // Keys moved the cursor while Go looked the entry up: the user's move wins
  // over following the old entry (a file operation's focus still applies).
  if (pending === null && now.cursor !== cursorBefore) return
  if (at.index >= 0) {
    if (pending !== null && pendingFocus[side] === pending) {
      pendingFocus[side] = null
      patch(side, { revealToken: now.revealToken + 1 })
    }
    moveCursor(side, at.index + parentRows(now))
  } else moveCursor(side, now.cursor)
}

/** Subscribes the panels to sidecar events; returns the unsubscribe. */
export function startListingEvents(onShown: () => void): () => void {
  if (!isBridgeAvailable()) return () => undefined
  const offs = [
    bridge.on("query.invalidated", (snapshot) => {
      for (const s of parked.values()) {
        if (s.query.queryId === snapshot.queryId && snapshot.version > s.query.version) {
          s.query = snapshot
        }
      }
      for (const side of SIDES) {
        if (getPanel(side).query?.queryId !== snapshot.queryId) continue
        // A hidden app makes no page requests (docs/shared/APP-SWITCHING.md).
        if (visible) void applyInvalidation(side, snapshot)
        else pendingInvalidation[side] = snapshot
      }
    }),
    bridge.on("index.progress", (progress) => {
      progressByScan.set(progress.scanId, progress)
      if (progressByScan.size > 32) {
        const oldest = progressByScan.keys().next().value
        if (oldest !== undefined) progressByScan.delete(oldest)
      }
      for (const side of SIDES) {
        if (getPanel(side).scanId === progress.scanId) patch(side, { progress })
      }
    }),
    bridge.on("app.visibility", ({ app, visible: shown }) => {
      if (app !== "commander") return
      visible = shown
      if (!shown) {
        flushPersist()
        return
      }
      for (const side of SIDES) {
        const snapshot = pendingInvalidation[side]
        pendingInvalidation[side] = null
        if (snapshot) void applyInvalidation(side, snapshot)
      }
      onShown()
    }),
  ]
  window.addEventListener("pagehide", flushPersist)
  return () => {
    offs.forEach((off) => off())
    window.removeEventListener("pagehide", flushPersist)
  }
}

// Persistence: session.ts writes commander.panels ---------------------------------------

const PERSIST_DELAY_MS = 400
let persistTimer: ReturnType<typeof setTimeout> | null = null
let persistHandler: (() => void) | null = null

/** session.ts: writes the panels, their tabs and views. */
export function setPersistHandler(handler: (() => void) | null): void {
  persistHandler = handler
}

export function schedulePersist(): void {
  if (!isBridgeAvailable()) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(flushPersist, PERSIST_DELAY_MS)
}

export function flushPersist(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = null
  if (isBridgeAvailable()) persistHandler?.()
}

const SORT_FIELDS_OK: ReadonlySet<unknown> = new Set(Object.values(COLUMN_SORT))

export function readSort(v: unknown): SortKey {
  const s = v as Partial<SortKey> | undefined
  return SORT_FIELDS_OK.has(s?.field) && (s?.direction === "asc" || s?.direction === "desc")
    ? { field: s.field as SortField, direction: s.direction }
    : DEFAULT_SORT
}

export function readColumns(v: unknown): ColumnWidths {
  const out = { ...DEFAULT_COLUMNS }
  const c = (v ?? {}) as Record<string, unknown>
  for (const key of Object.keys(out) as (keyof ColumnWidths)[]) {
    const w = c[key]
    if (typeof w === "number" && w >= COLUMN_LIMITS.min && w <= COLUMN_LIMITS.max) out[key] = w
  }
  const name = c.name
  if (typeof name === "number" && name >= COLUMN_LIMITS.nameMin && name <= COLUMN_LIMITS.nameMax) {
    out.name = name
  }
  return out
}

const COLUMN_IDS: readonly ColumnId[] = ["name", "ext", "size", "date", "attr"]
const isColumnId = (id: unknown): id is ColumnId => COLUMN_IDS.includes(id as ColumnId)

export function readColumnOrder(v: unknown): ColumnOrder {
  const value = Array.isArray(v) ? v.filter(isColumnId) : []
  return [...new Set(value), ...DEFAULT_COLUMN_LAYOUT.order.filter((id) => !value.includes(id))]
}

export function readColumnVisibility(v: unknown): ColumnVisibility {
  const value = (v ?? {}) as Record<string, unknown>
  return {
    name: true,
    ext: typeof value.ext === "boolean" ? value.ext : true,
    size: typeof value.size === "boolean" ? value.size : true,
    date: typeof value.date === "boolean" ? value.date : true,
    attr: typeof value.attr === "boolean" ? value.attr : true,
  }
}

export function readColumnPinning(v: unknown): ColumnPinning {
  const value = (v ?? {}) as Record<string, unknown>
  const start = Array.isArray(value.start) ? value.start.filter(isColumnId) : []
  const used = new Set(start)
  const end = (Array.isArray(value.end) ? value.end.filter(isColumnId) : []).filter(
    (id) => !used.has(id),
  )
  return { start: [...new Set(start)], end: [...new Set(end)] }
}

/** Tests: back to the initial state. */
export function resetListing(): void {
  seqs.left = seqs.right = 0
  failed.left = failed.right = null
  progressByScan.clear()
  pendingInvalidation.left = pendingInvalidation.right = null
  pendingFocus.left = pendingFocus.right = null
  visible = true
  listeners.clear()
  for (const s of parked.values()) clearTimeout(s.timer)
  parked.clear()
  folderChangeHook = null
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = null
  remoteHolders = null
  lastAttempt = 0
  pendingRemote.left = pendingRemote.right = null
  pendingName.left = pendingName.right = null
  for (const side of SIDES) stores[side].reset(null)
  useListingStore.setState({ left: emptyPanel(), right: emptyPanel() })
}
