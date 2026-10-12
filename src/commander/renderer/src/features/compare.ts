import type {
  CompareOptions,
  ComparePlan,
  CompareProgress,
  CompareShow,
  ContentItem,
  DiffAction,
  HashAlgorithm,
  JobItemError,
  JobSnapshot,
  QuerySnapshot,
  SelectionDescriptor,
  TextDiffOpenResult,
  TextDiffRow,
} from "@panelyth/contracts"
import { COMPARE_SHOW } from "@panelyth/contracts"
import {
  addRanges,
  createPageStore,
  fromRanges,
  hasMarks,
  NO_MARKS,
  toDescriptor,
  toggle,
  type Marks,
  type PageStore,
} from "@panelyth/renderer-core"
import { create } from "zustand"
import { bridge, isBridgeAvailable, PanelythError } from "../bridge"
import { inArchive, notice, operand, refusedOnConnection } from "./files"
import { isExpired, pageStoreOf, parentRows, useListingStore } from "./listing"
import { applyMarks, countOf as countMarks, marksDescriptor, marksOf, markNone } from "./marks"
import { otherSide, type Side } from "./panels"
import { showDetails, useQueueStore } from "./queue"
import { updateSettings, useSettingsStore } from "./settings"
import { msg, t } from "@panelyth/i18n"

// Compare, synchronize and checksums (Stage C08, CFR-20, CFR-21): Shift+F2
// marks what is unique or newer in each panel; Synchronize directories
// compares two trees in Go and shows the result as a query session
// (ADR-0017) whose shown rows a sync job applies; Compare by content is a
// text diff paged from Go, or a streamed compare job for other files;
// checksum files are created and verified by jobs (ADR-0029).

const panel = (side: Side) => useListingStore.getState()[side]

const errorText = (error: unknown): string =>
  error instanceof PanelythError ? error.message : String(error)

/** The date rules from Settings: Shift+F2 uses them, the synchronize dialog shows them. */
export function compareOptions(): CompareOptions {
  const s = useSettingsStore.getState().settings
  return { toleranceMs: s.compareToleranceMs, dst: s.compareDst, ignoreDates: s.compareIgnoreDates }
}

// Shift+F2 ----------------------------------------------------------------------

/** Tries while a panel refreshes underneath (each refresh is a new version). */
const MARK_ATTEMPTS = 4

/**
 * Compare directories: marks, in each panel, the files that are not in the
 * other one or are newer there, by name, size and date. Folders are not
 * compared.
 */
export async function comparePanels(): Promise<void> {
  const left = panel("left").query
  const right = panel("right").query
  if (!left || !right) return
  try {
    for (let attempt = 0; attempt < MARK_ATTEMPTS; attempt++) {
      const res = await bridge.compareMarks({
        leftQueryId: left.queryId,
        rightQueryId: right.queryId,
        ...compareOptions(),
      })
      const l = panel("left").query
      const r = panel("right").query
      // A panel went elsewhere meanwhile: the marks were for the folders compared.
      if (l?.queryId !== left.queryId || r?.queryId !== right.queryId) return
      // A refresh made a new version while Go compared: the ranges index the old rows.
      if (res.left.version !== l.version || res.right.version !== r.version) continue
      applyMarks("left", res.left)
      applyMarks("right", res.right)
      notice(
        res.leftCount + res.rightCount === 0
          ? t("The two panels have the same files.")
          : t("Compared: {left} marked on the left, {right} on the right.", {
              left: res.leftCount,
              right: res.rightCount,
            }),
      )
      return
    }
  } catch (error) {
    notice(errorText(error))
  }
}

// Synchronize directories --------------------------------------------------------

/** The default filter: everything but the equal rows. */
export const DEFAULT_SHOW: readonly CompareShow[] = ["copyRight", "copyLeft", "different", "delete"]

export interface SyncRoot {
  /** The folder as shown (editable); dirId is its id while unedited. */
  path: string
  dirId: number | null
}

export interface SyncRun {
  compareId: number
  queryId: number
  version: number
  total: number
  /** The roots that were compared. */
  left: string
  right: string
}

export interface SyncDialogState {
  left: SyncRoot
  right: SyncRoot
  content: boolean
  asymmetric: boolean
  run: SyncRun | null
  progress: CompareProgress | null
  plan: ComparePlan | null
  show: readonly CompareShow[]
  /** The table's cursor row and the rows selected for a direction change. */
  cursor: number
  marks: Marks
  /** Where Shift+arrows and Shift+click extend from. */
  anchor: number | null
  /** The confirmation step before a sync starts. */
  confirming: boolean
  deletePermanently: boolean
  starting: boolean
  error: string | null
}

export interface DiffSide {
  id: number
  name: string
}

export interface DiffDialogState {
  left: DiffSide
  right: DiffSide
  /** null while the files are being compared. */
  info: TextDiffOpenResult | null
  /** Not text, or too large: a compareFiles job answers "identical or not". */
  job: JobSnapshot | null
  /** Why a finished job says the files differ, from Go. */
  detail: string
  /** The longest line seen so far, for the width of the view. */
  maxChars: number
  error: string | null
}

/** What a file compared with the other panel's turned out to be, when not identical. */
export type ManyResult = "different" | "missing" | "unreadable"
export const MANY_RESULTS: readonly ManyResult[] = ["different", "missing", "unreadable"]

export interface ManyRow {
  name: string
  result: ManyResult
  /** Go's explanation: the sizes, or where the first difference is. */
  message: string
}

/**
 * Compare by content for several marked files (Stage C10.5): each against
 * the file of its name in the other panel's folder, as one compareFiles
 * job. The rows are the files that are not identical (manyRows).
 */
export interface CompareManyState {
  /** The panel whose marked files are compared. */
  side: Side
  /** How many entries were marked. */
  count: number
  /** The other panel's folder. */
  folder: string
  job: JobSnapshot | null
  /** The job ended and its rows are being read, or are read. */
  loading: boolean
  /** Files per result, once the rows are read. */
  counts: Record<ManyResult, number>
  /** The results the list shows. */
  show: readonly ManyResult[]
  /** The list's cursor (an index among the shown rows). */
  cursor: number
  error: string | null
}

export interface HashDialogState {
  side: Side
  source: SelectionDescriptor
  what: string
  algorithm: HashAlgorithm
  perFile: boolean
  /** One list is not possible where the panel has no folder of its own (search results). */
  listAllowed: boolean
  /** The list's name without its extension. */
  name: string
  folder: string
  folderDirId: number | null
  error: string | null
}

interface CompareState {
  sync: SyncDialogState | null
  diff: DiffDialogState | null
  hash: HashDialogState | null
  many: CompareManyState | null
}

export const useCompareStore = create<CompareState>(() => ({
  sync: null,
  diff: null,
  hash: null,
  many: null,
}))

const set = useCompareStore.setState
const get = useCompareStore.getState

const patchSync = (change: Partial<SyncDialogState>): void => {
  const s = get().sync
  if (s) set({ sync: { ...s, ...change } })
}

/** The rows of the synchronize dialog's table. */
export const syncRows: PageStore = createPageStore({
  fetch: (q, offset, limit) => bridge.page(q, offset, limit),
  isExpired,
})
syncRows.setExpiredHandler(() => {
  syncRows.reset(null)
  patchSync({
    run: null,
    plan: null,
    progress: null,
    error: t("The comparison is no longer available. Compare again."),
  })
})

export const isComparing = (s: Pick<SyncDialogState, "run" | "progress">): boolean =>
  s.run !== null && (s.progress === null || s.progress.state === "running")

/** A finished compare whose rows can get directions and be synchronized. */
export const isCompared = (s: Pick<SyncDialogState, "run" | "progress">): boolean =>
  s.run !== null && s.progress?.state === "completed"

/** Synchronize directories: the dialog for the two panels' folders. */
export function openSync(): void {
  if (get().sync) return
  for (const side of ["left", "right"] as const) {
    if (refusedOnConnection(side)) return
    if (inArchive(side)) {
      notice(t("Archives can't be synchronized. Leave the archive first."))
      return
    }
  }
  const l = panel("left")
  const r = panel("right")
  set({
    sync: {
      left: { path: l.path, dirId: l.dirId },
      right: { path: r.path, dirId: r.dirId },
      content: false,
      asymmetric: false,
      run: null,
      progress: null,
      plan: null,
      show: DEFAULT_SHOW,
      cursor: 0,
      marks: NO_MARKS,
      anchor: null,
      confirming: false,
      deletePermanently: false,
      starting: false,
      error: null,
    },
  })
}

/** An edited root is resolved again when the compare starts. */
export function updateSyncRoot(side: Side, path: string): void {
  const s = get().sync
  if (s && s[side].path !== path) patchSync({ [side]: { path, dirId: null }, error: null })
}

export function updateSyncOptions(
  change: Partial<Pick<SyncDialogState, "content" | "asymmetric" | "deletePermanently">>,
): void {
  patchSync({ ...change, error: null })
}

/** The date rules are the ones in Settings (Shift+F2 uses them too). */
export const updateCompareDates = (change: {
  toleranceMs?: 0 | 2000
  dst?: boolean
  ignoreDates?: boolean
}): void =>
  updateSettings({
    ...(change.toleranceMs !== undefined && { compareToleranceMs: change.toleranceMs }),
    ...(change.dst !== undefined && { compareDst: change.dst }),
    ...(change.ignoreDates !== undefined && { compareIgnoreDates: change.ignoreDates }),
  })

/** Events that arrived before compare.dirs answered (small folders). */
const early = {
  progress: new Map<number, CompareProgress>(),
  snapshots: new Map<number, QuerySnapshot>(),
}
let starting = false
let compareSeq = 0

async function resolveRoot(root: SyncRoot): Promise<number> {
  if (root.dirId !== null) return root.dirId
  const typed = root.path.trim()
  if (typed === "") throw new Error(t("Enter the two folders to compare."))
  try {
    return (await bridge.openDir(typed)).dirId
  } catch (error) {
    if (
      error instanceof PanelythError &&
      (error.code === "NOT_FOUND" || error.code === "INVALID_PATH")
    )
      throw new Error(t("“{path}” doesn't exist. Check the folder.", { path: typed }), {
        cause: error,
      })
    throw error
  }
}

/** Forgets the dialog's compare (its rows and its session) in Go. */
async function discardRun(): Promise<void> {
  const run = get().sync?.run
  syncRows.reset(null)
  patchSync({ run: null, progress: null, plan: null, cursor: 0, marks: NO_MARKS, anchor: null })
  if (run) await bridge.compareClose(run.compareId).catch(() => undefined)
}

const latest = (a: QuerySnapshot, b: QuerySnapshot | undefined): QuerySnapshot =>
  b && b.version > a.version ? b : a

/** Compare: walks both trees in Go; the table fills when the walk has finished. */
export async function startCompare(): Promise<void> {
  const s = get().sync
  if (!s) return
  const seq = ++compareSeq
  await discardRun()
  patchSync({ error: null, confirming: false, show: DEFAULT_SHOW })
  starting = true
  try {
    const leftDirId = await resolveRoot(s.left)
    const rightDirId = await resolveRoot(s.right)
    const started = await bridge.compareDirs({
      leftDirId,
      rightDirId,
      ...compareOptions(),
      content: s.content,
      asymmetric: s.asymmetric,
    })
    if (seq !== compareSeq || !get().sync) {
      void bridge.compareClose(started.compareId).catch(() => undefined)
      return
    }
    const snapshot = latest(started, early.snapshots.get(started.queryId))
    syncRows.reset(snapshot)
    const progress = early.progress.get(started.compareId) ?? null
    patchSync({
      run: {
        compareId: started.compareId,
        queryId: snapshot.queryId,
        version: snapshot.version,
        total: snapshot.total,
        left: s.left.path.trim(),
        right: s.right.path.trim(),
      },
      progress,
    })
    if (progress?.state === "completed") void loadPlan()
  } catch (error) {
    if (seq !== compareSeq) return
    const nested =
      error instanceof PanelythError &&
      (error.details as { reason?: string } | undefined)?.reason === "nested"
    patchSync({
      error: nested
        ? t("Choose two separate folders: one can't be inside the other.")
        : error instanceof Error
          ? error.message
          : String(error),
    })
  } finally {
    starting = false
    early.progress.clear()
    early.snapshots.clear()
  }
}

/** Stop: a compare that did not finish has no rows. */
export function stopCompare(): void {
  const run = get().sync?.run
  if (run) void bridge.compareCancel(run.compareId).catch(() => false)
}

/** Esc / Close: the dialog's compare ends with it. */
export function closeSync(): void {
  compareSeq++
  const run = get().sync?.run
  syncRows.reset(null)
  set({ sync: null })
  if (run) void bridge.compareClose(run.compareId).catch(() => undefined)
}

/** The table after a change in Go: its session's new version and the plan. */
function applyView(view: QuerySnapshot & { plan: ComparePlan }): void {
  const s = get().sync
  if (!s?.run || view.queryId !== s.run.queryId) return
  syncRows.invalidate(view)
  const total = view.total
  patchSync({
    run: { ...s.run, version: Math.max(s.run.version, view.version), total },
    plan: view.plan,
    cursor: Math.max(0, Math.min(s.cursor, total - 1)),
    // Rows may have left or joined the table: positions no longer hold.
    ...(total !== s.run.total && { marks: NO_MARKS, anchor: null }),
  })
}

async function loadPlan(): Promise<void> {
  const run = get().sync?.run
  if (!run) return
  const plan = await bridge.comparePlan(run.compareId).catch(() => null)
  if (plan && get().sync?.run?.compareId === run.compareId) patchSync({ plan })
}

/** Shows or hides the rows of one symbol (→ ← = ≠ ×). Hidden rows are not synchronized. */
export async function toggleShow(kind: CompareShow): Promise<void> {
  const s = get().sync
  if (!s?.run || !isCompared(s)) return
  const next = s.show.includes(kind) ? s.show.filter((k) => k !== kind) : [...s.show, kind]
  // Kept in the order of the buttons.
  const show = COMPARE_SHOW.filter((k) => next.includes(k))
  patchSync({ show, marks: NO_MARKS, anchor: null, error: null })
  try {
    applyView(await bridge.compareShow(s.run.compareId, show))
  } catch (error) {
    patchSync({ error: errorText(error) })
  }
}

/** The rows a direction change applies to: the selected ones, or the cursor row. */
function syncOperand(s: SyncDialogState): SelectionDescriptor | null {
  if (!s.run || s.run.total === 0) return null
  if (hasMarks(s.marks)) return toDescriptor(s.marks, s.run.queryId, s.run.version)
  return {
    queryId: s.run.queryId,
    version: s.run.version,
    ranges: [[s.cursor, s.cursor + 1]],
    include: [],
    exclude: [],
  }
}

/**
 * Gives the selected rows (or the cursor row) a direction. "delete" deletes
 * a one-sided entry where it is; rows a direction does not apply to keep
 * theirs (Go decides).
 */
export async function setDirection(action: DiffAction | "default" | "delete"): Promise<void> {
  const s = get().sync
  const selection = s && isCompared(s) ? syncOperand(s) : null
  if (!s?.run || !selection) return
  try {
    if (action === "delete") {
      // Each row takes the delete of the side it is on.
      await bridge.compareSetAction(s.run.compareId, selection, "deleteLeft")
      applyView(await bridge.compareSetAction(s.run.compareId, selection, "deleteRight"))
    } else {
      applyView(await bridge.compareSetAction(s.run.compareId, selection, action))
    }
    patchSync({ error: null })
  } catch (error) {
    patchSync({ error: errorText(error) })
  }
}

export function moveSyncCursor(index: number, extend = false): void {
  const s = get().sync
  if (!s?.run) return
  const cursor = Math.max(0, Math.min(index, s.run.total - 1))
  if (!extend) {
    patchSync({ cursor, marks: NO_MARKS, anchor: null })
    return
  }
  const anchor = s.anchor ?? s.cursor
  patchSync({
    cursor,
    anchor,
    marks: fromRanges([[Math.min(anchor, cursor), Math.max(anchor, cursor) + 1]]),
  })
}

/** Ctrl+click: adds a row to the selection, or takes it out. */
export function toggleSyncRow(index: number): void {
  const s = get().sync
  const item = syncRows.getItem(index)
  if (!s?.run || !item) return
  // The cursor row joins a selection that starts with a Ctrl+click elsewhere.
  const base =
    hasMarks(s.marks) || index === s.cursor
      ? s.marks
      : addRanges(NO_MARKS, [[s.cursor, s.cursor + 1]])
  patchSync({ cursor: index, anchor: null, marks: toggle(base, index, item.id) })
}

export function selectAllSyncRows(): void {
  const s = get().sync
  if (s?.run && s.run.total > 0) patchSync({ marks: fromRanges([[0, s.run.total]]), anchor: null })
}

/** What a sync of the shown rows does; null when there is nothing to do. */
export function hasWork(plan: ComparePlan | null): boolean {
  return (
    plan !== null &&
    plan.copyRight.files + plan.copyLeft.files + plan.deleteRight + plan.deleteLeft + plan.folders >
      0
  )
}

/** Synchronize: the confirmation with what will be copied and deleted. */
export function confirmSync(confirming: boolean): void {
  const s = get().sync
  if (s && isCompared(s) && (!confirming || hasWork(s.plan))) patchSync({ confirming, error: null })
}

/** Starts the sync job with the plan the confirmation showed. */
export async function startSync(): Promise<boolean> {
  const s = get().sync
  if (!s?.run || !s.plan || s.starting) return false
  patchSync({ starting: true, error: null })
  try {
    await bridge.startJob({
      kind: "sync",
      compareId: s.run.compareId,
      planVersion: s.plan.version,
      ...(s.deletePermanently && { deletePermanently: true }),
    })
  } catch (error) {
    const stale =
      error instanceof PanelythError &&
      (error.details as { reason?: string } | undefined)?.reason === "stalePlan"
    patchSync({
      starting: false,
      error: stale
        ? t("The table changed since you confirmed. Check it and confirm again.")
        : errorText(error),
    })
    if (stale) void loadPlan()
    return false
  }
  // The job has its copy of the plan; the compare is no longer needed.
  closeSync()
  notice(t("Synchronizing; progress is in the queue (Ctrl+J)."))
  return true
}

// Compare by content ---------------------------------------------------------------

const DIFF_PAGE = 200
const DIFF_MAX_PAGES = 24

/** The rows of the text diff: pages of text from Go, a bounded cache outside React state. */
function createDiffRows() {
  let diffId = 0
  const pages = new Map<number, TextDiffRow[]>() // insertion order = LRU order
  const inFlight = new Set<number>()
  const listeners = new Set<() => void>()
  let wanted: number[] = []
  let version = 0
  const changed = (): void => {
    version++
    listeners.forEach((l) => l())
  }

  async function fetchPage(p: number): Promise<void> {
    const forDiff = diffId
    inFlight.add(p)
    try {
      const res = await bridge.diffPage(forDiff, p * DIFF_PAGE, DIFF_PAGE)
      if (forDiff !== diffId) return
      pages.delete(p)
      pages.set(p, res.rows)
      for (const key of pages.keys()) {
        if (pages.size <= DIFF_MAX_PAGES) break
        if (!wanted.includes(key)) pages.delete(key)
      }
      const longest = res.rows.reduce((n, r) => Math.max(n, r.left.length, r.right?.length ?? 0), 0)
      const d = get().diff
      if (d && longest > d.maxChars) set({ diff: { ...d, maxChars: Math.min(longest, 4096) } })
      changed()
    } catch (error) {
      if (forDiff !== diffId) return
      const d = get().diff
      if (d) {
        const edited =
          error instanceof PanelythError &&
          (error.details as { reason?: string } | undefined)?.reason === "changed"
        set({
          diff: {
            ...d,
            error: edited
              ? t("A file changed since it was compared. Compare again.")
              : errorText(error),
          },
        })
      }
    } finally {
      if (forDiff === diffId) inFlight.delete(p)
    }
  }

  return {
    pageSize: DIFF_PAGE,
    reset(id: number): void {
      diffId = id
      pages.clear()
      inFlight.clear()
      wanted = []
      changed()
    },
    /** Changes whenever rows arrive or the diff is replaced. */
    getVersion: (): number => version,
    setRange(first: number, last: number, total: number): void {
      if (diffId === 0 || total === 0 || last < first) return
      const a = Math.floor(Math.max(0, first) / DIFF_PAGE)
      const b = Math.floor(Math.min(total - 1, last) / DIFF_PAGE)
      wanted = []
      for (let p = a; p <= b; p++) wanted.push(p)
      for (const p of wanted) if (!pages.has(p) && !inFlight.has(p)) void fetchPage(p)
    },
    getRow: (index: number): TextDiffRow | undefined =>
      pages.get(Math.floor(index / DIFF_PAGE))?.[index % DIFF_PAGE],
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const diffRows = createDiffRows()

/** The entries of a panel's marks, in order; undefined beyond `limit` of them. */
async function markedItems(side: Side, limit: number): Promise<ContentItem[] | undefined> {
  const m = marksOf(side)
  const skip = new Set(m.exclude.values())
  const indexes: number[] = [...m.include.values()]
  for (const [a, b] of m.ranges) {
    for (let i = a; i < b; i++) {
      if (!skip.has(i)) indexes.push(i)
      if (indexes.length > limit) return undefined
    }
  }
  if (indexes.length > limit) return undefined
  indexes.sort((a, b) => a - b)
  const items = await Promise.all(indexes.map((i) => pageStoreOf(side).ensureIndex(i)))
  return items.filter((it): it is ContentItem => it !== undefined)
}

function cursorItem(side: Side): ContentItem | null {
  const p = panel(side)
  const index = p.cursor - parentRows(p)
  return index >= 0 ? (pageStoreOf(side).getItem(index) ?? null) : null
}

/** The file of that name in a panel, if it lists one. */
async function sameNamed(side: Side, name: string): Promise<ContentItem | null> {
  const q = panel(side).query
  if (!q || /[*?]/.test(name)) return null
  const want = name.toLowerCase()
  let from = 0
  // Quick search finds names that start with the text: a few may come first.
  for (let attempt = 0; attempt < 8; attempt++) {
    const { index } = await bridge.locate(q.queryId, name, from, "forward")
    if (index < 0 || (attempt > 0 && index < from)) return null
    const item = await pageStoreOf(side).ensureIndex(index)
    if (item && item.kind !== "dir" && item.name.toLowerCase() === want) return item
    from = index + 1
  }
  return null
}

/**
 * What Compare by content will do for a panel, in words for its menu entry
 * (Stage C10.5): "Compare 2 files", "Compare 14 files with the other panel",
 * or the plain name when it depends on the cursor.
 */
export function compareLabel(side: Side): string {
  const mine = countMarks(marksOf(side))
  const theirs = countMarks(marksOf(otherSide(side)))
  if (mine > 2)
    return t("Compare {count} files with the other panel", { count: mine.toLocaleString() })
  if (mine === 2 || (mine === 1 && theirs === 1)) return t("Compare 2 files")
  return t("Compare by content")
}

/**
 * Compare by content. Two marked files of the active panel are compared
 * with each other, and so are one marked file of each panel (Total
 * Commander's rule). More than two marked files are each compared with the
 * file of that name in the other panel (compareMany). Otherwise the cursor
 * file (or the one marked file) is compared with the file of the same name
 * in the other panel, or with the other panel's cursor file.
 */
export async function openCompareFiles(side: Side): Promise<void> {
  if (get().diff || get().many) return
  if (refusedOnConnection(side) || refusedOnConnection(otherSide(side))) return
  if (inArchive(side) || inArchive(otherSide(side))) {
    notice(t("Copy the files out of the archive to compare them."))
    return
  }
  try {
    let pair: [ContentItem, ContentItem] | null = null
    if (marksDescriptor(side)) {
      const marked = await markedItems(side, 2)
      if (!marked) return await compareMany(side)
      if (marked.length === 2) pair = [marked[0]!, marked[1]!]
      else if (marked.length === 1 && marksDescriptor(otherSide(side))) {
        // One marked file in each panel: those two, the left panel's on the left.
        const theirs = await markedItems(otherSide(side), 1)
        if (theirs?.length === 1) {
          pair = side === "left" ? [marked[0]!, theirs[0]!] : [theirs[0]!, marked[0]!]
        }
      }
    }
    if (!pair) {
      const mine =
        (marksDescriptor(side) ? (await markedItems(side, 1))?.[0] : cursorItem(side)) ?? null
      if (!mine || mine.kind === "dir") {
        notice(t("Put the cursor on a file to compare it."))
        return
      }
      const theirs =
        (await sameNamed(otherSide(side), mine.name).catch(() => null)) ??
        cursorItem(otherSide(side))
      if (!theirs || theirs.kind === "dir" || theirs.id === mine.id) {
        notice(t("There is no file to compare with in the other panel."))
        return
      }
      // Left is always the left panel's file.
      pair = side === "left" ? [mine, theirs] : [theirs, mine]
    }
    if (pair[0].kind === "dir" || pair[1].kind === "dir") {
      notice(t("Only files can be compared by content."))
      return
    }
    await openDiff({ id: pair[0].id, name: pair[0].name }, { id: pair[1].id, name: pair[1].name })
  } catch (error) {
    notice(errorText(error))
  }
}

// Several files against the other panel (Stage C10.5) -------------------------------

const NO_COUNTS: Record<ManyResult, number> = { different: 0, missing: 0, unreadable: 0 }
const MANY_PAGE = 500

/**
 * The files that are not identical, as the job lists them. Kept outside
 * React state (at most the 10,000 items a job keeps); the dialog shows a
 * virtualized window of the rows its filter lets through.
 */
let manyAll: ManyRow[] = []
let manyShown: ManyRow[] = []

export const manyRows = {
  count: (): number => manyShown.length,
  get: (index: number): ManyRow | undefined => manyShown[index],
}

const resultOf = (code: JobItemError["code"]): ManyResult =>
  code === "DIFFERENT" ? "different" : code === "NOT_FOUND" ? "missing" : "unreadable"

const patchMany = (change: Partial<CompareManyState>): void => {
  const m = get().many
  if (m) set({ many: { ...m, ...change } })
}

function filterMany(show: readonly ManyResult[]): void {
  manyShown =
    show.length === MANY_RESULTS.length ? manyAll : manyAll.filter((r) => show.includes(r.result))
}

/** More than two marked files: each against the file of its name in the other panel's folder. */
async function compareMany(side: Side): Promise<void> {
  const source = marksDescriptor(side)
  const other = panel(otherSide(side))
  if (!source) return
  if (other.dirId === null || other.find !== null) {
    notice(t("Open a folder in the other panel to compare the marked files with it."))
    return
  }
  manyAll = []
  manyShown = []
  set({
    many: {
      side,
      count: countMarks(marksOf(side)),
      folder: other.path,
      job: null,
      loading: false,
      counts: NO_COUNTS,
      show: MANY_RESULTS,
      cursor: 0,
      error: null,
    },
  })
  try {
    const job = await bridge.startJob({
      kind: "compareFiles",
      source: { selection: source },
      destinationDirId: other.dirId,
    })
    if (get().many?.job === null && get().many?.side === side) {
      patchMany({ job })
      watch(job.jobId, "many")
    } else void bridge.cancelJob(job.jobId).catch(() => undefined)
  } catch (error) {
    patchMany({ error: errorText(error) })
  }
}

/** The job ended: its items are read, a page at a time, one request in flight. */
async function loadManyRows(jobId: number): Promise<void> {
  const rows: ManyRow[] = []
  try {
    for (let offset = 0; ; offset += MANY_PAGE) {
      const page = await bridge.jobErrors(jobId, offset, MANY_PAGE)
      if (get().many?.job?.jobId !== jobId) return
      for (const e of page.errors)
        rows.push({ name: e.name, result: resultOf(e.code), message: e.message })
      if (page.errors.length < MANY_PAGE || rows.length >= page.total) break
    }
  } catch (error) {
    if (get().many?.job?.jobId === jobId) patchMany({ loading: false, error: errorText(error) })
    return
  }
  const counts = { ...NO_COUNTS }
  for (const r of rows) counts[r.result]++
  manyAll = rows
  filterMany(get().many!.show)
  patchMany({ loading: false, counts, cursor: 0 })
}

async function manyJobProgress(job: JobSnapshot): Promise<void> {
  const m = get().many
  if (!m || m.job?.jobId !== job.jobId) return
  patchMany({ job })
  if (ACTIVE.has(job.state)) return
  watched.delete(job.jobId)
  if (job.failed === 0) return
  patchMany({ loading: true })
  await loadManyRows(job.jobId)
}

/** A filter button: that result's rows show or hide. */
export function toggleManyShow(result: ManyResult): void {
  const m = get().many
  if (!m) return
  const show = m.show.includes(result)
    ? m.show.filter((r) => r !== result)
    : MANY_RESULTS.filter((r) => r === result || m.show.includes(r))
  filterMany(show)
  patchMany({ show, cursor: 0 })
}

export function moveManyCursor(index: number): void {
  const last = manyShown.length - 1
  if (last >= 0) patchMany({ cursor: Math.max(0, Math.min(last, index)) })
}

export function closeCompareMany(): void {
  const m = get().many
  if (!m) return
  set({ many: null })
  manyAll = []
  manyShown = []
  if (m.job && ACTIVE.has(m.job.state)) void bridge.cancelJob(m.job.jobId).catch(() => undefined)
}

/**
 * Enter on a row of the list: that pair side by side. The two files are
 * found by name in the panels, so the panels must still show the folders
 * that were compared. `step` opens the next (or previous) file that differs
 * from the list's cursor instead.
 */
export async function openManyDiff(step: -1 | 0 | 1 = 0): Promise<void> {
  const m = get().many
  if (!m) return
  let at = m.cursor
  if (step !== 0) {
    do at += step
    while (manyShown[at] !== undefined && manyShown[at]!.result !== "different")
  }
  const row = manyShown[at]
  if (!row || row.result !== "different") return
  if (at !== m.cursor) patchMany({ cursor: at })
  try {
    const mine = await sameNamed(m.side, row.name)
    const theirs = await sameNamed(otherSide(m.side), row.name)
    if (!mine || !theirs) {
      notice(t("The panels no longer show both files. Compare again."))
      return
    }
    const [l, r] = m.side === "left" ? [mine, theirs] : [theirs, mine]
    // Stepping from an open pair: that one is let go first.
    const open = get().diff
    if (open) releaseDiff(open)
    await openDiff({ id: l.id, name: l.name }, { id: r.id, name: r.name })
  } catch (error) {
    notice(errorText(error))
  }
}

/** Whether the list has a differing file after (or before) its cursor. */
export function hasManyDiff(step: -1 | 1): boolean {
  const m = get().many
  if (!m) return false
  for (let at = m.cursor + step; manyShown[at] !== undefined; at += step) {
    if (manyShown[at]!.result === "different") return true
  }
  return false
}

type Watched = "diff" | "hashCreate" | "hashVerify" | "many"

/** Jobs of the open diff dialog and of checksum commands, by what they are for. */
const watched = new Map<number, Watched>()

/** Follows a job to its end; one that ended before it was watched is taken from the queue. */
function watch(jobId: number, kind: Watched): void {
  watched.set(jobId, kind)
  const known = useQueueStore.getState().jobs.find((j) => j.jobId === jobId)
  if (known && !ACTIVE.has(known.state)) onWatchedJob(known)
}

function onWatchedJob(job: JobSnapshot): void {
  const kind = watched.get(job.jobId)
  if (!kind) return
  if (kind === "diff") {
    void diffJobProgress(job)
    return
  }
  if (kind === "many") {
    void manyJobProgress(job)
    return
  }
  if (ACTIVE.has(job.state)) return
  watched.delete(job.jobId)
  notice(hashResult(kind, job))
  // What failed to verify is the result list.
  if (kind === "hashVerify" && job.failed > 0) void showDetails(job.jobId)
}

async function openDiff(left: DiffSide, right: DiffSide): Promise<void> {
  diffRows.reset(0)
  set({ diff: { left, right, info: null, job: null, detail: "", maxChars: 80, error: null } })
  try {
    const info = await bridge.diffOpen(left.id, right.id)
    const d = get().diff
    if (!d || d.left.id !== left.id || d.right.id !== right.id) {
      if (info.diffId) void bridge.diffClose(info.diffId).catch(() => undefined)
      return
    }
    diffRows.reset(info.diffId)
    set({ diff: { ...d, info } })
    if (info.diffId === 0) {
      // Not text, or too large for a diff: identical or not, read in a job.
      const job = await bridge.startJob({
        kind: "compareFiles",
        leftId: left.id,
        rightId: right.id,
      })
      const now = get().diff
      if (now?.left.id === left.id && now.right.id === right.id) {
        set({ diff: { ...now, job } })
        watch(job.jobId, "diff")
      } else void bridge.cancelJob(job.jobId).catch(() => undefined)
    }
  } catch (error) {
    const d = get().diff
    if (d) set({ diff: { ...d, error: errorText(error) } })
  }
}

/** Lets go of what a diff holds in Go: its rows, or the job that compares its bytes. */
function releaseDiff(d: DiffDialogState): void {
  if (d.info?.diffId) void bridge.diffClose(d.info.diffId).catch(() => undefined)
  if (d.job && ACTIVE.has(d.job.state)) void bridge.cancelJob(d.job.jobId).catch(() => undefined)
}

export function closeDiff(): void {
  const d = get().diff
  if (!d) return
  set({ diff: null })
  diffRows.reset(0)
  releaseDiff(d)
}

const ACTIVE = new Set(["queued", "running", "paused", "asking"])

async function diffJobProgress(job: JobSnapshot): Promise<void> {
  const d = get().diff
  if (!d || d.job?.jobId !== job.jobId) return
  set({ diff: { ...d, job } })
  if (ACTIVE.has(job.state)) return
  watched.delete(job.jobId)
  if (job.failed > 0) {
    const errors = await bridge.jobErrors(job.jobId, 0, 1).catch(() => null)
    const now = get().diff
    if (now?.job?.jobId === job.jobId)
      set({ diff: { ...now, detail: errors?.errors[0]?.message ?? "" } })
  }
}

// Checksums ---------------------------------------------------------------------------

export const ALGORITHMS: readonly { value: HashAlgorithm; label: string; ext: string }[] = [
  { value: "sha256", label: "SHA-256", ext: ".sha256" },
  { value: "sha1", label: "SHA-1", ext: ".sha1" },
  { value: "md5", label: "MD5", ext: ".md5" },
  { value: "crc32", label: "CRC32 (SFV)", ext: ".sfv" },
]

const CHECKSUM_EXTS = new Set(["sha256", "sha1", "md5", "sfv"])

export const extOf = (algorithm: HashAlgorithm): string =>
  ALGORITHMS.find((a) => a.value === algorithm)!.ext

const countOf = (d: SelectionDescriptor): number =>
  d.ranges.reduce((n, [a, b]) => n + b - a, 0) + d.include.length

function describe(side: Side, d: SelectionDescriptor): string {
  const item = marksDescriptor(side) ? null : cursorItem(side)
  if (item) return item.name
  return t("{count, plural, one {# item} other {# items}}", { count: countOf(d) })
}

/** What a command acts on, in words: the cursor entry's name, or "12 items" (Stage C09 uses it too). */
export const describeOperand = describe

/** Create checksums: one file beside each file, or one list in the panel's folder. */
export function openHashCreate(side: Side): void {
  if (refusedOnConnection(side)) return
  if (inArchive(side)) {
    notice(t("Copy the files out of the archive to create checksums for them."))
    return
  }
  const source = operand(side)
  if (!source) return
  const p = panel(side)
  const item = marksDescriptor(side) ? null : cursorItem(side)
  const stem = (name: string, isDir: boolean): string => {
    const dot = name.lastIndexOf(".")
    return isDir || dot <= 0 ? name : name.slice(0, dot)
  }
  // Search results have no folder of their own for a list.
  const listAllowed = p.find === null && p.dirId !== null
  set({
    hash: {
      side,
      source,
      what: describe(side, source),
      algorithm: "sha256",
      perFile: !listAllowed || (item !== null && item.kind !== "dir"),
      listAllowed,
      name: item ? stem(item.name, item.kind === "dir") : p.name || "checksums",
      folder: p.path,
      folderDirId: p.dirId,
      error: null,
    },
  })
}

export function updateHash(change: Partial<HashDialogState>): void {
  const h = get().hash
  if (h) set({ hash: { ...h, ...change, error: null } })
}

export const closeHash = (): void => set({ hash: null })

export async function startHashCreate(): Promise<boolean> {
  const h = get().hash
  if (!h) return false
  try {
    const source = { selection: h.source }
    let job: JobSnapshot
    if (h.perFile) {
      job = await bridge.startJob({
        kind: "hashCreate",
        source,
        algorithm: h.algorithm,
        perFile: true,
      })
    } else {
      const name = h.name.trim()
      if (name === "") throw new Error(t("Enter a name for the checksum file."))
      if (h.folderDirId === null)
        throw new Error(t("This panel has no folder for a checksum list."))
      job = await bridge.startJob({
        kind: "hashCreate",
        source,
        algorithm: h.algorithm,
        perFile: false,
        destinationDirId: h.folderDirId,
        name: name + extOf(h.algorithm),
      })
    }
    notice(t("Creating checksums for {what}…", { what: h.what }))
    watch(job.jobId, "hashCreate")
  } catch (error) {
    if (get().hash) set({ hash: { ...get().hash!, error: errorText(error) } })
    return false
  }
  set({ hash: null })
  if (marksDescriptor(h.side)) markNone(h.side)
  return true
}

/** Verify checksums: the marked .sha256, .sha1, .md5 and .sfv files, or the one under the cursor. */
export async function verifyChecksums(side: Side): Promise<void> {
  if (refusedOnConnection(side)) return
  if (inArchive(side)) {
    notice(t("Copy the files out of the archive to verify them."))
    return
  }
  const source = operand(side)
  if (!source) return
  const item = marksDescriptor(side) ? null : cursorItem(side)
  if (item && !CHECKSUM_EXTS.has(item.ext)) {
    notice(t("Put the cursor on a .sha256, .sha1, .md5 or .sfv file to verify it."))
    return
  }
  try {
    const job = await bridge.startJob({ kind: "hashVerify", source: { selection: source } })
    notice(t("Verifying {what}…", { what: describe(side, source) }))
    watch(job.jobId, "hashVerify")
  } catch (error) {
    notice(errorText(error))
  }
}

export function hashResult(kind: "hashCreate" | "hashVerify", job: JobSnapshot): string {
  if (job.state === "cancelled")
    return kind === "hashCreate"
      ? t("Creating checksums was cancelled.")
      : t("Verifying checksums was cancelled.")
  if (job.state === "failed") return job.error || t("The checksum job failed.")
  if (kind === "hashCreate") {
    return job.failed === 0
      ? t("Checksums created for {count, plural, one {# file} other {# files}}.", {
          count: job.done,
        })
      : t(
          "Checksums created for {done, plural, one {# file} other {# files}}; {failed} failed. Details are in the queue (Ctrl+J).",
          { done: job.done, failed: job.failed },
        )
  }
  return job.failed === 0
    ? t("{count, plural, one {# file} other {# files}} verified: all match.", { count: job.done })
    : t(
        "{failed} of {total, plural, one {# file} other {# files}} did not verify: changed, missing or unreadable.",
        { failed: job.failed, total: job.total },
      )
}

// Events ----------------------------------------------------------------------------------

/** Follows the dialog's compare and the jobs started here; started once by the app. */
export function startCompareEvents(): () => void {
  if (!isBridgeAvailable()) return () => undefined
  const offs = [
    bridge.on("query.invalidated", (snapshot) => {
      const run = get().sync?.run
      if (!run) {
        if (starting) early.snapshots.set(snapshot.queryId, snapshot)
        return
      }
      if (snapshot.queryId !== run.queryId || snapshot.version <= run.version) return
      syncRows.invalidate(snapshot)
      patchSync({ run: { ...run, version: snapshot.version, total: snapshot.total } })
    }),
    bridge.on("compare.progress", (progress) => {
      const run = get().sync?.run
      if (run?.compareId === progress.compareId) {
        patchSync({ progress })
        if (progress.state === "completed") void loadPlan()
      } else if (!run && starting) early.progress.set(progress.compareId, progress)
    }),
    bridge.on("job.progress", onWatchedJob),
  ]
  return () => offs.forEach((off) => off())
}

/** Symbols of the table's action column; the same in every language. */
export const SYMBOL: Record<CompareShow, string> = {
  copyRight: "→",
  copyLeft: "←",
  equal: "=",
  different: "≠",
  delete: "×",
}

export const SHOW_LABEL: Record<CompareShow, string> = {
  copyRight: msg("Copy to the right"),
  copyLeft: msg("Copy to the left"),
  equal: msg("Equal"),
  different: msg("Different, no direction"),
  delete: msg("Delete"),
}

/** The symbol a row shows for its action. */
export function symbolOf(diff: NonNullable<ContentItem["diff"]>): CompareShow {
  switch (diff.action) {
    case "copyRight":
      return "copyRight"
    case "copyLeft":
      return "copyLeft"
    case "deleteLeft":
    case "deleteRight":
      return "delete"
  }
  return diff.state === "equal" ? "equal" : "different"
}

/** Tests. */
export function resetCompare(): void {
  compareSeq = 0
  starting = false
  early.progress.clear()
  early.snapshots.clear()
  watched.clear()
  syncRows.reset(null)
  diffRows.reset(0)
  manyAll = []
  manyShown = []
  set({ sync: null, diff: null, hash: null, many: null })
}
