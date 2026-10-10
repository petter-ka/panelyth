import { describe, expect, it } from "vitest"
import {
  chordAllowedWhileTyping,
  eventChord,
  formatChord,
  parseChord,
  parseOverrides,
  resolveKeymap,
  type ActionDef,
} from "./keymap"
import {
  addRanges,
  fromRanges,
  invert,
  isMarked,
  markCount,
  NO_MARKS,
  removeRanges,
  setMarked,
  toDescriptor,
  toggle,
} from "./selection"

// Ids are index + 100 in these tests.
const id = (i: number) => i + 100
const marked = (m: Parameters<typeof isMarked>[0], total: number) =>
  Array.from({ length: total }, (_, i) => i).filter((i) => isMarked(m, i, id(i)))

describe("selection algebra (ADR-0017)", () => {
  it("toggles single entries inside and outside ranges", () => {
    let m = fromRanges([[2, 6]])
    m = toggle(m, 3, id(3))
    m = toggle(m, 8, id(8))
    expect(marked(m, 10)).toEqual([2, 4, 5, 8])
    expect(markCount(m)).toBe(4)
    expect(toDescriptor(m, 1, 2)).toEqual({
      queryId: 1,
      version: 2,
      ranges: [[2, 6]],
      include: [id(8)],
      exclude: [id(3)],
    })
    expect(setMarked(m, 8, id(8), true)).toBe(m)
    expect(marked(setMarked(m, 8, id(8), false), 10)).toEqual([2, 4, 5])
  })

  it("inverts in one pass, keeping explicit picks exact", () => {
    let m = fromRanges([
      [0, 2],
      [5, 7],
    ])
    m = toggle(m, 6, id(6)) // removed inside a range
    m = toggle(m, 9, id(9)) // added outside
    const inv = invert(m, 10)
    expect(marked(inv, 10)).toEqual([2, 3, 4, 6, 7, 8])
    expect(markCount(inv)).toBe(6)
    expect(marked(invert(inv, 10), 10)).toEqual(marked(m, 10))
    // Inverting nothing on 100k is one range.
    expect(invert(NO_MARKS, 100_000).ranges).toEqual([[0, 100_000]])
  })

  it("adds and removes ranges (mark and unmark by mask)", () => {
    let m = toggle(fromRanges([[0, 10]]), 4, id(4))
    m = addRanges(m, [[3, 6]])
    expect(markCount(m)).toBe(10) // the explicit removal inside [3, 6) is undone
    m = toggle(m, 20, id(20))
    m = removeRanges(m, [
      [2, 4],
      [8, 30],
    ])
    expect(marked(m, 30)).toEqual([0, 1, 4, 5, 6, 7])
    expect(markCount(m)).toBe(6)
  })
})

describe("keymap engine", () => {
  it("names numeric keypad keys apart from the main keys", () => {
    const ev = (key: string, code: string, mods: Partial<KeyboardEvent> = {}) =>
      eventChord({
        key,
        code,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        ...mods,
      })
    expect(ev("+", "NumpadAdd")).toBe("Num+")
    expect(ev("+", "Equal")).toBe("Plus")
    expect(ev("-", "NumpadSubtract", { ctrlKey: true })).toBe("Mod+Num-")
    expect(ev("*", "NumpadMultiply")).toBe("Num*")
    expect(ev("+", "NumpadAdd", { altKey: true })).toBe("Alt+Num+")
    expect(parseChord("Mod+Num+")).toBe("Mod+Num+")
    expect(parseChord("Num*")).toBe("Num*")
    expect(parseChord("Shift+Insert")).toBe("Shift+Insert")
    expect(parseChord("Mod++")).toBeNull()
    expect(formatChord("Alt+Num+", false)).toBe("Alt+Num+")
    expect(formatChord("Insert", false)).toBe("Ins")
    expect(chordAllowedWhileTyping("Num+")).toBe(false)
    expect(chordAllowedWhileTyping("Mod+Num-")).toBe(true)
  })

  it("resolves per scope with overrides first", () => {
    const actions: ActionDef<"panel" | "shell">[] = [
      { id: "a", scope: "panel", label: "A", group: "G", defaults: ["Insert"] },
      { id: "b", scope: "panel", label: "B", group: "G", defaults: ["Space"] },
      { id: "c", scope: "shell", label: "C", group: "G", defaults: ["Insert"] },
    ]
    const overrides = parseOverrides(actions, { v: 1, bindings: { b: ["Insert"], zz: ["x"] } })
    expect(overrides.bindings).toEqual({ b: ["Insert"] })
    const km = resolveKeymap(actions, ["panel", "shell"], overrides, false)
    expect(km.lookup.panel.get("Insert")).toBe("b")
    expect(km.chords.a).toEqual([])
    expect(km.lookup.shell.get("Insert")).toBe("c")
  })
})
