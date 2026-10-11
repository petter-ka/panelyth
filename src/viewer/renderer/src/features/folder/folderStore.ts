import type {
  Crumb,
  EntryKind,
  IndexProgress,
  QueryFacets,
  QuerySnapshot,
  SortDirection,
  SortField,
  SortKey,
} from "@panelyth/contracts"
import { create } from "zustand"
import { bridge, PanelythError, isBridgeAvailable } from "../../bridge"
import { noteRecent } from "../library/libraryStore"
import { resetThumbs } from "../previews/thumbStore"
import { resetCovers } from "../previews/coverStore"
import { invalidatePages, resetPages, setExpiredHandler } from "../tiles/pageStore"
import {
  applyRebased,
  hasSelection,
  resetSelection,
  toDescriptor,
  useSelectionStore,
} from "../tiles/selectionStore"
import { resetViewerImages } from "../viewer/viewerImages"
import { resetViewer } from "../viewer/viewerStore"
import { readMirror } from "../workspace/mirror"

export interface OpenFolder {
  dirId: number
  path: string
  name: string
  recursive: boolean
  scanId: number
  /** Root first, ending with this folder. */
  crumbs: Crumb[]
}

/**
 * Folder, navigation, scan and query-session state. The items themselves
 * never live here: the tile view reads pages from pageStore (outside React
 * state), and only the session snapshot (id, version, total) is
 * React-visible.
 */
interface FolderState {
  folder: OpenFolder | null
  opening: boolean
  /** What `opening` is for: a path (sidebar, breadcrumb) or a folder tile's entry id; else null. */
  openingTarget: string | number | null
  error: string | null
  progress: IndexProgress | null
  query: QuerySnapshot | null
  /** Primary key first; at most two keys from the UI. Folders always come first. */
  sort: SortKey[]
  recursive: boolean
  /** Committed search (the input debounces before committing). */
  search: string
  /** Kind filter; empty = all. */
  kinds: EntryKind[]
  /** Extension filter; empty = all. */
  exts: string[]
  /** User-metadata filters (ADR-0021): only favorites, at least n stars, all of these tags. */
  favorite: boolean
  minRating: number
  tags: string[]
  facets: QueryFacets | null
  /** Visited folder paths; `historyIndex` is the current one. */
  history: string[]
  historyIndex: number
  /** Increments when the view should return to the top (new folder, sort, search, filter). */
  scrollResetToken: number
}

export const DEFAULT_SORT: SortKey[] = [{ field: "name", direction: "asc" }]

// Not a constant: tests re-read the mirror after changing localStorage.
const initialState = (): FolderState => ({
  folder: null,
  opening: false,
  openingTarget: null,
  error: null,
  progress: null,
  query: null,
  sort: readMirror().sort,
  recursive: false,
  search: "",
  kinds: [],
  exts: [],
  favorite: false,
  minRating: 0,
  tags: [],
  facets: null,
  history: [],
  historyIndex: -1,
  scrollResetToken: 0,
})

export const useFolderStore = create<FolderState>(initialState)

const set = useFolderStore.setState
const get = useFolderStore.getState

/** Resets the store (tests). */
export function resetFolderStore(): void {
  set(initialState(), true)
  openSeq = 0
  querySeq = 0
  recentProgress.clear()
  resetPages(null)
  resetSelection()
}

/** Plain-language messages for errors the user can act on. */
export function describeError(error: unknown): string {
  if (error instanceof PanelythError) {
    switch (error.code) {
      case "NOT_FOUND":
        return "This folder no longer exists."
      case "PERMISSION_DENIED":
        return "Panelyth doesn't have permission to open this folder."
      case "INVALID_PATH":
        return "That location isn't a folder Panelyth can open."
      case "SIDECAR_UNAVAILABLE":
        return "The Panelyth backend isn't running. Restart Panelyth and try again."
    }
    return error.message
  }
  return String(error)
}

// Guard against out-of-order results when folders are opened or queries
// reopened quickly.
let openSeq = 0
let querySeq = 0

// Progress can arrive before dir.open resolves (a tiny folder finishes
// instantly), so the latest snapshot per scan is kept briefly.
const recentProgress = new Map<number, IndexProgress>()
function rememberProgress(p: IndexProgress): void {
  recentProgress.delete(p.scanId)
  recentProgress.set(p.scanId, p)
  if (recentProgress.size > 8) recentProgress.delete(recentProgress.keys().next().value!)
}

export async function openFolderDialog(): Promise<void> {
  try {
    const path = await bridge.openFolderDialog()
    if (path) await openFolder(path)
  } catch (error) {
    set({ error: describeError(error) })
  }
}

/** How an open affects back/forward history. */
type HistoryMode = { kind: "push" } | { kind: "jump"; index: number } | { kind: "replace" }

export function openFolder(path: string, recursive = get().recursive): Promise<void> {
  return open(() => bridge.openDir({ path, recursive }), { kind: "push" }, path)
}

/** Opens a folder tile by its index id. */
export function openFolderEntry(entryId: number, recursive = get().recursive): Promise<void> {
  return open(() => bridge.openDirEntry({ entryId, recursive }), { kind: "push" }, entryId)
}

export function canGoBack(s: FolderState): boolean {
  return s.historyIndex > 0
}

export function canGoForward(s: FolderState): boolean {
  return s.historyIndex >= 0 && s.historyIndex < s.history.length - 1
}

export function canGoUp(s: FolderState): boolean {
  return (s.folder?.crumbs.length ?? 0) > 1
}

function goToHistory(index: number): Promise<void> {
  const { history, recursive } = get()
  const path = history[index]
  if (path === undefined) return Promise.resolve()
  return open(() => bridge.openDir({ path, recursive }), { kind: "jump", index })
}

export const goBack = (): Promise<void> => goToHistory(get().historyIndex - 1)
export const goForward = (): Promise<void> => goToHistory(get().historyIndex + 1)

export function goUp(): Promise<void> {
  const crumbs = get().folder?.crumbs ?? []
  const parent = crumbs.at(-2)
  return parent ? openFolder(parent.path) : Promise.resolve()
}

/**
 * F5: re-lists the folder. The open session stays: the rescan invalidates it
 * like any change, so pages refresh in place and search, filters, sort,
 * selection and scroll position are kept.
 */
export async function refresh(): Promise<void> {
  const { folder, recursive, query } = get()
  if (!folder) return
  if (!query) return openFolder(folder.path, recursive)
  try {
    const dir = await bridge.openDir({ path: folder.path, recursive })
    if (get().folder?.dirId !== dir.dirId) return
    set((s) => ({
      folder: s.folder && { ...s.folder, scanId: dir.scanId, crumbs: dir.crumbs },
      progress: recentProgress.get(dir.scanId) ?? null,
    }))
  } catch (error) {
    set({ error: describeError(error) })
  }
}

function recordHistory(s: FolderState, path: string, mode: HistoryMode) {
  switch (mode.kind) {
    case "jump":
      return { historyIndex: mode.index }
    case "replace":
      return {}
    case "push": {
      if (s.history[s.historyIndex] === path) return {}
      const history = [...s.history.slice(0, s.historyIndex + 1), path].slice(-100)
      return { history, historyIndex: history.length - 1 }
    }
  }
}

async function open(
  request: () => ReturnType<typeof bridge.openDir>,
  mode: HistoryMode,
  target: string | number | null = null,
): Promise<void> {
  const seq = ++openSeq
  set({ opening: true, openingTarget: target, error: null })
  try {
    const dir = await request()
    if (seq !== openSeq) return
    const previous = get().query
    if (previous) void bridge.closeQuery(previous.queryId).catch(() => undefined)
    resetPages(null)
    resetViewer()
    resetThumbs()
    resetCovers()
    resetSelection()
    resetViewerImages()
    set((s) => ({
      folder: {
        dirId: dir.dirId,
        path: dir.path,
        name: dir.name,
        recursive: dir.recursive,
        scanId: dir.scanId,
        crumbs: dir.crumbs,
      },
      recursive: dir.recursive,
      progress: recentProgress.get(dir.scanId) ?? null,
      query: null,
      search: "",
      kinds: [],
      exts: [],
      favorite: false,
      minRating: 0,
      tags: [],
      facets: null,
      scrollResetToken: s.scrollResetToken + 1,
      ...recordHistory(s, dir.path, mode),
    }))
    noteRecent(dir.path)
    await openQuery()
  } catch (error) {
    if (seq === openSeq) set({ error: describeError(error) })
  } finally {
    if (seq === openSeq) set({ opening: false })
  }
}

/**
 * Opens a session for the current folder and view settings, replacing the
 * previous one. The selection is cleared: its indexes belong to the old
 * order.
 */
async function openQuery(): Promise<void> {
  const seq = ++querySeq
  const { folder, sort, search, kinds, exts, favorite, minRating, tags, query: previous } = get()
  if (!folder) return
  const snapshot = await bridge.openQuery({
    dirId: folder.dirId,
    recursive: folder.recursive,
    sort,
    kinds,
    search,
    exts,
    favorite,
    minRating,
    tags,
  })
  if (seq !== querySeq || get().folder?.dirId !== folder.dirId) {
    void bridge.closeQuery(snapshot.queryId).catch(() => undefined)
    return
  }
  if (previous && previous.queryId !== snapshot.queryId) {
    void bridge.closeQuery(previous.queryId).catch(() => undefined)
  }
  resetSelection()
  resetPages(snapshot)
  set({ query: snapshot })
  void loadFacets(snapshot.queryId)
}

function reopenQuery(): void {
  set((s) => ({ scrollResetToken: s.scrollResetToken + 1 }))
  void openQuery().catch((error: unknown) => set({ error: describeError(error) }))
}

// Facets follow the index while a folder is scanned, at most once a second.
let facetsTimer: ReturnType<typeof setTimeout> | null = null
let facetsDirty = false

async function loadFacets(queryId: number): Promise<void> {
  try {
    const facets = await bridge.queryFacets(queryId)
    if (get().query?.queryId === queryId) set({ facets })
  } catch {
    // Facets are advisory: the filters still work without counts.
  }
}

function scheduleFacets(queryId: number): void {
  if (facetsTimer) {
    facetsDirty = true
    return
  }
  void loadFacets(queryId)
  facetsTimer = setTimeout(() => {
    facetsTimer = null
    const current = get().query
    if (facetsDirty && current) {
      facetsDirty = false
      scheduleFacets(current.queryId)
    }
  }, 1000)
}

// The session was evicted or the sidecar restarted: reopen it in place
// (same folder, sort and filters; scroll position kept).
setExpiredHandler(() => {
  void openQuery().catch((error: unknown) => set({ error: describeError(error) }))
})

/** Sets the primary sort key; the secondary key is kept unless it is the same field. */
export function setSort(field: SortField, direction: SortDirection): void {
  const secondary = get().sort[1]
  set({
    sort:
      secondary && secondary.field !== field
        ? [{ field, direction }, secondary]
        : [{ field, direction }],
  })
  reopenQuery()
}

/** Sets (or with null clears) the secondary sort key. */
export function setSecondarySort(field: SortField | null, direction: SortDirection = "asc"): void {
  const primary = get().sort[0] ?? DEFAULT_SORT[0]!
  set({ sort: field && field !== primary.field ? [primary, { field, direction }] : [primary] })
  reopenQuery()
}

/** Applies a persisted sort without reopening (startup, before a folder is open). */
export function restoreSort(sort: SortKey[]): void {
  if (sort.length > 0) set({ sort: sort.slice(0, 2) })
}

export function setSearch(search: string): void {
  if (search === get().search) return
  set({ search })
  if (get().folder) reopenQuery()
}

export function toggleKind(kind: EntryKind): void {
  const kinds = get().kinds
  set({ kinds: kinds.includes(kind) ? kinds.filter((k) => k !== kind) : [...kinds, kind] })
  if (get().folder) reopenQuery()
}

export function setExts(exts: string[]): void {
  set({ exts })
  if (get().folder) reopenQuery()
}

export function setFavoriteFilter(favorite: boolean): void {
  if (favorite === get().favorite) return
  set({ favorite })
  if (get().folder) reopenQuery()
}

export function setMinRating(minRating: number): void {
  if (minRating === get().minRating) return
  set({ minRating })
  if (get().folder) reopenQuery()
}

export function setTagFilter(tags: string[]): void {
  set({ tags })
  if (get().folder) reopenQuery()
}

export function clearFilters(): void {
  if (!hasFilters(get())) return
  set({ search: "", kinds: [], exts: [], favorite: false, minRating: 0, tags: [] })
  if (get().folder) reopenQuery()
}

export function hasFilters(s: FolderState): boolean {
  return (
    s.search !== "" ||
    s.kinds.length > 0 ||
    s.exts.length > 0 ||
    s.favorite ||
    s.minRating > 0 ||
    s.tags.length > 0
  )
}

export function setRecursive(recursive: boolean): void {
  const folder = get().folder
  set({ recursive })
  if (folder) {
    void open(() => bridge.openDir({ path: folder.path, recursive }), { kind: "replace" })
  }
}

export async function cancelScan(): Promise<void> {
  const folder = get().folder
  if (!folder) return
  try {
    await bridge.cancelScan(folder.scanId)
  } catch (error) {
    set({ error: describeError(error) })
  }
}

export function isScanning(progress: IndexProgress | null, folder: OpenFolder | null): boolean {
  if (!folder) return false
  return !progress || (progress.scanId === folder.scanId && progress.state === "running")
}

/**
 * The session moved to a new version: selection indexes refer to the old
 * order, so Go maps them onto the new one (ADR-0017). If that fails (two
 * versions behind), the selection is cleared rather than misapplied.
 */
async function rebaseSelection(previous: QuerySnapshot): Promise<void> {
  const sel = useSelectionStore.getState()
  if (!hasSelection(sel)) return
  try {
    const rebased = await bridge.rebaseSelection(
      toDescriptor(sel, previous.queryId, previous.version),
    )
    if (get().query?.queryId === previous.queryId) applyRebased(rebased)
  } catch {
    if (get().query?.queryId === previous.queryId) resetSelection()
  }
}

/** Subscribes to index events; returns an unsubscribe function. */
export function startFolderMonitoring(): () => void {
  if (!isBridgeAvailable()) return () => {}
  const offProgress = bridge.on("index.progress", (p) => {
    rememberProgress(p)
    if (p.scanId === get().folder?.scanId) set({ progress: p })
  })
  const offInvalidated = bridge.on("query.invalidated", (snapshot) => {
    const query = get().query
    if (!query || snapshot.queryId !== query.queryId || snapshot.version <= query.version) return
    set({ query: snapshot })
    invalidatePages(snapshot)
    void rebaseSelection(query)
    scheduleFacets(snapshot.queryId)
  })
  return () => {
    offProgress()
    offInvalidated()
  }
}
