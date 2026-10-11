import { useEffect, useRef, useState } from "react"
import type { PDFDocumentProxy } from "./pdfjs"

export const countOccurrences = (text: string, needle: string): number => {
  if (needle === "") return 0
  let n = 0
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) n++
  return n
}

export interface SearchState {
  /** Occurrences per page (index = page - 1); pages not yet scanned are 0. */
  perPage: number[]
  total: number
  scanned: number
  done: boolean
}

const EMPTY: SearchState = { perPage: [], total: 0, scanned: 0, done: true }

/**
 * Scans the document's text page by page (one at a time, cancellable) and
 * counts case-insensitive occurrences. Results grow while it runs, so the
 * first matches are usable at once on a large file.
 */
export function usePdfSearch(doc: PDFDocumentProxy | null, query: string): SearchState {
  const [state, setState] = useState<SearchState>(EMPTY)
  const cache = useRef(new WeakMap<PDFDocumentProxy, Map<number, string>>())

  useEffect(() => {
    const needle = query.trim().toLowerCase()
    if (!doc || needle === "") {
      setState(EMPTY)
      return
    }
    let cancelled = false
    const perPage: number[] = new Array<number>(doc.numPages).fill(0)
    setState({ perPage, total: 0, scanned: 0, done: false })
    const texts = cache.current.get(doc) ?? new Map<number, string>()
    cache.current.set(doc, texts)
    void (async () => {
      let total = 0
      for (let n = 1; n <= doc.numPages && !cancelled; n++) {
        let text = texts.get(n)
        if (text === undefined) {
          const page = await doc.getPage(n)
          const content = await page.getTextContent()
          text = content.items
            .map((i) => ("str" in i ? i.str : ""))
            .join("\n")
            .toLowerCase()
          texts.set(n, text)
          page.cleanup()
        }
        // Per run, as the text layer draws them: a match never spans two runs.
        const count = countOccurrences(text, needle)
        perPage[n - 1] = count
        total += count
        if (n % 8 === 0 || n === doc.numPages) {
          if (!cancelled)
            setState({ perPage: [...perPage], total, scanned: n, done: n === doc.numPages })
        }
      }
    })().catch(() => {
      if (!cancelled) setState((s) => ({ ...s, done: true }))
    })
    return () => {
      cancelled = true
    }
  }, [doc, query])

  return state
}

/** Global match index -> the page (1-based) and which occurrence on it. */
export function locateMatch(
  perPage: readonly number[],
  index: number,
): { page: number; nth: number } | null {
  let left = index
  for (let i = 0; i < perPage.length; i++) {
    const count = perPage[i]!
    if (left < count) return { page: i + 1, nth: left }
    left -= count
  }
  return null
}
