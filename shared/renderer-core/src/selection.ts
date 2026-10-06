import type { SelectionDescriptor } from "@fastview/contracts"

/**
 * The selection algebra of ADR-0017, shared by the viewer's selection and the
 * commander's marks (ADR-0028): index ranges of one session version plus
 * explicit additions and removals. Selecting all of a 100k folder is one
 * range; nothing ever lists every selected id. Explicit ids remember their
 * index, so the set stays normalized (no overlap between ranges and include,
 * exclude only inside ranges) and the count is exact without asking Go.
 *
 * Every function is pure and returns a new value.
 */
export interface Marks {
  /** Sorted, merged [start, end) ranges. */
  ranges: [number, number][]
  /** Ids outside the ranges, with their index. */
  include: Map<number, number>
  /** Ids inside the ranges that are not selected, with their index. */
  exclude: Map<number, number>
}

export const NO_MARKS: Marks = { ranges: [], include: new Map(), exclude: new Map() }

/** Binary search: ranges are sorted and disjoint. */
export function inRanges(ranges: readonly [number, number][], index: number): boolean {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const [a, b] = ranges[mid]!
    if (index < a) hi = mid - 1
    else if (index >= b) lo = mid + 1
    else return true
  }
  return false
}

/** True when the entry at index (with id, once its page is loaded) is selected. */
export function isMarked(m: Marks, index: number, id: number | undefined): boolean {
  if (id !== undefined && m.include.has(id)) return true
  return inRanges(m.ranges, index) && (id === undefined || !m.exclude.has(id))
}

/** Merges ranges and moves explicit ids that the ranges now cover. */
export function normalize(
  ranges: readonly [number, number][],
  include: ReadonlyMap<number, number>,
  exclude: ReadonlyMap<number, number>,
): Marks {
  const sorted = ranges.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const merged: [number, number][] = []
  for (const r of sorted) {
    const last = merged.at(-1)
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([r[0], r[1]])
  }
  const inc = new Map([...include].filter(([, i]) => !inRanges(merged, i)))
  const exc = new Map([...exclude].filter(([, i]) => inRanges(merged, i)))
  return { ranges: merged, include: inc, exclude: exc }
}

export function markCount(m: Marks): number {
  let n = 0
  for (const [a, b] of m.ranges) n += b - a
  return n - m.exclude.size + m.include.size
}

export const hasMarks = (m: Marks): boolean => m.ranges.length > 0 || m.include.size > 0

/** Flips one entry. */
export function toggle(m: Marks, index: number, id: number): Marks {
  const include = new Map(m.include)
  const exclude = new Map(m.exclude)
  const marked = isMarked(m, index, id)
  if (inRanges(m.ranges, index)) {
    if (marked) exclude.set(id, index)
    else exclude.delete(id)
  } else if (marked) include.delete(id)
  else include.set(id, index)
  return normalize(m.ranges, include, exclude)
}

/** Sets one entry to marked or unmarked. */
export function setMarked(m: Marks, index: number, id: number, marked: boolean): Marks {
  return isMarked(m, index, id) === marked ? m : toggle(m, index, id)
}

/** Adds ranges; entries inside them that were removed explicitly are added back. */
export function addRanges(m: Marks, ranges: readonly [number, number][]): Marks {
  return normalize(
    [...m.ranges, ...ranges],
    m.include,
    new Map([...m.exclude].filter(([, i]) => !inRanges(ranges, i))),
  )
}

/** Removes ranges (unmark by mask); explicit additions inside them go too. */
export function removeRanges(m: Marks, ranges: readonly [number, number][]): Marks {
  if (ranges.length === 0) return m
  const cut = normalize(ranges, new Map(), new Map()).ranges
  const out: [number, number][] = []
  for (const [a, b] of m.ranges) {
    let start = a
    for (const [c, d] of cut) {
      if (d <= start || c >= b) continue
      if (c > start) out.push([start, c])
      start = Math.max(start, d)
    }
    if (start < b) out.push([start, b])
  }
  return normalize(
    out,
    new Map([...m.include].filter(([, i]) => !inRanges(cut, i))),
    new Map([...m.exclude].filter(([, i]) => !inRanges(cut, i))),
  )
}

/** Everything that was not selected becomes selected, and the other way round. */
export function invert(m: Marks, total: number): Marks {
  const ranges: [number, number][] = []
  let at = 0
  for (const [a, b] of m.ranges) {
    if (a > at) ranges.push([at, Math.min(a, total)])
    at = Math.max(at, b)
  }
  if (at < total) ranges.push([at, total])
  // Removed ids inside the old ranges are outside the new ones: now added,
  // and added ids outside the old ranges are inside the new ones: now removed.
  return normalize(ranges, m.exclude, m.include)
}

export function toDescriptor(m: Marks, queryId: number, version: number): SelectionDescriptor {
  return {
    queryId,
    version,
    ranges: m.ranges.map(([a, b]) => [a, b]),
    include: [...m.include.keys()],
    exclude: [...m.exclude.keys()],
  }
}

/** Marks from a descriptor Go produced (rebased or carried over): ranges only. */
export function fromRanges(ranges: readonly [number, number][]): Marks {
  return normalize(ranges, new Map(), new Map())
}
