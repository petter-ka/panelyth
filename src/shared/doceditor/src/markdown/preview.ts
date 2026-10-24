import type { Text } from "@codemirror/state"
import type { Parser, Tree } from "@lezer/common"
import { imageLinks, renderBlocks, type HtmlBlock } from "./html"
import type { ImageResolver } from "./images"
import { idle, parseInSlices } from "./parse"
import { sanitize } from "./sanitize"

export { sanitize }

// The preview (ADR-0046, C10.7): the rendered page, read-only. Built only when
// shown (never on the keystroke path): the document is parsed with the
// editor's own Markdown parser in time slices, its pictures resolved in
// batches, then the HTML (markdown/html.ts) is cleaned by DOMPurify and put
// into sections, the one with the visible line first, the rest in idle time.

export interface PreviewOptions {
  resolver: ImageResolver
  /** A click on a link: its target is shown, not opened. */
  onLink(url: string): void
  /** Gives the next slice its turn (idle callback in the window; a microtask in tests). */
  yieldTo?: (next: () => void) => void
  sliceMs?: number
  now?: () => number
}

/** The blocks of one section: a few dozen top-level blocks. */
const SECTION_BLOCKS = 40

export interface Preview {
  readonly element: HTMLElement
  /** Renders the document (or reuses the last render of the same text), showing `line` at the top. */
  show(doc: Text, parser: Parser, line: number): Promise<void>
  /** The source line of the first block in view (for the way back to the editor). */
  topLine(): number
  destroy(): void
}

export function createPreview(options: PreviewOptions): Preview {
  const yieldTo = options.yieldTo ?? idle
  const sliceMs = options.sliceMs ?? 8
  const now = options.now ?? (() => performance.now())
  const element = document.createElement("div")
  element.className = "md-preview-scroll"
  element.tabIndex = 0
  element.dataset.testid = "preview"
  element.setAttribute("role", "document")
  const page = document.createElement("article")
  page.className = "md-preview"
  element.appendChild(page)
  let renderedDoc: Text | null = null
  let run = 0

  // Links are shown, never followed (the window must not navigate).
  element.addEventListener("click", (e) => {
    const link = e.target instanceof Element ? e.target.closest("a") : null
    if (!link) return
    e.preventDefault()
    const href = link.getAttribute("href")
    if (href) options.onLink(href)
  })
  // A middle click would open a link in a new window.
  element.addEventListener("auxclick", (e) => {
    if (e.target instanceof Element && e.target.closest("a")) e.preventDefault()
  })

  const pause = (): Promise<void> => new Promise((resolve) => yieldTo(resolve))

  /** The editor's parser over the whole text, a few milliseconds at a time. */
  const parse = (text: string, parser: Parser, mine: number): Promise<Tree | null> =>
    parseInSlices(text, parser, { sliceMs, yieldTo, now, cancelled: () => mine !== run })

  function scrollToLine(line: number): void {
    let target: HTMLElement | null = null
    for (const el of page.querySelectorAll<HTMLElement>("[data-line]")) {
      if (Number(el.dataset.line) > line) break
      target = el
    }
    // The scroller is position: relative (styles.css), so offsetTop is measured from it.
    element.scrollTop = target ? Math.max(0, target.offsetTop - 12) : 0
  }

  return {
    element,
    async show(doc, parser, line) {
      const mine = ++run
      if (renderedDoc === doc) {
        scrollToLine(line)
        return
      }
      renderedDoc = null
      page.replaceChildren()
      page.setAttribute("aria-busy", "true")
      const text = doc.toString()
      const tree = await parse(text, parser, mine)
      if (!tree || mine !== run) return
      await options.resolver.resolveAll(imageLinks(text, tree))
      if (mine !== run) return
      const blocks = renderBlocks(text, tree, {
        imageSrc: (link) => options.resolver.get(link) ?? null,
      })
      const sections: { el: HTMLElement; blocks: HtmlBlock[] }[] = []
      for (let i = 0; i < blocks.length; i += SECTION_BLOCKS) {
        const el = document.createElement("section")
        el.className = "md-section md-section-pending"
        const part = blocks.slice(i, i + SECTION_BLOCKS)
        // A height to scroll by until the section is filled.
        el.style.minHeight = `${part.length * 2.2}em`
        sections.push({ el, blocks: part })
        page.appendChild(el)
      }
      const fill = (index: number): void => {
        const section = sections[index]
        if (!section || !section.el.classList.contains("md-section-pending")) return
        section.el.innerHTML = sanitize(section.blocks.map((b) => b.html).join("\n"))
        section.el.classList.remove("md-section-pending")
        section.el.style.minHeight = ""
      }
      // The section with the line first, then outwards; the browser keeps the view anchored.
      let first = sections.findIndex((s) => (s.blocks.at(-1)?.line ?? 0) >= line)
      if (first < 0) first = Math.max(0, sections.length - 1)
      fill(first)
      fill(first + 1)
      scrollToLine(line)
      renderedDoc = doc
      page.removeAttribute("aria-busy")
      const order: number[] = []
      for (let d = 1; d < sections.length; d++) {
        if (first + d + 1 < sections.length) order.push(first + d + 1)
        if (first - d >= 0) order.push(first - d)
      }
      let next = 0
      while (next < order.length) {
        await pause()
        if (mine !== run) return
        const deadline = now() + sliceMs
        while (next < order.length && now() < deadline) fill(order[next++]!)
      }
    },
    topLine() {
      const top = element.scrollTop
      let line = 1
      for (const el of page.querySelectorAll<HTMLElement>("[data-line]")) {
        if (el.offsetTop + el.offsetHeight > top) return Number(el.dataset.line) || line
        line = Number(el.dataset.line) || line
      }
      return line
    },
    destroy() {
      run++
    },
  }
}
