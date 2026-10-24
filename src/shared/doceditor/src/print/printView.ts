import type { Parser } from "@lezer/common"
import { htmlBlocks, imageLinks } from "../markdown/html"
import type { ImageResolver } from "../markdown/images"
import { parseInSlices, slicer, type SliceOptions } from "../markdown/parse"
import { sanitize } from "../markdown/sanitize"
import { codeRows, lineSlices } from "./code"

// The print view of the PDF export (C10.8): built into a container that is
// shown only under @media print (styles.css), in slices so typing goes on
// meanwhile. Markdown is Preview's rendering (markdown/html.ts, cleaned by the
// same DOMPurify rules) with every picture resolved and loaded; any other
// text is its source with line numbers and syntax colours.

export interface PrintSource {
  text: string
  markdown: boolean
  /** The editor's parser for the file's language; null for plain text. */
  parser: Parser | null
  /** Markdown's picture resolver (batches of 200, cached). */
  resolver: ImageResolver | null
}

export interface BuildOptions extends SliceOptions {
  /** How long the pictures may take to load or fail (ms). */
  imageTimeoutMs?: number
}

/** Blocks per section: one sanitize call each. */
const SECTION_BLOCKS = 40
/** Source lines per slice of a text file. */
const CODE_LINES = 1500

/**
 * Waits until every picture in the container has loaded or failed, or the
 * time is up: a broken picture never hangs the export.
 */
export function waitForImages(container: HTMLElement, timeoutMs: number): Promise<void> {
  const pending = [...container.querySelectorAll("img")].filter((img) => !img.complete)
  if (pending.length === 0) return Promise.resolve()
  return new Promise((resolve) => {
    let left = pending.length
    const timer = setTimeout(resolve, timeoutMs)
    const done = (): void => {
      if (--left === 0) {
        clearTimeout(timer)
        resolve()
      }
    }
    for (const img of pending) {
      img.addEventListener("load", done, { once: true })
      img.addEventListener("error", done, { once: true })
    }
  })
}

/** Fills the container with the print view; false when cancelled meanwhile. */
export async function buildPrintView(
  container: HTMLElement,
  source: PrintSource,
  options: BuildOptions = {},
): Promise<boolean> {
  const cancelled = options.cancelled ?? (() => false)
  const slices = slicer(options)
  const { text } = source

  if (source.markdown && source.parser) {
    const tree = await parseInSlices(text, source.parser, options)
    if (!tree || cancelled()) return false
    // Every picture's token first, so the <img> elements carry them.
    if (source.resolver) await source.resolver.resolveAll(imageLinks(text, tree))
    if (cancelled()) return false
    const article = document.createElement("article")
    article.className = "print-doc print-md"
    container.appendChild(article)
    const resolver = source.resolver
    const blocks = htmlBlocks(text, tree, {
      imageSrc: (link) => resolver?.get(link) ?? null,
    })
    let section: string[] = []
    const flush = (): void => {
      if (section.length === 0) return
      const el = document.createElement("section")
      el.innerHTML = sanitize(section.join("\n"))
      article.appendChild(el)
      section = []
    }
    for (const block of blocks) {
      section.push(block.html)
      if (section.length >= SECTION_BLOCKS) flush()
      if (slices.due() && !(await slices.pause())) return false
    }
    flush()
    await waitForImages(article, options.imageTimeoutMs ?? 10_000)
    return !cancelled()
  }

  // Any other text: the source, coloured by the editor's own language.
  const tree = source.parser ? await parseInSlices(text, source.parser, options) : null
  if (cancelled() || (source.parser && !tree)) return false
  const code = document.createElement("div")
  code.className = "print-doc print-code"
  const lines = text.split("\n").length
  // The gutter fits the largest line number (CSSOM: the CSP allows no style attributes).
  code.style.setProperty("--gutter", `${String(lines).length + 1}ch`)
  container.appendChild(code)
  for (const part of lineSlices(text, CODE_LINES)) {
    code.insertAdjacentHTML("beforeend", codeRows(text, tree, part.from, part.to, part.line))
    if (slices.due() && !(await slices.pause())) return false
  }
  return !cancelled()
}
