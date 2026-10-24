import { TEXTEDIT_CHUNK_CHARS } from "@panelyth/contracts"
import { describe, expect, it } from "vitest"
import { chunkText } from "./chunks"

describe("chunkText", () => {
  it("keeps a short text in one chunk and an empty text as one empty chunk", () => {
    expect(chunkText("hello")).toEqual(["hello"])
    expect(chunkText("")).toEqual([""])
  })

  it("splits a long text in order, full chunks first and the rest last", () => {
    const text = "x".repeat(TEXTEDIT_CHUNK_CHARS * 2 + 123)
    const chunks = chunkText(text)
    expect(chunks.map((c) => c.length)).toEqual([TEXTEDIT_CHUNK_CHARS, TEXTEDIT_CHUNK_CHARS, 123])
    expect(chunks.join("")).toBe(text)
  })

  it("keeps the order of distinct content", () => {
    const text = Array.from({ length: 100 }, (_, i) => String(i).padStart(3, "0")).join("")
    const chunks = chunkText(text, 7)
    expect(chunks.every((c) => c.length <= 7)).toBe(true)
    expect(chunks.join("")).toBe(text)
    expect(chunks.at(-1)).toBe(text.slice(Math.floor(text.length / 7) * 7))
  })

  it("an exact multiple has no empty last chunk", () => {
    expect(chunkText("abcdef", 3)).toEqual(["abc", "def"])
  })

  it("never splits a surrogate pair", () => {
    const text = "ab😀cd😀"
    const chunks = chunkText(text, 3)
    expect(chunks.join("")).toBe(text)
    for (const c of chunks) {
      const last = c.charCodeAt(c.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff, c).toBe(false)
    }
    expect(chunks[0]).toBe("ab")
  })
})
