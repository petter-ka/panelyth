import { EditorSelection, EditorState } from "@codemirror/state"
import { SearchQuery } from "@codemirror/search"
import { describe, expect, it } from "vitest"
import { countMatches, MATCH_COUNT_CAP, matchCountLabel } from "./searchPanel"

const state = (doc: string, anchor = 0, head = anchor) =>
  EditorState.create({ doc, selection: EditorSelection.single(anchor, head) })

describe("countMatches", () => {
  it("counts matches and finds the one under the selection", async () => {
    const query = new SearchQuery({ search: "ab" })
    const s = state("ab xx AB ab", 9, 11)
    const count = await countMatches(s, query)
    expect(count).toEqual({ total: 3, capped: false, current: 3 })
    expect(matchCountLabel(count, query)).toBe("3 of 3")
    expect(matchCountLabel({ total: 3, capped: false, current: 0 }, query)).toBe("3 matches")
    expect(matchCountLabel({ total: 1, capped: false, current: 0 }, query)).toBe("1 match")
  })

  it("follows case, whole word and regular expressions", async () => {
    const doc = "cat Cat cats concat"
    expect((await countMatches(state(doc), new SearchQuery({ search: "cat" })))?.total).toBe(4)
    expect(
      (await countMatches(state(doc), new SearchQuery({ search: "cat", caseSensitive: true })))
        ?.total,
    ).toBe(3)
    expect(
      (await countMatches(state(doc), new SearchQuery({ search: "cat", wholeWord: true })))?.total,
    ).toBe(2)
    expect(
      // Without "match case" an expression ignores case too: cat, Cat, cat(s), concat.
      (await countMatches(state(doc), new SearchQuery({ search: "c\\w+t", regexp: true })))?.total,
    ).toBe(4)
  })

  it("says when there is nothing or the expression is invalid", async () => {
    const none = new SearchQuery({ search: "zzz" })
    expect(matchCountLabel(await countMatches(state("abc"), none), none)).toBe("No matches")
    const invalid = new SearchQuery({ search: "(", regexp: true })
    expect(await countMatches(state("abc"), invalid)).toBeNull()
    expect(matchCountLabel(null, invalid)).toBe("Invalid regular expression")
  })

  it("stops at the cap, in slices", async () => {
    const query = new SearchQuery({ search: "a" })
    let slices = 0
    const count = await countMatches(state("a".repeat(MATCH_COUNT_CAP + 50)), query, {
      sliceMs: 0,
      yieldTo: (next) => {
        slices++
        queueMicrotask(next)
      },
    })
    expect(count).toMatchObject({ total: MATCH_COUNT_CAP, capped: true })
    expect(slices).toBeGreaterThan(10)
    expect(matchCountLabel(count, query)).toBe(`More than ${MATCH_COUNT_CAP} matches`)
  })
})
