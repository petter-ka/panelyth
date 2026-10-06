import {
  type Crumb,
  type DirOpenResult,
  type IndexProgress,
  type QueryDescriptor,
  type QuerySnapshot,
  type SortDirection,
  type SortField,
  type SortKey,
} from "@fastview/contracts"
import { createPageStore, type PageStore } from "@fastview/renderer-core"
import { create } from "zustand"
import { bridge, FastViewError, isBridgeAvailable } from "../bridge"
import { usePanelsStore, type Side } from "./panels"

// Panel listings (Stage C01, ADR-0028): one query session per panel in the
// all-entries scope (ADR-0026), its pages in a page store outside React
// state (ADR-0011). React sees only the session snapshot and the cursor.

export const SIDES: readonly Side[] = ["left", "right"]

/** The Full view's columns; Name takes the remaining width. */
export type ColumnId = "name" | "ext" | "size" | "date" | "attr"
export type ColumnWidths = Record<Exclude<ColumnId, "name">, number>
export const DEFAULT_COLUMNS: ColumnWidths = { ext: 64, size: 112, date: 136, attr: 56 }
export const COLUMN_LIMITS = { min: 36, max: 480 }

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
export type ViewMode = "full" | "brief"

export type PanelErrorKind = "notFound" | "denied" | "notReady" | "network" | "other"

export interface PanelError {
  kind: PanelErrorKind
  message: string
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
  /** The last navigation failed; the previous listing (if any) is kept behind it. */
  error: PanelError | null
  query: QuerySnapshot | null
  sort: SortKey
  showHidden: boolean
  view: ViewMode
  /** Row index in the view; row 0 is ".." when the folder has a parent. */
  cursor: number
  columns: ColumnWidths
  /** Increments when the view should bring the cursor into view. */
  revealToken: number
  /** Visited folders of this panel (Alt+← / Alt+→); `historyIndex` is the current one. */
  history: string[]
  historyIndex: number
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
  error: null,
  query: null,
  sort: DEFAULT_SORT,
  showHidden: false,
  view: "full",
  cursor: 0,
  columns: DEFAULT_COLUMNS,
  revealToken: 0,
  history: [],
  historyIndex: -1,
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

const isExpired = (error: unknown): boolean =>
  error instanceof FastViewError && error.code === "NOT_FOUND"

const makeStore = (): PageStore =>
  createPageStore({ fetch: (q, offset, limit) => bridge.page(q, offset, limit), isExpired })

const stores: Record<Side, PageStore> = { left: makeStore(), right: makeStore() }

export const pageStoreOf = (side: Side): PageStore => stores[side]

function bindExpired(): void {
  for (const side of SIDES) {
    // The session was evicted or the sidecar restarted: reopen it in place.
    stores[side].setExpiredHandler(() => void reopenQuery(side))
  }
}
bindExpired()

// Rows ------------------------------------------------------------------------

/** 1 when the folder has a parent, so row 0 is the synthetic "..". */
export const parentRows = (p: PanelState): number => (p.crumbs.length > 1 ? 1 : 0)

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

function descriptor(dirId: number, p: Pick<PanelState, "sort" | "showHidden">): QueryDescriptor {
  return {
    dirId,
    recursive: false,
    sort: [p.sort],
    kinds: [],
    search: "",
    exts: [],
    favorite: false,
    minRating: 0,
    tags: [],
    scope: "all",
    showHidden: p.showHidden,
  }
}

export function toPanelError(error: unknown): PanelError {
  if (!(error instanceof FastViewError)) return { kind: "other", message: String(error) }
  const reason = (error.details as { reason?: unknown } | undefined)?.reason
  switch (true) {
    case error.code === "NOT_FOUND":
      return { kind: "notFound", message: "This folder doesn't exist anymore." }
    case error.code === "PERMISSION_DENIED":
      return { kind: "denied", message: "You don't have permission to open this folder." }
    case reason === "notReady":
      return { kind: "notReady", message: "The drive is not ready. Insert a disk or reconnect it." }
    case reason === "network":
      return { kind: "network", message: "The network location can't be reached." }
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
): Promise<void> {
  const seq = ++seqs[side]
  patch(side, { loading: true })
  try {
    const dir = await open()
    if (seq !== seqs[side]) return
    const snapshot = await bridge.openQuery(descriptor(dir.dirId, getPanel(side)))
    if (seq !== seqs[side]) {
      void bridge.closeQuery(snapshot.queryId).catch(() => undefined)
      return
    }
    const parent = dir.crumbs.length > 1 ? 1 : 0
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
      ...recordHistory(p, dir.path, options.historyIndex),
    })
    schedulePersist()
    if (side === usePanelsStore.getState().active) listeners.forEach((l) => l(side))
  } catch (error) {
    if (seq !== seqs[side]) return
    patch(side, { loading: false })
    if (options.inline) throw error
    failed[side] = () => navigate(side, open, options)
    patch(side, { error: toPanelError(error) })
  }
}

/** Retry on the error state: the navigation that failed, again. */
export function retry(side: Side): Promise<void> {
  return failed[side]?.() ?? refresh(side)
}

/** Home on the error state (and the first-run location). */
export async function openHome(side: Side): Promise<void> {
  const home = await bridge.homePath().catch(() => null)
  if (home) await openPath(side, home)
}

export const openPath = (side: Side, path: string, options?: NavigateOptions): Promise<void> =>
  navigate(side, () => bridge.openDir(path), options)

export const openFolderEntry = (
  side: Side,
  entryId: number,
  options?: NavigateOptions,
): Promise<void> => navigate(side, () => bridge.openDirEntry(entryId), options)

/** Backspace, Ctrl+PgUp, Enter on "..": the cursor lands on the folder just left. */
export function goUp(side: Side): Promise<void> {
  const p = getPanel(side)
  const parent = p.crumbs.at(-2)
  if (!parent || p.dirId === null) return Promise.resolve()
  return openPath(side, parent.path, { focusId: p.dirId })
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
export function goRoot(side: Side): Promise<void> {
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

/** Enter: folders open; files wait for Stage C05 (open, lister). */
export function enter(side: Side): Promise<void> {
  const p = getPanel(side)
  const index = p.cursor - parentRows(p)
  if (index < 0) return goUp(side)
  const item = stores[side].getItem(index)
  if (item?.kind === "dir") return openFolderEntry(side, item.id)
  return Promise.resolve()
}

/** Ctrl+R: re-list the folder; the session stays, so the cursor and scroll stay too. */
export async function refresh(side: Side): Promise<void> {
  const p = getPanel(side)
  if (!p.path) return
  if (p.error || !p.query) return openPath(side, p.path)
  try {
    const dir = await bridge.openDir(p.path)
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
    if (seq === seqs[side]) patch(side, { error: toPanelError(error) })
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
    timer: setTimeout(() => dropParked(tabId), TAB_GRACE_MS),
  })
}

/** Drops in-flight navigations of a panel (a tab switch supersedes them). */
export function cancelNavigation(side: Side): void {
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
    if (seq === seqs[side]) await refresh(side)
  })()
  return true
}

let folderChangeHook: ((side: Side) => void) | null = null

/** tabs.ts: called before a panel shows another folder (a locked tab branches off). */
export function setFolderChangeHook(hook: ((side: Side) => void) | null): void {
  folderChangeHook = hook
}

/** Ctrl+F1 / Ctrl+F2: the Brief or the Full view. */
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
  patch(side, { showHidden: !getPanel(side).showHidden })
  schedulePersist()
  void reopenQuery(side)
}

export function setColumns(side: Side, columns: ColumnWidths): void {
  patch(side, { columns })
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

async function applyInvalidation(side: Side, snapshot: QuerySnapshot): Promise<void> {
  const p = getPanel(side)
  if (p.query?.queryId !== snapshot.queryId || snapshot.version <= p.query.version) return
  // The cursor follows its entry when rows move (inserted or removed above it).
  const focusId = cursorEntryId(side)
  const from = p.query.version
  stores[side].invalidate(snapshot)
  patch(side, { query: snapshot })
  sessionChanged(side, {
    kind: "invalidated",
    queryId: snapshot.queryId,
    from,
    to: snapshot.version,
  })
  if (focusId === null) {
    moveCursor(side, getPanel(side).cursor)
    return
  }
  const at = await bridge.indexOf(snapshot.queryId, focusId).catch(() => null)
  const now = getPanel(side)
  if (!at || now.query?.queryId !== snapshot.queryId) return
  if (at.index >= 0) moveCursor(side, at.index + parentRows(now))
  else moveCursor(side, now.cursor)
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
  return out
}

/** Tests: back to the initial state. */
export function resetListing(): void {
  seqs.left = seqs.right = 0
  failed.left = failed.right = null
  progressByScan.clear()
  pendingInvalidation.left = pendingInvalidation.right = null
  visible = true
  listeners.clear()
  for (const s of parked.values()) clearTimeout(s.timer)
  parked.clear()
  folderChangeHook = null
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = null
  for (const side of SIDES) stores[side].reset(null)
  useListingStore.setState({ left: emptyPanel(), right: emptyPanel() })
}
