import type { SelectionDescriptor } from "@panelyth/contracts"
import {
  inRanges,
  markCount,
  normalize,
  toDescriptor as marksToDescriptor,
} from "@panelyth/renderer-core"
import { create } from "zustand"

/**
 * Multi-selection as an ADR-0017 descriptor: index ranges of one query
 * session version plus explicit additions and removals. Select-all in a
 * 100k folder is one range; the renderer never holds a list of every
 * selected id. Explicit ids remember their index, so ranges stay normalized
 * (no overlap with include, exclude only inside ranges) and the count is
 * exact without asking Go.
 *
 * Tiles subscribe through `isSelected`, so a change re-renders only the
 * tiles whose state flips.
 */
export interface SelectionState {
  focusIndex: number
  /** Where Shift+click / Shift+arrows extend from. */
  anchorIndex: number
  /** The last clicked or focused-and-selected entry (viewer, preview, properties). */
  selectedId: number | null
  /** Sorted, merged [start, end) ranges. */
  ranges: [number, number][]
  /** Ids outside the ranges, with their index. */
  include: Map<number, number>
  /** Ids inside the ranges that were deselected, with their index. */
  exclude: Map<number, number>
  /** Increments when the tile view should scroll the focused tile into view. */
  revealToken: number
  /**
   * The selection when the anchor was last set. Shift+click / Shift+arrows
   * select base + anchor..target, so earlier Ctrl+click picks stay selected
   * and moving the Shift end only replaces the Shift range.
   */
  base: Selected
}

type Selected = Pick<SelectionState, "ranges" | "include" | "exclude">

const EMPTY: Selected = { ranges: [], include: new Map(), exclude: new Map() }

const snapshot = (s: Selected): Selected => ({
  ranges: s.ranges,
  include: s.include,
  exclude: s.exclude,
})

const initial = (): SelectionState => ({
  focusIndex: 0,
  anchorIndex: 0,
  selectedId: null,
  ranges: [],
  include: new Map(),
  exclude: new Map(),
  revealToken: 0,
  base: EMPTY,
})

export const useSelectionStore = create<SelectionState>(initial)

const set = useSelectionStore.setState
const get = useSelectionStore.getState

export function isSelected(s: SelectionState, index: number, id: number | undefined): boolean {
  if (id !== undefined && s.include.has(id)) return true
  return inRanges(s.ranges, index) && (id === undefined || !s.exclude.has(id))
}

export function selectionCount(s: SelectionState): number {
  return markCount(s)
}

/** Plain click: select only this tile. */
export function focusAndSelect(index: number, id: number | null): void {
  set({
    focusIndex: index,
    anchorIndex: index,
    selectedId: id,
    ranges: id === null ? [] : [[index, index + 1]],
    include: new Map(),
    exclude: new Map(),
    base: EMPTY,
  })
}

/** Focus + select and ask the tile view to scroll it into view (viewer close). */
export function focusSelectAndReveal(index: number, id: number | null): void {
  focusAndSelect(index, id)
  set((s) => ({ revealToken: s.revealToken + 1 }))
}

/** Moves focus without changing the selection (Ctrl+arrows). */
export function focusOnly(index: number): void {
  set({ focusIndex: index })
}

/** Focus a selected tile without collapsing the rest of a multi-selection. */
export function focusAndPreserveSelection(index: number, id: number): void {
  set((s) => ({ focusIndex: index, anchorIndex: index, selectedId: id, base: snapshot(s) }))
}

/** Ctrl/Cmd+click or Ctrl+Space: toggle one tile, keep the rest. */
export function toggleSelected(index: number, id: number): void {
  const s = get()
  const include = new Map(s.include)
  const exclude = new Map(s.exclude)
  const selected = isSelected(s, index, id)
  if (inRanges(s.ranges, index)) {
    if (selected) exclude.set(id, index)
    else exclude.delete(id)
  } else if (selected) include.delete(id)
  else include.set(id, index)
  let selectedId = s.selectedId
  if (!selected) selectedId = id
  else if (selectedId === id) selectedId = null
  const next = normalize(s.ranges, include, exclude)
  set({ focusIndex: index, anchorIndex: index, selectedId, ...next, base: next })
}

/**
 * Shift+click / Shift+arrows: select anchor..index on top of what was
 * selected when the anchor was set (earlier Ctrl+click picks stay). With
 * `additive` (Ctrl+Shift) the range is added to the current selection, so
 * earlier Shift ranges stay as well.
 */
export function selectRangeTo(index: number, id: number | null, additive = false): void {
  const s = get()
  const range: [number, number] = [
    Math.min(s.anchorIndex, index),
    Math.max(s.anchorIndex, index) + 1,
  ]
  const from = additive ? s : s.base
  // The range is selected in full, including ids Ctrl+click had removed.
  const next = normalize(
    [...from.ranges, range],
    from.include,
    new Map([...from.exclude].filter(([, i]) => !inRanges([range], i))),
  )
  set({ focusIndex: index, selectedId: id, ...next })
}

/** Replaces or adds a set of disjoint ranges (used by tile marquee selection). */
export function selectIndexRanges(
  ranges: readonly [number, number][],
  options: {
    additive?: boolean
    anchorIndex: number
    focusIndex: number
    focusId: number | null
  },
): void {
  const s = get()
  const additions = ranges.map(([a, b]) => [a, b] as [number, number])
  const additive = options.additive ?? false
  const include = additive ? new Map(s.include) : new Map<number, number>()
  // A marquee explicitly selects everything it covers, including items that
  // had previously been excluded from a select-all range.
  const exclude = additive
    ? new Map([...s.exclude].filter(([, index]) => !inRanges(additions, index)))
    : new Map<number, number>()
  const base = normalize(additive ? [...s.ranges, ...additions] : additions, include, exclude)
  const next = { ...s, ...base }
  const focusIsSelected = isSelected(next, options.focusIndex, options.focusId ?? undefined)
  set({
    ...base,
    base,
    anchorIndex: options.anchorIndex,
    focusIndex: options.focusIndex,
    selectedId: selectionCount(next) === 1 && focusIsSelected ? options.focusId : null,
  })
}

export function selectAll(total: number): void {
  if (total <= 0) return
  set({ ranges: [[0, total]], include: new Map(), exclude: new Map() })
}

/** Esc: nothing selected, focus stays. */
export function clearSelection(): void {
  set({ ranges: [], include: new Map(), exclude: new Map(), selectedId: null, base: EMPTY })
}

export function hasSelection(s: SelectionState): boolean {
  return s.ranges.length > 0 || s.include.size > 0
}

export function toDescriptor(
  s: SelectionState,
  queryId: number,
  version: number,
): SelectionDescriptor {
  return marksToDescriptor(s, queryId, version)
}

/** Applies a descriptor that Go rebased onto a new session version (ranges only). */
export function applyRebased(d: SelectionDescriptor): void {
  // Indexes moved: the next Shift range starts from what is selected now.
  const next = normalize(d.ranges, new Map(), new Map())
  set({ ...next, base: next })
}

export function resetSelection(): void {
  set({ ...initial(), revealToken: get().revealToken })
}
