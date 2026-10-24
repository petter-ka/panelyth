import { EditorState, type Text } from "@codemirror/state"
import { describe, expect, it } from "vitest"
import { countDocument, countText, defaultSegmenter } from "./wordCount"

describe("countText", () => {
  it("counts words, characters and lines with Intl.Segmenter", () => {
    const counts = countText("Grüße aus Köln,\nnaïve café — l'homme!")
    expect(counts.words).toBe(6)
    expect(counts.lines).toBe(2)
    // Code points without the line break; "—" and "!" count as characters.
    expect(counts.characters).toBe("Grüße aus Köln,naïve café — l'homme!".length)
  })

  it("counts CJK words with the segmenter", () => {
    expect(defaultSegmenter()).not.toBeNull()
    expect(countText("今日は良い天気です").words).toBeGreaterThan(1)
  })

  it("falls back to a Unicode regex without a segmenter", () => {
    expect(countText("Grüße aus Köln, naïve café — l'homme!", null).words).toBe(6)
    // Each Han or kana character is a word.
    expect(countText("今日は良い天気です", null).words).toBe(9)
    expect(countText("mixed 日本 text", null).words).toBe(4)
    // Combining marks stay inside their word.
    expect(countText("café ok", null).words).toBe(2)
  })

  it("counts an emoji as one character", () => {
    expect(countText("a😀b").characters).toBe(3)
  })
})

const doc = (text: string): Text => EditorState.create({ doc: text }).doc

describe("countDocument", () => {
  it("counts the whole document", async () => {
    const d = doc("one two\nthree\n\nfour five six")
    expect(await countDocument(d, [{ from: 0, to: d.length }], { segmenter: null })).toEqual({
      words: 6,
      characters: 25,
      lines: 4,
    })
  })

  it("counts the selection ranges only", async () => {
    const d = doc("alpha beta gamma\ndelta epsilon")
    // "beta gam" and "delta"
    const ranges = [
      { from: 6, to: 14 },
      { from: 17, to: 22 },
    ]
    expect(await countDocument(d, ranges, { segmenter: null })).toEqual({
      words: 3,
      characters: 13,
      lines: 2,
    })
  })

  it("gives the same result in many small slices as at once", async () => {
    const line = "Lorem ipsum dolor sit amet, ünïcödé wörds 日本語 here.\n"
    const text = line.repeat(5_000)
    const d = doc(text)
    let clock = 0
    let slices = 0
    const sliced = await countDocument(d, [{ from: 0, to: d.length }], {
      segmenter: null,
      sliceMs: 1,
      // Every reading of the clock moves it on, so each slice ends after one batch.
      now: () => (clock += 1),
      yieldTo: (next) => {
        slices++
        queueMicrotask(next)
      },
    })
    expect(slices).toBeGreaterThan(3)
    expect(sliced).toEqual(countText(text, null))
    expect(sliced?.lines).toBe(5_001)
  })

  it("stops when cancelled", async () => {
    const d = doc("word ".repeat(100_000))
    let cancelled = false
    const result = countDocument(d, [{ from: 0, to: d.length }], {
      segmenter: null,
      sliceMs: 0,
      yieldTo: (next) => {
        cancelled = true
        queueMicrotask(next)
      },
      cancelled: () => cancelled,
    })
    expect(await result).toBeNull()
  })
})
