import type { Text } from "@codemirror/state"

/** What the status bar counts: of the selection when there is one, else of the document. */
export interface TextCounts {
  words: number
  /** Unicode code points, line breaks not counted. */
  characters: number
  lines: number
}

/** The part of Intl.Segmenter the count needs (null: the regex fallback). */
export interface WordSegmenter {
  segment(input: string): Iterable<{ isWordLike?: boolean }>
}

export function defaultSegmenter(): WordSegmenter | null {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter
  if (typeof Segmenter !== "function") return null
  try {
    return new Segmenter(undefined, { granularity: "word" })
  } catch {
    return null
  }
}

// Without a segmenter: each Han, Hiragana or Katakana character is a word (those
// scripts have no spaces), and a run of other letters, marks and digits is one,
// with inner apostrophes (don't, l'homme).
const CJK = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]`
const LETTER = String.raw`(?:(?!${CJK})[\p{L}\p{M}\p{N}_])`
const WORD = new RegExp(String.raw`${CJK}|${LETTER}+(?:['’]${LETTER}+)*`, "gu")

function countWords(text: string, segmenter: WordSegmenter | null): number {
  let words = 0
  if (segmenter) {
    for (const s of segmenter.segment(text)) if (s.isWordLike) words++
    return words
  }
  WORD.lastIndex = 0
  while (WORD.exec(text) !== null) words++
  return words
}

/** Code points, not counting line breaks. */
function countCharacters(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 10 || c === 13) continue
    // The low half of a surrogate pair is the same character.
    if (c >= 0xdc00 && c <= 0xdfff && i > 0) {
      const prev = text.charCodeAt(i - 1)
      if (prev >= 0xd800 && prev <= 0xdbff) continue
    }
    n++
  }
  return n
}

/** The counts of one string, at once (tests, small selections). */
export function countText(text: string, segmenter = defaultSegmenter()): TextCounts {
  const lines = text === "" ? 1 : text.split(/\r\n|\r|\n/).length
  return { words: countWords(text, segmenter), characters: countCharacters(text), lines }
}

/** A range of the document to count (a selection range or the whole document). */
export interface CountRange {
  from: number
  to: number
}

export interface CountOptions {
  segmenter?: WordSegmenter | null
  /** How long one slice may run before it yields to typing and painting (ms). */
  sliceMs?: number
  /** Gives the next slice its turn; requestIdleCallback in the window, a timer in tests. */
  yieldTo?: (next: () => void) => void
  now?: () => number
  /** Stops the count: a newer edit started another. */
  cancelled?: () => boolean
}

// The text is segmented in batches of joined lines: one Segmenter call per batch.
const BATCH_CHARS = 32 * 1024

function idleYield(next: () => void): void {
  const ric = (
    globalThis as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
    }
  ).requestIdleCallback
  if (ric) ric(next, { timeout: 200 })
  else setTimeout(next, 0)
}

/**
 * Counts words, characters and lines of the ranges of an immutable document
 * in slices of a few milliseconds, so a large document never blocks a
 * keystroke. Resolves null when cancelled. The document's pieces are whole
 * lines (a range's ends aside), and a line break always separates words, so
 * counting batch by batch gives the same words as counting all at once.
 */
export function countDocument(
  doc: Text,
  ranges: readonly CountRange[],
  options: CountOptions = {},
): Promise<TextCounts | null> {
  const segmenter = options.segmenter === undefined ? defaultSegmenter() : options.segmenter
  const sliceMs = options.sliceMs ?? 6
  const yieldTo = options.yieldTo ?? idleYield
  const now = options.now ?? (() => performance.now())
  const cancelled = options.cancelled ?? (() => false)

  let lines = 0
  for (const r of ranges) lines += doc.lineAt(r.to).number - doc.lineAt(r.from).number + 1
  let words = 0
  let characters = 0
  let rangeIndex = 0
  let iter: Iterator<string> | null = null
  const batch: string[] = []
  let batchChars = 0

  const flush = (): void => {
    if (batch.length === 0) return
    const text = batch.join("\n")
    words += countWords(text, segmenter)
    characters += countCharacters(text)
    batch.length = 0
    batchChars = 0
  }

  // One slice: pieces until the time is up; true when everything is counted.
  const step = (): boolean => {
    const deadline = now() + sliceMs
    for (;;) {
      if (!iter) {
        const r = ranges[rangeIndex++]
        if (!r) {
          flush()
          return true
        }
        iter = doc.iterRange(r.from, r.to)[Symbol.iterator]()
      }
      const next = iter.next()
      if (next.done) {
        iter = null
        continue
      }
      // Line breaks come as their own pieces; the join puts them back.
      if (next.value === "\n") continue
      batch.push(next.value)
      batchChars += next.value.length
      if (batchChars >= BATCH_CHARS) {
        flush()
        if (now() >= deadline) return false
      }
    }
  }

  return new Promise((resolve) => {
    const run = (): void => {
      if (cancelled()) return resolve(null)
      if (step()) resolve({ words, characters, lines })
      else yieldTo(run)
    }
    run()
  })
}
