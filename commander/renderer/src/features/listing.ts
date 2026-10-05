import {
  type Crumb,
  type DirOpenResult,
  type IndexProgress,
  type QueryDescriptor,
  type QuerySnapshot,
  type SortDirection,
  type SortField,
  type SortKey,
  type Volume,
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
  /** Row index in the view; row 0 is ".." when the folder has a parent. */
  cursor: number
  columns: ColumnWidths
  /** Increments when the view should bring the cursor into view. */
  revealToken: number
}

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
  cursor: 0,
  columns: DEFAULT_COLUMNS,
  revealToken: 0,
})

export const useListingStore = create<Record<Side, PanelState>>(() => ({
  left: emptyPanel(),
  right: emptyPanel(),
}))

const getPanel = (side: Side): PanelState => useListingStore.getState()[side]

function patch(side: Side, value: Partial<PanelState>): void {
  useListingStore.setState((s) => ({ [side]: { ...s[side], ...value } }))
}

// Page stores ---------------------------------------------------------------

const isExpired = (error: unknown): boolean =>
  error instanceof FastViewError && error.code === "NOT_FOUND"

const makeStore = (): PageStore =>
  createPageStore({ fetch: (q, offset, limit) => bridge.page(q, offset, limit), isExpired })

const stores: Record<Side, PageStore> = { left: makeStore(), right: makeStore() }

export const pageStoreOf = (side: Side): PageStore => stores[side]

for (const side of SIDES) {
  // The session was evicted or the sidecar restarted: reopen it in place.
  stores[side].setExpiredHandler(() => void reopenQuery(side))
}

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
    const previous = getPanel(side).query
    if (previous && previous.queryId !== snapshot.queryId) {
      void bridge.closeQuery(previous.queryId).catch(() => undefined)
    }
    stores[side].reset(snapshot)
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
    if (previous && previous.queryId !== snapshot.queryId) {
      void bridge.closeQuery(previous.queryId).catch(() => undefined)
    }
    stores[side].reset(snapshot)
    patch(side, {
      query: snapshot,
      cursor: cursor >= 0 ? cursor : 0,
      revealToken: getPanel(side).revealToken + 1,
    })
  } catch (error) {
    if (seq === seqs[side]) patch(side, { error: toPanelError(error) })
  }
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
  stores[side].invalidate(snapshot)
  patch(side, { query: snapshot })
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

// Free space ------------------------------------------------------------------------

const VOLUMES_TTL_MS = 10_000
let volumes: { at: number; list: Promise<Volume[]> } | null = null

/** The volume holding the folder: the deepest crumb that is a volume root. */
export async function volumeOf(crumbs: readonly Crumb[]): Promise<Volume | null> {
  if (!volumes || Date.now() - volumes.at > VOLUMES_TTL_MS) {
    volumes = { at: Date.now(), list: bridge.volumes().catch(() => []) }
  }
  const list = await volumes.list
  const fold = (s: string): string => s.toLowerCase()
  for (let i = crumbs.length - 1; i >= 0; i--) {
    const path = fold(crumbs[i]!.path)
    const hit = list.find((v) => fold(v.path) === path)
    if (hit) return hit
  }
  return null
}

// Persistence: commander.panels -------------------------------------------------------

export const PANELS_KEY = "commander.panels"
const PERSIST_DELAY_MS = 400

interface StoredPanel {
  path: string
  sort: SortKey
  showHidden: boolean
  columns: ColumnWidths
}

export interface StoredPanels {
  v: 1
  active: Side
  left?: StoredPanel
  right?: StoredPanel
}

let persistTimer: ReturnType<typeof setTimeout> | null = null

export function schedulePersist(): void {
  if (!isBridgeAvailable()) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(flushPersist, PERSIST_DELAY_MS)
}

export function flushPersist(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = null
  if (!isBridgeAvailable()) return
  const stored: StoredPanels = { v: 1, active: usePanelsStore.getState().active }
  for (const side of SIDES) {
    const p = getPanel(side)
    if (p.path)
      stored[side] = { path: p.path, sort: p.sort, showHidden: p.showHidden, columns: p.columns }
  }
  void bridge.setSetting(PANELS_KEY, stored).catch(() => undefined)
}

const SORT_FIELDS_OK: ReadonlySet<unknown> = new Set(Object.values(COLUMN_SORT))

function readSort(v: unknown): SortKey {
  const s = v as Partial<SortKey> | undefined
  return SORT_FIELDS_OK.has(s?.field) && (s?.direction === "asc" || s?.direction === "desc")
    ? { field: s.field as SortField, direction: s.direction }
    : DEFAULT_SORT
}

function readColumns(v: unknown): ColumnWidths {
  const out = { ...DEFAULT_COLUMNS }
  const c = (v ?? {}) as Record<string, unknown>
  for (const key of Object.keys(out) as (keyof ColumnWidths)[]) {
    const w = c[key]
    if (typeof w === "number" && w >= COLUMN_LIMITS.min && w <= COLUMN_LIMITS.max) out[key] = w
  }
  return out
}

/** Validated stored panels; unknown shapes fall back to defaults. */
export function readStoredPanels(value: unknown): StoredPanels {
  const v = value as Partial<StoredPanels> | undefined
  const out: StoredPanels = { v: 1, active: v?.active === "right" ? "right" : "left" }
  if (v?.v !== 1) return out
  for (const side of SIDES) {
    const p = v[side] as Partial<StoredPanel> | undefined
    if (typeof p?.path !== "string" || p.path === "") continue
    out[side] = {
      path: p.path,
      sort: readSort(p.sort),
      showHidden: p.showHidden === true,
      columns: readColumns(p.columns),
    }
  }
  return out
}

/**
 * Start: each panel opens its persisted folder (home on first run). A
 * folder carried over from the viewer replaces the active panel's.
 */
export async function restorePanels(carried: { dirId: number; focusId: number | null } | null) {
  const { settings } = await bridge.library()
  const stored = readStoredPanels(settings[PANELS_KEY])
  usePanelsStore.setState({ active: stored.active })
  let home: Promise<string | null> | null = null
  await Promise.all(
    SIDES.map(async (side) => {
      const saved = stored[side]
      if (saved)
        patch(side, { sort: saved.sort, showHidden: saved.showHidden, columns: saved.columns })
      if (carried && side === stored.active) {
        return openFolderEntry(side, carried.dirId, { focusId: carried.focusId })
      }
      if (saved) return openPath(side, saved.path)
      home ??= bridge.homePath().catch(() => null)
      const path = await home
      if (path) return openPath(side, path)
    }),
  )
}

/** Tests: back to the initial state. */
export function resetListing(): void {
  seqs.left = seqs.right = 0
  failed.left = failed.right = null
  progressByScan.clear()
  pendingInvalidation.left = pendingInvalidation.right = null
  visible = true
  volumes = null
  listeners.clear()
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = null
  for (const side of SIDES) stores[side].reset(null)
  useListingStore.setState({ left: emptyPanel(), right: emptyPanel() })
}
