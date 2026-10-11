import { memo, useEffect, useRef } from "react"
import type { PDFDocumentProxy } from "./pdfjs"
import { pdfjs } from "./pdfjs"

interface PdfPageProps {
  doc: PDFDocumentProxy
  pageNumber: number
  scale: number
  rotation: number
  /** The lower-case search text; "" = none. */
  needle: string
  /** The occurrence on this page that is the current match, or -1. */
  currentNth: number
  /** The page's size at the scale and rotation shown, once known. */
  onSize(pageNumber: number, width: number, height: number): void
}

/**
 * One page: a canvas drawn at the device's pixel ratio and a transparent text
 * layer above it (selection, search marks). Mounted only near the viewport
 * (the viewer virtualizes pages), and every pending render is cancelled when
 * the page leaves or the zoom changes.
 */
export const PdfPage = memo(function PdfPage({
  doc,
  pageNumber,
  scale,
  rotation,
  needle,
  currentNth,
  onSize,
}: PdfPageProps) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  const spans = useRef<HTMLElement[]>([])
  // Search marks follow the query without redrawing the page.
  const needleRef = useRef(needle)
  const nthRef = useRef(currentNth)

  useEffect(() => {
    let cancelled = false
    let renderTask: { cancel(): void; promise: Promise<unknown> } | null = null
    void (async () => {
      const page = await doc.getPage(pageNumber)
      if (cancelled) return
      const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 })
      onSize(pageNumber, viewport.width, viewport.height)
      const el = canvas.current
      const textEl = layer.current
      if (!el || !textEl) return
      const ratio = window.devicePixelRatio || 1
      el.width = Math.floor(viewport.width * ratio)
      el.height = Math.floor(viewport.height * ratio)
      el.style.width = `${Math.floor(viewport.width)}px`
      el.style.height = `${Math.floor(viewport.height)}px`
      renderTask = page.render({
        canvas: el,
        viewport,
        ...(ratio !== 1 ? { transform: [ratio, 0, 0, ratio, 0, 0] } : {}),
      })
      try {
        await renderTask.promise
      } catch (error) {
        // A cancelled render (zoom change, page left the window) is expected.
        if (!(error instanceof pdfjs.RenderingCancelledException))
          console.error("page render failed", error)
        return
      }
      if (cancelled) return
      textEl.replaceChildren()
      // The variables pdf.js's text layer styles are computed from.
      textEl.style.setProperty("--scale-factor", String(viewport.scale))
      textEl.style.setProperty("--total-scale-factor", String(viewport.scale))
      textEl.style.setProperty("--user-unit", "1")
      const text = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container: textEl,
        viewport,
      })
      await text.render().catch(() => undefined)
      if (cancelled) return
      spans.current = text.textDivs as HTMLElement[]
      mark(spans.current, needleRef.current, nthRef.current)
    })().catch((error: unknown) => console.error("page failed", error))
    return () => {
      cancelled = true
      renderTask?.cancel()
    }
    // onSize is stable in the viewer; the page redraws only when what it shows changes.
  }, [doc, pageNumber, scale, rotation])

  useEffect(() => {
    needleRef.current = needle
    nthRef.current = currentNth
    mark(spans.current, needle, currentNth)
  }, [needle, currentNth])

  return (
    <div className="relative mx-auto bg-white shadow-md shadow-black/30" data-page={pageNumber}>
      <canvas ref={canvas} className="block" />
      <div ref={layer} className="textLayer" />
    </div>
  )
})

/**
 * Marks each occurrence inside its text run (the run's text is unchanged, so
 * its textContent stays the original) and scrolls the current one into view.
 */
function mark(spans: readonly HTMLElement[], needle: string, nth: number): void {
  let seen = 0
  let currentEl: HTMLElement | null = null
  for (const span of spans) {
    const text = span.textContent ?? ""
    const lower = text.toLowerCase()
    const starts: number[] = []
    if (needle !== "") {
      for (
        let at = lower.indexOf(needle);
        at >= 0;
        at = lower.indexOf(needle, at + needle.length)
      ) {
        starts.push(at)
      }
    }
    const marked = span.querySelector("mark") !== null
    if (starts.length === 0) {
      if (marked) span.replaceChildren(text)
      seen += 0
      continue
    }
    const parts: (string | HTMLElement)[] = []
    let at = 0
    starts.forEach((start, k) => {
      if (start > at) parts.push(text.slice(at, start))
      const el = document.createElement("mark")
      el.className = seen + k === nth ? "hit current" : "hit"
      el.textContent = text.slice(start, start + needle.length)
      if (seen + k === nth) currentEl = el
      parts.push(el)
      at = start + needle.length
    })
    if (at < text.length) parts.push(text.slice(at))
    span.replaceChildren(...parts)
    seen += starts.length
  }
  ;(currentEl as HTMLElement | null)?.scrollIntoView({ block: "center", inline: "nearest" })
}
