import type { Tree } from "@lezer/common"
import { classHighlighter, highlightCode } from "@lezer/highlight"
import { escapeHtml } from "../markdown/html"

// A text file's source for the PDF (C10.8): one row per line, its number in a
// narrow gutter and its code coloured by the language the editor loaded. The
// tok-* classes (classHighlighter) are coloured by the print stylesheet in
// fixed light colours, whatever the window's theme. Everything is escaped.
// Pure: no DOM.

const row = (line: number, code: string): string =>
  `<div class="pl"><span class="pn">${line}</span><span class="pc">${code}</span></div>`

/**
 * The rows of the lines that start in [from, to) (positions at line starts;
 * `firstLine` is the number of the line at `from`). Without a tree the text
 * is plain.
 */
export function codeRows(
  text: string,
  tree: Tree | null,
  from: number,
  to: number,
  firstLine: number,
): string {
  let out = ""
  let line = firstLine
  let current = ""
  // The range ends before the last line break, so a trailing newline adds no empty row of its own.
  const end = to > from && text.charCodeAt(to - 1) === 10 ? to - 1 : to
  if (!tree) {
    for (const part of text.slice(from, end).split("\n")) out += row(line++, escapeHtml(part))
    return out
  }
  highlightCode(
    text,
    tree,
    classHighlighter,
    (code, classes) => {
      const safe = escapeHtml(code)
      current += classes ? `<span class="${classes}">${safe}</span>` : safe
    },
    () => {
      out += row(line++, current)
      current = ""
    },
    from,
    end,
  )
  return out + row(line, current)
}

/** Positions of line starts, every `step` lines: the slices a long file is rendered in. */
export function lineSlices(
  text: string,
  step: number,
): { from: number; to: number; line: number }[] {
  const slices: { from: number; to: number; line: number }[] = []
  let from = 0
  let line = 1
  while (from < text.length || slices.length === 0) {
    let to = from
    let n = 0
    while (n < step && to < text.length) {
      const nl = text.indexOf("\n", to)
      to = nl < 0 ? text.length : nl + 1
      n++
    }
    slices.push({ from, to, line })
    line += n
    if (to >= text.length) break
    from = to
  }
  return slices
}
