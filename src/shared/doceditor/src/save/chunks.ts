import { TEXTEDIT_CHUNK_CHARS } from "@panelyth/contracts"

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff

/**
 * The text of a save in the order it is written: pieces of at most `size`
 * UTF-16 code units. A piece never ends between the two halves of a
 * surrogate pair (an emoji), which JSON on the way to the sidecar would turn
 * into two replacement characters. An empty text is one empty piece, so a
 * save of an empty file still starts its staging buffer.
 */
export function chunkText(text: string, size: number = TEXTEDIT_CHUNK_CHARS): string[] {
  if (size < 2) throw new RangeError("chunk size must be at least 2")
  if (text.length <= size) return [text]
  const chunks: string[] = []
  let at = 0
  while (at < text.length) {
    let end = Math.min(at + size, text.length)
    if (end < text.length && isHighSurrogate(text.charCodeAt(end - 1))) end--
    chunks.push(text.slice(at, end))
    at = end
  }
  return chunks
}
