import type { LineEnding, TextFileEncoding } from "@panelyth/contracts"
import { msg, t } from "@panelyth/i18n"

// The byte order marks the sidecar reports in `bom` (its length in bytes).
const BOMS: readonly (readonly number[])[] = [
  [0xef, 0xbb, 0xbf],
  [0xff, 0xfe],
  [0xfe, 0xff],
]

/**
 * The bytes after the byte order mark. `bom` is the sidecar's count; it is
 * skipped only when the bytes really start with a mark of that length, so a
 * file rewritten since the session opened never loses its first characters.
 */
export function skipBom(bytes: Uint8Array, bom: number): Uint8Array {
  if (bom <= 0) return bytes
  const mark = BOMS.find((m) => m.length === bom && m.every((b, i) => bytes[i] === b))
  return mark ? bytes.subarray(bom) : bytes
}

/** The file's text: one decoder pass; malformed bytes become U+FFFD and never throw. */
export function decodeBytes(bytes: Uint8Array, encoding: TextFileEncoding, bom: number): string {
  // ignoreBOM: the mark was skipped above; a second one is part of the text.
  return new TextDecoder(encoding, { fatal: false, ignoreBOM: true }).decode(skipBom(bytes, bom))
}

const ENCODING_LABELS: Record<TextFileEncoding, string> = {
  "utf-8": "UTF-8",
  "utf-16le": "UTF-16 LE",
  "utf-16be": "UTF-16 BE",
  "windows-1252": "Windows-1252",
  "windows-1250": "Windows-1250",
  "windows-1251": "Windows-1251",
  "iso-8859-2": "ISO-8859-2",
  "koi8-r": "KOI8-R",
}

/** The status bar's name of an encoding: "UTF-8 BOM" when UTF-8 carries a mark. */
export function encodingLabel(encoding: TextFileEncoding, bom: number): string {
  const label = ENCODING_LABELS[encoding] ?? encoding
  return encoding === "utf-8" && bom > 0 ? `${label} BOM` : label
}

const LINE_ENDING_LABELS: Record<LineEnding, string> = { lf: "LF", crlf: "CRLF", cr: "CR" }

export const lineEndingLabel = (ending: LineEnding): string => LINE_ENDING_LABELS[ending] ?? "LF"

const LINE_ENDING_NAMES: Record<LineEnding, string> = {
  lf: msg("Line endings: LF (Unix, macOS)"),
  crlf: msg("Line endings: CRLF (Windows)"),
  cr: msg("Line endings: CR (classic Mac)"),
}

/** The tooltip of the line ending label. */
export const lineEndingName = (ending: LineEnding): string => t(LINE_ENDING_NAMES[ending] ?? "")
