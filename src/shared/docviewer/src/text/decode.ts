export type Encoding = "UTF-8" | "UTF-8 BOM" | "UTF-16 LE" | "UTF-16 BE" | "Windows-1252"
export type LineEnding = "LF" | "CRLF" | "CR" | "mixed" | "none"

/** The most a text window reads; larger files show their first part (ADR-0033). */
export const MAX_TEXT_BYTES = 16 * 1024 * 1024
/** A line longer than this is cut when drawn; a minified bundle must not freeze layout. */
export const MAX_LINE_CHARS = 20_000

export interface DecodedText {
  text: string
  encoding: Encoding
}

/** BOM first, then strict UTF-8, else Windows-1252 (every byte is a character). */
export function decodeText(bytes: Uint8Array, truncated: boolean): DecodedText {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "UTF-8 BOM" }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "UTF-16 LE" }
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "UTF-16 BE" }
  }
  // A cut file may end inside a multi-byte character: drop up to 3 trailing bytes.
  for (let cut = 0; cut <= (truncated ? 3 : 0); cut++) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, bytes.length - cut),
      )
      return { text, encoding: "UTF-8" }
    } catch {
      // try a shorter cut, then fall back
    }
  }
  return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "Windows-1252" }
}

export function lineEndingOf(text: string): LineEnding {
  let lf = 0
  let crlf = 0
  let cr = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 10) lf++
    else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++
        i++
      } else cr++
    }
  }
  const kinds = [lf > 0, crlf > 0, cr > 0].filter(Boolean).length
  if (kinds === 0) return "none"
  if (kinds > 1) return "mixed"
  return lf > 0 ? "LF" : crlf > 0 ? "CRLF" : "CR"
}

export function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/)
  // A trailing line ending does not start another line.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

export interface Match {
  line: number
  start: number
}

/** Case-insensitive occurrences, in order; capped so a one-letter query stays cheap. */
export function findMatches(lines: readonly string[], query: string, cap = 50_000): Match[] {
  const out: Match[] = []
  if (query === "") return out
  const needle = query.toLowerCase()
  for (let line = 0; line < lines.length && out.length < cap; line++) {
    const hay = lines[line]!.toLowerCase()
    for (
      let at = hay.indexOf(needle);
      at >= 0 && out.length < cap;
      at = hay.indexOf(needle, at + needle.length)
    ) {
      out.push({ line, start: at })
    }
  }
  return out
}
