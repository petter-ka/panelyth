import type { ByteSource } from "./bytes"
import { msg } from "@panelyth/i18n"

// Text in byte windows (Stage C05): encoding detection on the first window,
// lines found inside a loaded window, and search over the whole file in
// bounded chunks. Nothing here ever holds more than a window of the file.

export type Encoding =
  | "utf-8"
  | "utf-16le"
  | "utf-16be"
  | "windows-1252"
  | "windows-1250"
  | "windows-1251"
  | "iso-8859-2"
  | "koi8-r"

export const ENCODINGS: readonly { value: Encoding; label: string }[] = [
  { value: "utf-8", label: "UTF-8" },
  { value: "utf-16le", label: "UTF-16 LE" },
  { value: "utf-16be", label: "UTF-16 BE" },
  { value: "windows-1252", label: msg("Western (Windows-1252, Latin-1)") },
  { value: "windows-1250", label: msg("Central European (Windows-1250)") },
  { value: "iso-8859-2", label: msg("Central European (ISO-8859-2)") },
  { value: "windows-1251", label: msg("Cyrillic (Windows-1251)") },
  { value: "koi8-r", label: msg("Cyrillic (KOI8-R)") },
]

/** The window detection and the quick view read first. */
export const DETECT_BYTES = 64 * 1024
/** A longer line is shown in segments of this many bytes (bounds every window). */
export const MAX_LINE_BYTES = 4096

export const unitOf = (e: Encoding): 1 | 2 => (e === "utf-16le" || e === "utf-16be" ? 2 : 1)

export interface Detection {
  encoding: Encoding
  /** Bytes of the byte order mark (the text starts after it). */
  bom: number
  /** Not text: the quick view and the lister start in hex. */
  binary: boolean
}

/**
 * UTF-8 validity of a window. A sequence cut by the window's end counts as
 * valid; overlong forms, surrogates and values above U+10FFFF do not.
 */
export function isValidUtf8(b: Uint8Array): boolean {
  let i = 0
  while (i < b.length) {
    const c = b[i]!
    if (c < 0x80) {
      i++
      continue
    }
    let n: number
    let min: number
    if (c >= 0xc2 && c <= 0xdf) [n, min] = [1, 0x80]
    else if (c >= 0xe0 && c <= 0xef) [n, min] = [2, 0x800]
    else if (c >= 0xf0 && c <= 0xf4) [n, min] = [3, 0x10000]
    else return false
    if (i + n >= b.length) {
      // Cut by the window: the bytes present must still be continuations.
      for (let k = i + 1; k < b.length; k++) if ((b[k]! & 0xc0) !== 0x80) return false
      return true
    }
    let cp = c & (0xff >> (n + 2))
    for (let k = 1; k <= n; k++) {
      const d = b[i + k]!
      if ((d & 0xc0) !== 0x80) return false
      cp = (cp << 6) | (d & 0x3f)
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false
    i += n + 1
  }
  return true
}

/** Control bytes that never appear in text (tab, newlines, form feed and escape do). */
const isBinaryByte = (c: number): boolean =>
  c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c && c !== 0x1b

/**
 * Detects the encoding of a file from its first window: a byte order mark;
 * UTF-16 without one (zero bytes on one side of mostly-ASCII text); then
 * valid UTF-8; then a single-byte fallback (Windows-1252, a Latin-1
 * superset). Zero or control bytes elsewhere mean binary.
 */
export function detectEncoding(b: Uint8Array): Detection {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)
    return { encoding: "utf-8", bom: 3, binary: false }
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe)
    return { encoding: "utf-16le", bom: 2, binary: false }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff)
    return { encoding: "utf-16be", bom: 2, binary: false }
  const pairs = Math.floor(b.length / 2)
  if (pairs >= 2) {
    let evenZero = 0
    let oddZero = 0
    for (let i = 0; i < pairs * 2; i += 2) {
      if (b[i] === 0) evenZero++
      if (b[i + 1] === 0) oddZero++
    }
    // ASCII-range UTF-16: one byte of nearly every unit is zero, the other almost never.
    if (oddZero > pairs * 0.6 && evenZero < pairs * 0.05)
      return { encoding: "utf-16le", bom: 0, binary: false }
    if (evenZero > pairs * 0.6 && oddZero < pairs * 0.05)
      return { encoding: "utf-16be", bom: 0, binary: false }
  }
  let control = 0
  for (const c of b) {
    if (c === 0) return { encoding: "windows-1252", bom: 0, binary: true }
    if (isBinaryByte(c)) control++
  }
  const binary = control > b.length * 0.1
  if (isValidUtf8(b)) return { encoding: "utf-8", bom: 0, binary }
  return { encoding: "windows-1252", bom: 0, binary }
}

const decoders = new Map<Encoding, TextDecoder>()

export function decode(bytes: Uint8Array, encoding: Encoding): string {
  let d = decoders.get(encoding)
  if (!d) decoders.set(encoding, (d = new TextDecoder(encoding)))
  return d.decode(bytes)
}

/** Offsets are absolute byte positions in the file. */
export interface Line {
  start: number
  /** End of the text (newline and a CR before it excluded). */
  end: number
  /** Start of the next line. */
  next: number
}

function isNewline(b: Uint8Array, i: number, e: Encoding): boolean {
  if (e === "utf-16le") return b[i] === 0x0a && b[i + 1] === 0
  if (e === "utf-16be") return b[i] === 0 && b[i + 1] === 0x0a
  return b[i] === 0x0a
}

function isCR(b: Uint8Array, i: number, e: Encoding): boolean {
  if (i < 0) return false
  if (e === "utf-16le") return b[i] === 0x0d && b[i + 1] === 0
  if (e === "utf-16be") return b[i] === 0 && b[i + 1] === 0x0d
  return b[i] === 0x0d
}

/** Moves a cut back to a character boundary (never splits a UTF-8 sequence or a surrogate pair). */
function charBoundary(b: Uint8Array, cut: number, from: number, e: Encoding): number {
  if (e === "utf-8") {
    let c = cut
    while (c > from + 1 && cut - c < 3 && (b[c]! & 0xc0) === 0x80) c--
    return c
  }
  if (e === "utf-16le" || e === "utf-16be") {
    const hi = e === "utf-16le" ? b[cut - 1]! : b[cut - 2]!
    return hi >= 0xd8 && hi <= 0xdb && cut - 2 > from ? cut - 2 : cut
  }
  return cut
}

/**
 * Lines of a window that starts at a line start (`base`). Stops at an
 * incomplete line unless the window reaches the end of the file; a line
 * longer than MAX_LINE_BYTES continues as the next segment.
 */
export function splitLines(
  b: Uint8Array,
  base: number,
  encoding: Encoding,
  maxLines: number,
  fileSize: number,
): Line[] {
  const unit = unitOf(encoding)
  const atEof = base + b.length >= fileSize
  const lines: Line[] = []
  let start = 0
  while (lines.length < maxLines && start < b.length) {
    const limit = Math.min(b.length, start + MAX_LINE_BYTES)
    let i = start
    while (i + unit <= limit && !isNewline(b, i, encoding)) i += unit
    if (i + unit <= b.length && isNewline(b, i, encoding)) {
      const end = isCR(b, i - unit, encoding) && i - unit >= start ? i - unit : i
      lines.push({ start: base + start, end: base + end, next: base + i + unit })
      start = i + unit
    } else if (i - start >= MAX_LINE_BYTES) {
      const cut = charBoundary(b, start + MAX_LINE_BYTES, start, encoding)
      lines.push({ start: base + start, end: base + cut, next: base + cut })
      start = cut
    } else if (atEof) {
      const end = b.length - ((b.length - start) % unit)
      lines.push({ start: base + start, end: base + end, next: fileSize })
      start = b.length
    } else {
      break // the rest of this line is in the next window
    }
  }
  return lines
}

/** Reads the lines from a line start: enough for `rows` rows. */
export async function linesAt(
  source: ByteSource,
  top: number,
  encoding: Encoding,
  rows: number,
): Promise<Line[]> {
  const bytes = await source.read(top, top + (rows + 1) * MAX_LINE_BYTES)
  return splitLines(bytes, top, encoding, rows, source.size)
}

/**
 * How far back a line start is searched. Segments of lines up to this long
 * line up exactly with forward reading; beyond it the start is approximate
 * (the window's first byte), as in other file viewers.
 */
const BACK_WINDOW = 4 * MAX_LINE_BYTES

/** The start of the line (segment) before the one starting at `offset`. */
export async function previousLineStart(
  source: ByteSource,
  offset: number,
  encoding: Encoding,
  floor = 0,
): Promise<number> {
  const unit = unitOf(encoding)
  if (offset <= floor) return floor
  const from = Math.max(floor, offset - BACK_WINDOW - 2 * unit)
  const aligned = from - ((from - floor) % unit)
  const b = await source.read(aligned, offset)
  // The newline ending the previous line sits right before offset; the one before that starts it.
  let lineStart = aligned
  for (let i = b.length - 2 * unit; i >= 0; i -= unit) {
    if (isNewline(b, i, encoding)) {
      lineStart = aligned + i + unit
      break
    }
  }
  // Segment the previous line as forward reading does and take the last segment.
  const segments = splitLines(
    b.subarray(lineStart - aligned),
    lineStart,
    encoding,
    Number.MAX_SAFE_INTEGER,
    offset,
  )
  const before = segments.filter((l) => l.start < offset)
  return before.at(-1)?.start ?? lineStart
}

/** The first line start at or after `offset` (scrollbar jumps). */
export async function lineStartFrom(
  source: ByteSource,
  offset: number,
  encoding: Encoding,
  floor = 0,
): Promise<number> {
  const unit = unitOf(encoding)
  if (offset <= floor) return floor
  const at = Math.min(offset, source.size)
  const from = Math.max(floor, at - unit)
  const aligned = from - ((from - floor) % unit)
  const b = await source.read(aligned, aligned + MAX_LINE_BYTES + 2 * unit)
  for (let i = 0; i + unit <= b.length; i += unit) {
    if (isNewline(b, i, encoding)) return Math.min(source.size, aligned + i + unit)
  }
  return Math.min(source.size, aligned + Math.min(b.length, MAX_LINE_BYTES))
}

/** Goes back `count` lines from a line start. */
export async function backLines(
  source: ByteSource,
  offset: number,
  count: number,
  encoding: Encoding,
  floor = 0,
): Promise<number> {
  let at = offset
  for (let n = 0; n < count && at > floor; n++)
    at = await previousLineStart(source, at, encoding, floor)
  return at
}

// Search -------------------------------------------------------------------

/** The query as bytes of the encoding; null when it cannot be represented. */
export function encodeQuery(text: string, encoding: Encoding): Uint8Array | null {
  if (text === "") return null
  if (encoding === "utf-8") return new TextEncoder().encode(text)
  if (encoding === "utf-16le" || encoding === "utf-16be") {
    const out = new Uint8Array(text.length * 2)
    for (let i = 0; i < text.length; i++) {
      const u = text.charCodeAt(i)
      const [a, b] = encoding === "utf-16le" ? [u & 0xff, u >> 8] : [u >> 8, u & 0xff]
      out[i * 2] = a
      out[i * 2 + 1] = b
    }
    return out
  }
  // Single-byte: reverse the decoder's table.
  const table = decode(
    Uint8Array.from({ length: 256 }, (_, i) => i),
    encoding,
  )
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const byte = table.indexOf(text[i]!)
    if (byte < 0) return null
    out[i] = byte
  }
  return out
}

const otherCase = (c: number): number =>
  c >= 0x41 && c <= 0x5a ? c + 32 : c >= 0x61 && c <= 0x7a ? c - 32 : c

/** Search reads 1 MiB at a time and keeps nothing (bounded memory on any file size). */
export const SEARCH_CHUNK = 1024 * 1024

export interface FindOptions {
  /** ASCII letters match either case unless set. */
  caseSensitive: boolean
  backward?: boolean
  signal?: AbortSignal
  /** Fraction of the file searched, at most once per chunk. */
  onProgress?: (fraction: number) => void
}

function matchAt(b: Uint8Array, i: number, p: Uint8Array, alt: Uint8Array): boolean {
  for (let k = 0; k < p.length; k++) {
    const c = b[i + k]
    if (c !== p[k] && c !== alt[k]) return false
  }
  return true
}

/**
 * The byte offset of the next match at or after `from` (backward: the last
 * match starting before `from`), or -1. Matches start on code-unit
 * boundaries of the encoding.
 */
export async function findBytes(
  source: ByteSource,
  pattern: Uint8Array,
  from: number,
  encoding: Encoding,
  options: FindOptions,
): Promise<number> {
  const unit = unitOf(encoding)
  const alt = options.caseSensitive ? pattern : pattern.map(otherCase)
  const overlap = pattern.length - 1
  const total = source.size
  if (!options.backward) {
    for (let at = Math.max(0, from); at < total; at += SEARCH_CHUNK) {
      if (options.signal?.aborted) throw new DOMException("Find cancelled", "AbortError")
      const b = await source.readDirect(at, at + SEARCH_CHUNK + overlap)
      for (let i = 0; i + pattern.length <= b.length; i++) {
        const c = b[i]
        if (
          (c === pattern[0] || c === alt[0]) &&
          (at + i) % unit === 0 &&
          matchAt(b, i, pattern, alt)
        )
          return at + i
      }
      options.onProgress?.(Math.min(1, (at + SEARCH_CHUNK) / Math.max(1, total)))
    }
    return -1
  }
  for (let end = Math.min(from, total); end > 0; end -= SEARCH_CHUNK) {
    if (options.signal?.aborted) throw new DOMException("Find cancelled", "AbortError")
    const start = Math.max(0, end - SEARCH_CHUNK)
    const b = await source.readDirect(start, Math.min(total, end + overlap))
    for (let i = Math.min(end - start - 1, b.length - pattern.length); i >= 0; i--) {
      const c = b[i]
      if (
        (c === pattern[0] || c === alt[0]) &&
        (start + i) % unit === 0 &&
        matchAt(b, i, pattern, alt)
      )
        return start + i
    }
    options.onProgress?.(Math.min(1, (total - start) / Math.max(1, total)))
  }
  return -1
}
