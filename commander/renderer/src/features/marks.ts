import type { SelectionDescriptor } from "@fastview/contracts"
import {
  addRanges,
  fromRanges,
  hasMarks,
  invert,
  markCount,
  NO_MARKS,
  removeRanges,
  setMarked,
  toDescriptor,
  toggle,
  type Marks,
} from "@fastview/renderer-core"
import { create } from "zustand"
import { bridge, isBridgeAvailable } from "../bridge"
import {
  moveCursor,
  onSessionChanged,
  pageStoreOf,
  parentRows,
  rowCount,
  useListingStore,
} from "./listing"
import type { Side } from "./panels"

// The marked set per panel (Stage C02, ADR-0028): separate from the cursor,
// kept as a selection descriptor of the panel's session (ADR-0017), so
// marking all of 100k entries is one range. Indexes are session indexes; the
// synthetic ".." row is never marked.

export interface PanelMarks extends Marks {
  /** The session version the indexes belong to. */
  version: number
  /** Where Shift+arrows and Shift+click extend from (a session index), and the marks then. */
  anchor: number | null
  base: Marks
}

const empty = (): PanelMarks => ({ ...NO_MARKS, version: 0, anchor: null, base: NO_MARKS })

export const useMarksStore = create<Record<Side, PanelMarks>>(() => ({
  left: empty(),
  right: empty(),
}))

const getMarks = (side: Side): PanelMarks => useMarksStore.getState()[side]
const listing = (side: Side) => useListingStore.getState()[side]

function setMarks(side: Side, marks: Marks, keepAnchor = false): void {
  const prev = getMarks(side)
  const version = listing(side).query?.version ?? 0
  useMarksStore.setState({
    [side]: {
      ranges: marks.ranges,
      include: marks.include,
      exclude: marks.exclude,
      version,
      anchor: keepAnchor ? prev.anchor : null,
      base: keepAnchor ? prev.base : marks,
    },
  })
}

/** The entry index and id under a view row, loading its page if needed. */
async function entryAt(side: Side, row: number): Promise<{ index: number; id: number } | null> {
  const index = row - parentRows(listing(side))
  if (index < 0) return null
  const item = await pageStoreOf(side).ensureIndex(index)
  return item ? { index, id: item.id } : null
}

/** Insert (and Space, without moving): flips the cursor entry. */
export async function toggleCursor(side: Side, advance: boolean): Promise<void> {
  const { cursor } = listing(side)
  const at = await entryAt(side, cursor)
  if (at) setMarks(side, toggle(getMarks(side), at.index, at.id))
  if (advance) moveCursor(side, cursor + 1)
}

/** Ctrl+click: flips one row. */
export async function toggleRow(side: Side, row: number): Promise<void> {
  const at = await entryAt(side, row)
  if (at) setMarks(side, toggle(getMarks(side), at.index, at.id))
}

/**
 * Shift+arrows and Shift+click: the marks at the anchor plus everything from
 * the anchor to `row` (the viewer's additive rules, Stage 08.6). The first
 * extension anchors at the cursor.
 */
export function extendTo(side: Side, fromRow: number, row: number): void {
  const parent = parentRows(listing(side))
  const m = getMarks(side)
  const anchor = m.anchor ?? Math.max(0, fromRow - parent)
  const base = m.anchor === null ? fromMarks(m) : m.base
  const to = Math.max(0, row - parent)
  const next = addRanges(base, [[Math.min(anchor, to), Math.max(anchor, to) + 1]])
  useMarksStore.setState({
    [side]: { ...next, version: listing(side).query?.version ?? 0, anchor, base },
  })
}

const fromMarks = (m: Marks): Marks => ({
  ranges: m.ranges,
  include: m.include,
  exclude: m.exclude,
})

/** Any other cursor move ends a Shift extension. */
export function dropAnchor(side: Side): void {
  const m = getMarks(side)
  if (m.anchor !== null)
    useMarksStore.setState({ [side]: { ...m, anchor: null, base: fromMarks(m) } })
}

const entryTotal = (side: Side): number => listing(side).query?.total ?? 0

export function markAll(side: Side): void {
  const total = entryTotal(side)
  setMarks(side, total > 0 ? fromRanges([[0, total]]) : NO_MARKS)
}

export function markNone(side: Side): void {
  setMarks(side, NO_MARKS)
}

export function invertMarks(side: Side): void {
  setMarks(side, invert(getMarks(side), entryTotal(side)))
}

/** Match attempts while the folder refreshes (each refresh is a new version). */
const MASK_ATTEMPTS = 4

/** Num+ / Num−: mark or unmark the files matching a mask (Go matches, files only). */
export async function markByMask(side: Side, mask: string, mark: boolean): Promise<number> {
  const query = listing(side).query
  if (!query || mask.trim() === "") return 0
  for (let attempt = 0; attempt < MASK_ATTEMPTS; attempt++) {
    const res = await bridge.match(query.queryId, mask.trim())
    const now = listing(side).query
    if (now?.queryId !== query.queryId) return 0 // another folder: the mask was for this one
    // A refresh (a rescan commits in batches) made a new version while Go
    // matched: the ranges index the old rows, so match the new version.
    if (res.version !== now.version) continue
    const m = getMarks(side)
    setMarks(side, mark ? addRanges(m, res.ranges) : removeRanges(m, res.ranges))
    return res.count
  }
  return 0
}

/** Alt+Num+: everything with the cursor entry's extension. */
export async function markSameExtension(side: Side): Promise<void> {
  const at = await entryAt(side, listing(side).cursor)
  const item = at ? pageStoreOf(side).getItem(at.index) : undefined
  if (!item || item.kind === "dir") return
  await markByMask(side, item.ext ? `*.${item.ext}` : "*.", true)
}

/** Marks from Go (a carried selection): ranges of the current session version. */
export function applyMarks(side: Side, d: SelectionDescriptor): void {
  if (listing(side).query?.queryId !== d.queryId) return
  setMarks(side, fromRanges(d.ranges))
}

/** Space on a folder: mark it (never unmark) before its size is calculated. */
export async function markCursor(side: Side): Promise<void> {
  const at = await entryAt(side, listing(side).cursor)
  if (at) setMarks(side, setMarked(getMarks(side), at.index, at.id, true))
}

/** The marks as a descriptor, or null when nothing is marked. */
export function marksDescriptor(side: Side): SelectionDescriptor | null {
  const m = getMarks(side)
  const query = listing(side).query
  if (!query || !hasMarks(m)) return null
  return toDescriptor(m, query.queryId, m.version || query.version)
}

/** The cursor entry as a descriptor (commands act on it when nothing is marked). */
export function cursorDescriptor(side: Side): SelectionDescriptor | null {
  const p = listing(side)
  const index = p.cursor - parentRows(p)
  if (!p.query || index < 0 || p.cursor >= rowCount(p)) return null
  return {
    queryId: p.query.queryId,
    version: p.query.version,
    ranges: [[index, index + 1]],
    include: [],
    exclude: [],
  }
}

export const marksOf = (side: Side): PanelMarks => getMarks(side)
export const countOf = (m: Marks): number => markCount(m)

/** New sessions start unmarked; a new version of the same session is rebased in Go. */
export function startMarks(): () => void {
  return onSessionChanged((side, change) => {
    if (change.kind === "reset") {
      useMarksStore.setState({ [side]: empty() })
      return
    }
    const m = getMarks(side)
    if (!hasMarks(m) || !isBridgeAvailable()) {
      useMarksStore.setState({ [side]: { ...m, version: change.to } })
      return
    }
    const d = toDescriptor(m, change.queryId, m.version || change.from)
    void bridge
      .rebase(d)
      .then((rebased) => {
        if (listing(side).query?.queryId !== change.queryId) return
        setMarks(side, fromRanges(rebased.ranges))
      })
      .catch(() => setMarks(side, NO_MARKS))
  })
}

/** Ctrl+U: the panels trade their marks too. */
export function swapMarks(): void {
  const { left, right } = useMarksStore.getState()
  useMarksStore.setState({ left: right, right: left })
}

/** Tests. */
export function resetMarks(): void {
  useMarksStore.setState({ left: empty(), right: empty() })
}
