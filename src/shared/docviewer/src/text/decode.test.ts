import { describe, expect, it } from "vitest"
import { decodeText, findMatches, lineEndingOf, splitLines } from "./decode"

const bytes = (...n: number[]) => new Uint8Array(n)
const enc = (s: string) => new TextEncoder().encode(s)

describe("decodeText", () => {
  it("reads UTF-8, with or without a BOM", () => {
    expect(decodeText(enc("Grüße"), false)).toEqual({ text: "Grüße", encoding: "UTF-8" })
    expect(decodeText(bytes(0xef, 0xbb, 0xbf, 0x68, 0x69), false)).toEqual({
      text: "hi",
      encoding: "UTF-8 BOM",
    })
  })

  it("reads UTF-16 by its BOM", () => {
    expect(decodeText(bytes(0xff, 0xfe, 0x68, 0x00, 0x69, 0x00), false)).toEqual({
      text: "hi",
      encoding: "UTF-16 LE",
    })
    expect(decodeText(bytes(0xfe, 0xff, 0x00, 0x68, 0x00, 0x69), false)).toEqual({
      text: "hi",
      encoding: "UTF-16 BE",
    })
  })

  it("falls back to Windows-1252 for bytes that are not UTF-8", () => {
    expect(decodeText(bytes(0x4b, 0xf6, 0x6c, 0x6e), false)).toEqual({
      text: "Köln",
      encoding: "Windows-1252",
    })
  })

  it("drops a character cut in two at the end of a truncated file, but not of a whole one", () => {
    const cut = enc("aö").subarray(0, 2) // "a" and the first byte of ö
    expect(decodeText(cut, true)).toEqual({ text: "a", encoding: "UTF-8" })
    expect(decodeText(cut, false).encoding).toBe("Windows-1252")
  })
})

describe("lines", () => {
  it("splits on LF, CRLF and CR; a final line ending starts no line", () => {
    expect(splitLines("a\r\nb\nc\rd\n")).toEqual(["a", "b", "c", "d"])
    expect(splitLines("")).toEqual([""])
    expect(splitLines("a\n\n")).toEqual(["a", ""])
  })

  it("names the line ending", () => {
    expect(lineEndingOf("a\nb")).toBe("LF")
    expect(lineEndingOf("a\r\nb\r\n")).toBe("CRLF")
    expect(lineEndingOf("a\rb")).toBe("CR")
    expect(lineEndingOf("a\r\nb\n")).toBe("mixed")
    expect(lineEndingOf("ab")).toBe("none")
  })
})

describe("findMatches", () => {
  it("finds every occurrence, case-insensitively, in order", () => {
    expect(findMatches(["Foo foo", "bar", "fOO"], "foo")).toEqual([
      { line: 0, start: 0 },
      { line: 0, start: 4 },
      { line: 2, start: 0 },
    ])
    expect(findMatches(["aaa"], "aa")).toEqual([{ line: 0, start: 0 }])
    expect(findMatches(["abc"], "")).toEqual([])
  })

  it("stops at the cap", () => {
    expect(findMatches(["a".repeat(100)], "a", 10)).toHaveLength(10)
  })
})
