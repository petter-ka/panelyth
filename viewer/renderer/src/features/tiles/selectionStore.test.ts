import { beforeEach, describe, expect, it } from "vitest"
import {
  applyRebased,
  clearSelection,
  focusAndSelect,
  focusOnly,
  isSelected,
  resetSelection,
  selectAll,
  selectionCount,
  selectRangeTo,
  toDescriptor,
  toggleSelected,
  useSelectionStore,
} from "./selectionStore"

// Test ids are index + 100.
const id = (i: number) => i + 100
const s = () => useSelectionStore.getState()
const selected = (n: number) =>
  Array.from({ length: n }, (_, i) => i).filter((i) => isSelected(s(), i, id(i)))

beforeEach(() => resetSelection())

describe("selection descriptors (ADR-0017)", () => {
  it("click selects one; shift extends from the anchor; ctrl+shift adds a range", () => {
    focusAndSelect(2, id(2))
    expect(selected(10)).toEqual([2])
    selectRangeTo(5, id(5))
    expect(selected(10)).toEqual([2, 3, 4, 5])
    expect(s().ranges).toEqual([[2, 6]])
    toggleSelected(8, id(8)) // anchor moves to 8
    selectRangeTo(9, id(9), true)
    expect(selected(12)).toEqual([2, 3, 4, 5, 8, 9])
    expect(selectionCount(s())).toBe(6)
  })

  it("ctrl-picks one by one, then ctrl+shift adds a range without clearing them", () => {
    focusAndSelect(1, id(1))
    toggleSelected(4, id(4))
    toggleSelected(7, id(7)) // anchor moves to 7
    selectRangeTo(10, id(10), true)
    expect(selected(15)).toEqual([1, 4, 7, 8, 9, 10])
    // A second ctrl+shift range from a new ctrl pick keeps everything so far.
    toggleSelected(13, id(13))
    selectRangeTo(12, id(12), true)
    expect(selected(15)).toEqual([1, 4, 7, 8, 9, 10, 12, 13])
    expect(selectionCount(s())).toBe(8)
  })

  it("ctrl-picks, then plain shift adds a range; moving the shift end keeps the picks", () => {
    focusAndSelect(1, id(1))
    toggleSelected(4, id(4))
    toggleSelected(7, id(7)) // anchor 7, picks 1 4 7
    selectRangeTo(10, id(10))
    expect(selected(15)).toEqual([1, 4, 7, 8, 9, 10])
    selectRangeTo(8, id(8)) // shorter shift range: 9 and 10 drop, the picks stay
    expect(selected(15)).toEqual([1, 4, 7, 8])
    selectRangeTo(5, id(5)) // backwards from the anchor
    expect(selected(15)).toEqual([1, 4, 5, 6, 7])
    // A plain click starts over: the next shift range is alone.
    focusAndSelect(12, id(12))
    selectRangeTo(13, id(13))
    expect(selected(15)).toEqual([12, 13])
  })

  it("an added range re-selects ids that ctrl+click had removed from it", () => {
    selectAll(10)
    toggleSelected(3, id(3))
    toggleSelected(5, id(5))
    focusOnly(2)
    useSelectionStore.setState({ anchorIndex: 2 })
    selectRangeTo(4, id(4), true)
    expect(selected(10)).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9])
    expect(selectionCount(s())).toBe(9)
  })

  it("ctrl-click inside a range excludes, outside includes, and toggles back", () => {
    selectAll(10)
    toggleSelected(3, id(3))
    expect(selected(10)).toEqual([0, 1, 2, 4, 5, 6, 7, 8, 9])
    expect(s().exclude.has(id(3))).toBe(true)
    toggleSelected(3, id(3))
    expect(selected(10)).toHaveLength(10)
    expect(s().exclude.size).toBe(0)
    clearSelection()
    toggleSelected(7, id(7))
    toggleSelected(1, id(1))
    expect(selected(10)).toEqual([1, 7])
    expect(s().ranges).toEqual([])
    toggleSelected(7, id(7))
    expect(selected(10)).toEqual([1])
  })

  it("keeps the count exact when a range grows over explicit ids", () => {
    toggleSelected(4, id(4)) // include
    focusAndSelect(0, id(0))
    toggleSelected(4, id(4))
    selectRangeTo(6, id(6), true) // anchor 4 → [4, 7) covers the included 4
    expect(selectionCount(s())).toBe(selected(10).length)
    expect(s().include.size).toBe(0)
  })

  it("select-all of 100k entries is one range, not 100k ids", () => {
    selectAll(100_000)
    const d = toDescriptor(s(), 3, 9)
    expect(d).toEqual({ queryId: 3, version: 9, ranges: [[0, 100_000]], include: [], exclude: [] })
    expect(JSON.stringify(d).length).toBeLessThan(100)
    expect(selectionCount(s())).toBe(100_000)
  })

  it("applies a rebased descriptor as ranges only", () => {
    selectAll(5)
    toggleSelected(2, id(2))
    applyRebased({
      queryId: 1,
      version: 2,
      ranges: [
        [0, 2],
        [3, 6],
      ],
      include: [],
      exclude: [],
    })
    expect(s().exclude.size).toBe(0)
    expect(selected(8)).toEqual([0, 1, 3, 4, 5])
  })
})
