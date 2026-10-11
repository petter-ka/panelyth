import { useVirtualizer } from "@tanstack/react-virtual"
import { memo, useEffect, useRef } from "react"
import type { PDFDocumentProxy } from "./pdfjs"

const THUMB_WIDTH = 120
const GAP = 28

const Thumb = memo(function Thumb({
  doc,
  pageNumber,
}: {
  doc: PDFDocumentProxy
  pageNumber: number
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let cancelled = false
    let task: { cancel(): void; promise: Promise<unknown> } | null = null
    void (async () => {
      const page = await doc.getPage(pageNumber)
      if (cancelled || !canvas.current) return
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width })
      const el = canvas.current
      const ratio = window.devicePixelRatio || 1
      el.width = Math.floor(viewport.width * ratio)
      el.height = Math.floor(viewport.height * ratio)
      el.style.width = `${Math.floor(viewport.width)}px`
      el.style.height = `${Math.floor(viewport.height)}px`
      task = page.render({
        canvas: el,
        viewport,
        ...(ratio !== 1 ? { transform: [ratio, 0, 0, ratio, 0, 0] } : {}),
      })
      await task.promise.catch(() => undefined)
      page.cleanup()
    })().catch(() => undefined)
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [doc, pageNumber])
  return <canvas ref={canvas} className="block bg-white shadow shadow-black/30" />
})

interface PdfThumbsProps {
  doc: PDFDocumentProxy
  /** The thumbnail height from the first page, for a stable scroll size. */
  aspect: number
  current: number
  onSelect(page: number): void
}

/** The page strip: virtualized, one small canvas per visible page. */
export function PdfThumbs({ doc, aspect, current, onSelect }: PdfThumbsProps) {
  const box = useRef<HTMLDivElement>(null)
  const height = Math.round(THUMB_WIDTH * aspect) + GAP
  const virtualizer = useVirtualizer({
    count: doc.numPages,
    getScrollElement: () => box.current,
    estimateSize: () => height,
    overscan: 3,
  })
  useEffect(() => {
    virtualizer.scrollToIndex(current - 1, { align: "auto" })
  }, [current, virtualizer])

  return (
    <div
      ref={box}
      className="h-full w-40 shrink-0 overflow-y-auto border-r border-border bg-chrome"
      aria-label="Pages"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((row) => {
          const page = row.index + 1
          return (
            <button
              key={row.key}
              type="button"
              aria-label={`Page ${page}`}
              aria-current={page === current || undefined}
              onClick={() => onSelect(page)}
              className="absolute left-0 flex w-full flex-col items-center gap-1 pt-2 text-[0.6875rem] text-muted"
              style={{ transform: `translateY(${row.start}px)`, height: row.size }}
            >
              <span className={`rounded p-0.5 ${page === current ? "bg-accent" : ""}`}>
                <Thumb doc={doc} pageNumber={page} />
              </span>
              <span className={page === current ? "text-text" : ""}>{page}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
