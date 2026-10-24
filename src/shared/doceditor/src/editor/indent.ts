/** How the file indents: a tab, or a number of spaces. */
export interface IndentStyle {
  /** The text one indentation level inserts: "\t" or N spaces. */
  unit: string
  /** The width a tab is drawn with. */
  tabSize: number
}

// Files whose convention is a tab or two spaces when they have no indented line yet.
const TAB_FILES = /(^|[\\/])(makefile|gnumakefile)$|\.(go|mk)$/i
const TWO_SPACE_FILES =
  /\.(json|jsonc|json5|ya?ml|md|markdown|mkd|js|mjs|cjs|jsx|ts|mts|cts|tsx|css|scss|less|html?|xml|svg|vue|toml|rb|lua|dart)$/i

/** The convention for a file with nothing indented in its first lines. */
export function defaultIndent(name: string): IndentStyle {
  if (TAB_FILES.test(name)) return { unit: "\t", tabSize: 4 }
  if (TWO_SPACE_FILES.test(name)) return { unit: "  ", tabSize: 2 }
  return { unit: "    ", tabSize: 4 }
}

const SAMPLE_LINES = 400
const SAMPLE_CHARS = 64 * 1024

/**
 * The file's own indentation, read from its first lines: tabs when more lines
 * start with a tab than with spaces; else the most common step between the
 * space indents of consecutive lines (a tie goes to the smaller step). The
 * one-space step before the "*" of a block comment is not counted. Null when
 * nothing is indented.
 */
export function detectIndent(text: string): IndentStyle | null {
  let tabs = 0
  let spaces = 0
  let previous = 0
  const steps = new Map<number, number>()
  const limit = Math.min(text.length, SAMPLE_CHARS)
  let start = 0
  for (let n = 0; n < SAMPLE_LINES && start < limit; n++) {
    let end = text.indexOf("\n", start)
    if (end < 0) end = text.length
    const line = text.slice(start, end).replace(/\r$/, "")
    start = end + 1
    if (line.trim() === "") continue
    if (line.charCodeAt(0) === 9) {
      tabs++
      continue
    }
    let width = 0
    while (line.charCodeAt(width) === 32) width++
    if (width > 0) spaces++
    if (line.charCodeAt(width) === 42) continue // " * " inside /** */
    const step = Math.abs(width - previous)
    if (step >= 2 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1)
    previous = width
  }
  if (tabs === 0 && spaces === 0) return null
  if (tabs > spaces) return { unit: "\t", tabSize: 4 }
  let best = 0
  let bestCount = 0
  for (const [step, count] of steps) {
    if (count > bestCount || (count === bestCount && step < best)) {
      best = step
      bestCount = count
    }
  }
  if (best === 0) return null
  return { unit: " ".repeat(best), tabSize: best }
}
