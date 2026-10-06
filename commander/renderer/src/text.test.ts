import { afterEach, describe, expect, it } from "vitest"
import { ByteSource, CHUNK_BYTES, MAX_CHUNKS, setRangeFetch } from "./features/bytes"
import {
  backLines,
  decode,
  detectEncoding,
  encodeQuery,
  findBytes,
  isValidUtf8,
  lineStartFrom,
  linesAt,
  MAX_LINE_BYTES,
  previousLineStart,
  splitLines,
  type Encoding,
} from "./features/text"

// Stage C05: encoding detection, lines inside byte windows, and search,
// all on bounded windows of the file.

const utf8 = (s: string) => new TextEncoder().encode(s)
const utf16 = (s: string, le = true) => encodeQuery(s, le ? "utf-16le" : "utf-16be")!

/** A ByteSource over memory that counts Range reads. */
function memorySource(bytes: Uint8Array) {
  const reads: [number, number][] = []
  setRangeFetch(async (_url, start, end) => {
    reads.push([start, end])
    return bytes.slice(start, end + 1)
  })
  return { source: new ByteSource("fastview-media://m/test", bytes.length), reads }
}

afterEach(() => setRangeFetch(null))

describe("encoding detection", () => {
  it("honours byte order marks", () => {
    expect(detectEncoding(Uint8Array.of(0xef, 0xbb, 0xbf, 0x41))).toEqual({
      encoding: "utf-8",
      bom: 3,
      binary: false,
    })
    expect(detectEncoding(Uint8Array.of(0xff, 0xfe, 0x41, 0))).toMatchObject({
      encoding: "utf-16le",
      bom: 2,
    })
    expect(detectEncoding(Uint8Array.of(0xfe, 0xff, 0, 0x41))).toMatchObject({
      encoding: "utf-16be",
      bom: 2,
    })
  })

  it("recognizes UTF-16 without a mark, valid UTF-8, and falls back to Windows-1252", () => {
    expect(detectEncoding(utf16("Hello, world\r\nLine two\r\n"))).toMatchObject({
      encoding: "utf-16le",
      bom: 0,
      binary: false,
    })
    expect(detectEncoding(utf16("Hello, world\n", false))).toMatchObject({ encoding: "utf-16be" })
    expect(detectEncoding(utf8("plain ascii\n"))).toMatchObject({
      encoding: "utf-8",
      binary: false,
    })
    expect(detectEncoding(utf8("Grüße, 東京 🙂\n"))).toMatchObject({ encoding: "utf-8" })
    // "café" in Latin-1: 0xE9 alone is not UTF-8.
    expect(detectEncoding(Uint8Array.of(0x63, 0x61, 0x66, 0xe9, 0x0a))).toEqual({
      encoding: "windows-1252",
      bom: 0,
      binary: false,
    })
  })

  it("calls zero bytes and many control bytes binary", () => {
    expect(detectEncoding(Uint8Array.of(0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0)).binary).toBe(true)
    const controls = Uint8Array.from({ length: 100 }, (_, i) => (i % 5 === 0 ? 1 : 0x41))
    expect(detectEncoding(controls).binary).toBe(true)
    expect(detectEncoding(utf8("tabs\tand\fform feeds\x1b[0m\r\n")).binary).toBe(false)
  })

  it("validates UTF-8 strictly but accepts a sequence cut by the window", () => {
    expect(isValidUtf8(utf8("ok €"))).toBe(true)
    expect(isValidUtf8(utf8("€").subarray(0, 2))).toBe(true) // cut at the window's end
    expect(isValidUtf8(Uint8Array.of(0xc0, 0x80))).toBe(false) // overlong
    expect(isValidUtf8(Uint8Array.of(0xed, 0xa0, 0x80))).toBe(false) // surrogate
    expect(isValidUtf8(Uint8Array.of(0xe2, 0x41, 0x41))).toBe(false)
  })
})

describe("lines inside byte windows", () => {
  it("splits on LF and CRLF, excluding the line ends", () => {
    const b = utf8("one\r\ntwo\nthree")
    expect(splitLines(b, 0, "utf-8", 10, b.length)).toEqual([
      { start: 0, end: 3, next: 5 },
      { start: 5, end: 8, next: 9 },
      { start: 9, end: 14, next: 14 },
    ])
  })

  it("stops at an incomplete line unless the window reaches the end of the file", () => {
    const b = utf8("one\ntwo")
    expect(splitLines(b, 100, "utf-8", 10, 1000)).toEqual([{ start: 100, end: 103, next: 104 }])
  })

  it("finds UTF-16 newlines on code-unit boundaries only", () => {
    // U+0A0A ("ਊ") holds 0x0A bytes that are not a newline.
    for (const le of [true, false]) {
      const enc: Encoding = le ? "utf-16le" : "utf-16be"
      const b = utf16("aਊb\r\nc", le)
      const lines = splitLines(b, 0, enc, 10, b.length)
      expect(lines.map((l) => decode(b.subarray(l.start, l.end), enc))).toEqual(["aਊb", "c"])
    }
  })

  it("cuts a long line into segments on character boundaries", () => {
    const text = "€".repeat(MAX_LINE_BYTES) // 3 bytes each
    const b = utf8(text + "\nend")
    const lines = splitLines(b, 0, "utf-8", 100, b.length)
    for (const l of lines.slice(0, -1)) {
      expect(l.end - l.start).toBeLessThanOrEqual(MAX_LINE_BYTES)
      expect(decode(b.subarray(l.start, l.end), "utf-8")).not.toContain("�")
    }
    expect(lines.map((l) => decode(b.subarray(l.start, l.end), "utf-8")).join("")).toBe(
      text + "end",
    )
  })

  it("reads lines from the middle of a big file through cached chunks", async () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`)
    const { source, reads } = memorySource(utf8(lines.join("\n") + "\n"))
    const top = await lineStartFrom(source, Math.floor(source.size / 2), "utf-8")
    const shown = await linesAt(source, top, "utf-8", 5)
    const text = await Promise.all(
      shown.map(async (l) => decode(await source.read(l.start, l.end), "utf-8")),
    )
    const first = Number(text[0]!.split(" ")[1])
    expect(text).toEqual([0, 1, 2, 3, 4].map((k) => `line ${first + k}`))
    // Only the chunks around the window were read.
    expect(reads.every(([a, b]) => b - a < CHUNK_BYTES)).toBe(true)
    expect(source.stats().chunks).toBeLessThanOrEqual(8)
  })

  it("goes back line by line, also across segments and the BOM", async () => {
    const { source } = memorySource(utf8("﻿a\nbb\n" + "x".repeat(MAX_LINE_BYTES + 10) + "\nlast"))
    const all = await linesAt(source, 3, "utf-8", 10)
    // a, bb, the long line in two segments, last
    expect(all).toHaveLength(5)
    for (let k = all.length - 1; k > 0; k--) {
      expect(await previousLineStart(source, all[k]!.start, "utf-8", 3)).toBe(all[k - 1]!.start)
    }
    expect(await previousLineStart(source, all[0]!.start, "utf-8", 3)).toBe(3)
    expect(await backLines(source, all[4]!.start, 10, "utf-8", 3)).toBe(3)
    expect(await lineStartFrom(source, 5, "utf-8", 3)).toBe(all[1]!.start)
    expect(await lineStartFrom(source, 0, "utf-8", 3)).toBe(3)
  })
})

describe("byte sources", () => {
  it("keeps at most MAX_CHUNKS chunks while reading through a file", async () => {
    const size = CHUNK_BYTES * (MAX_CHUNKS + 20)
    const { source, reads } = memorySource(new Uint8Array(size).fill(0x41))
    for (let at = 0; at < size; at += CHUNK_BYTES / 2) await source.read(at, at + 1000)
    expect(source.stats().chunks).toBe(MAX_CHUNKS)
    expect(reads).toHaveLength(MAX_CHUNKS + 20) // each chunk fetched once
    const again = await source.read(size - 10, size + 50)
    expect(again).toHaveLength(10)
    expect(reads).toHaveLength(MAX_CHUNKS + 20) // served from the cache
  })

  it("assembles a read across chunk boundaries and deduplicates in-flight chunks", async () => {
    const bytes = Uint8Array.from({ length: CHUNK_BYTES * 3 }, (_, i) => i % 251)
    const { source, reads } = memorySource(bytes)
    const [a, b] = await Promise.all([
      source.read(CHUNK_BYTES - 5, CHUNK_BYTES * 2 + 5),
      source.read(CHUNK_BYTES, CHUNK_BYTES + 1),
    ])
    expect(Array.from(a)).toEqual(Array.from(bytes.subarray(CHUNK_BYTES - 5, CHUNK_BYTES * 2 + 5)))
    expect(b[0]).toBe(bytes[CHUNK_BYTES])
    expect(reads).toHaveLength(3)
  })
})

describe("find", () => {
  it("encodes the query per encoding", () => {
    expect(Array.from(encodeQuery("é", "windows-1252")!)).toEqual([0xe9])
    expect(Array.from(encodeQuery("é", "utf-8")!)).toEqual([0xc3, 0xa9])
    expect(Array.from(encodeQuery("A", "utf-16be")!)).toEqual([0, 0x41])
    expect(encodeQuery("東", "windows-1252")).toBeNull()
    expect(encodeQuery("", "utf-8")).toBeNull()
  })

  it("finds forward and backward across search chunks, ASCII case-insensitively", async () => {
    const size = 3 * 1024 * 1024
    const bytes = new Uint8Array(size).fill(0x2e)
    bytes.set(utf8("Needle"), 1024 * 1024 - 2) // straddles the first chunk boundary
    bytes.set(utf8("NEEDLE"), 2_500_000)
    const { source } = memorySource(bytes)
    const p = encodeQuery("needle", "utf-8")!
    const opts = { caseSensitive: false }
    const first = await findBytes(source, p, 0, "utf-8", opts)
    expect(first).toBe(1024 * 1024 - 2)
    expect(await findBytes(source, p, first + 1, "utf-8", opts)).toBe(2_500_000)
    expect(await findBytes(source, p, 2_500_001, "utf-8", opts)).toBe(-1)
    expect(await findBytes(source, p, size, "utf-8", { ...opts, backward: true })).toBe(2_500_000)
    expect(await findBytes(source, p, 2_500_000, "utf-8", { ...opts, backward: true })).toBe(first)
    expect(await findBytes(source, p, 0, "utf-8", { caseSensitive: true })).toBe(-1)
    // Search never fills the view cache.
    expect(source.stats().chunks).toBe(0)
  })

  it("matches UTF-16 only on code-unit boundaries and can be cancelled", async () => {
    const bytes = utf16("xAAy")
    const { source } = memorySource(bytes)
    // "A\0" at offset 3 would be an odd-aligned false match of "\0A"-style patterns.
    expect(await findBytes(source, utf16("AA"), 0, "utf-16le", { caseSensitive: true })).toBe(2)
    expect(
      await findBytes(source, Uint8Array.of(0, 0x41), 0, "utf-16le", { caseSensitive: true }),
    ).toBe(-1)
    const abort = new AbortController()
    abort.abort()
    await expect(
      findBytes(source, utf16("y"), 0, "utf-16le", { caseSensitive: true, signal: abort.signal }),
    ).rejects.toThrow("cancelled")
  })
})
