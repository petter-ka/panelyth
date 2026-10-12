import { useVirtualizer } from "@tanstack/react-virtual"
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import type { DocumentParams } from "../params"
import { PdfPage } from "./PdfPage"
import { PdfThumbs } from "./PdfThumbs"
import { PDFJS_DATA, pdfjs, type PDFDocumentProxy } from "./pdfjs"
import { locateMatch, usePdfSearch } from "./search"
import { t } from "@panelyth/i18n"

type Zoom = "width" | "page" | number
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const
const PAGE_GAP = 16
const PAD = 32

type Load =
  | { status: "loading"; percent: number | null }
  | { status: "password"; wrong: boolean; submit(password: string): void }
  | { status: "error"; message: string }
  | { status: "ready"; doc: PDFDocumentProxy; width: number; height: number }

function useLoadPdf(src: string): Load {
  const [state, setState] = useState<Load>({ status: "loading", percent: null })
  useEffect(() => {
    // The token is read with HTTP Range: a big file shows its first page at once.
    const task = pdfjs.getDocument({ url: src, ...PDFJS_DATA })
    let destroyed = false
    task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
      if (!destroyed)
        setState({ status: "loading", percent: total ? (loaded / total) * 100 : null })
    }
    task.onPassword = (update: (password: string) => void, reason: number) =>
      setState({
        status: "password",
        wrong: reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD,
        submit: update,
      })
    task.promise.then(
      async (doc) => {
        if (destroyed) return
        const first = await doc.getPage(1)
        const view = first.getViewport({ scale: 1 })
        if (!destroyed) setState({ status: "ready", doc, width: view.width, height: view.height })
      },
      (error: unknown) => {
        if (!destroyed)
          setState({
            status: "error",
            message:
              error instanceof Error && error.name === "InvalidPDFException"
                ? t("This is not a valid PDF file.")
                : error instanceof Error
                  ? error.message
                  : t("The PDF could not be opened."),
          })
      },
    )
    return () => {
      destroyed = true
      void task.destroy()
    }
  }, [src])
  return state
}

export default function PdfViewer({ params }: { params: DocumentParams }) {
  const load = useLoadPdf(params.src)
  if (load.status === "loading") {
    return (
      <p className="p-6 text-sm text-muted">
        {t("Opening…")}
        {load.percent !== null ? ` ${Math.round(load.percent)}%` : ""}
      </p>
    )
  }
  if (load.status === "error") {
    return (
      <p role="alert" className="p-6 text-sm text-danger">
        {load.message}
      </p>
    )
  }
  if (load.status === "password") return <PasswordForm name={params.name} {...load} />
  return <Reader params={params} doc={load.doc} pageWidth={load.width} pageHeight={load.height} />
}

function PasswordForm({
  name,
  wrong,
  submit,
}: {
  name: string
  wrong: boolean
  submit(password: string): void
}) {
  const [value, setValue] = useState("")
  return (
    <form
      className="mx-auto mt-24 flex w-80 flex-col gap-3 rounded-md border border-border bg-raised p-4 text-sm"
      onSubmit={(e) => {
        e.preventDefault()
        submit(value)
      }}
    >
      <p className="truncate font-medium">{name}</p>
      <label className="flex flex-col gap-1 text-xs text-muted">
        {wrong ? t("Wrong password. Try again.") : t("This PDF is protected. Enter its password.")}
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-8 px-2 text-sm rounded-md border border-muted/70 bg-canvas text-text outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        />
      </label>
      <button type="submit" className="h-8 rounded bg-accent text-accent-foreground">
        {t("Open")}
      </button>
    </form>
  )
}

interface ReaderProps {
  params: DocumentParams
  doc: PDFDocumentProxy
  /** The first page at scale 1: the estimate for every page until it is drawn. */
  pageWidth: number
  pageHeight: number
}

function Reader({ params, doc, pageWidth, pageHeight }: ReaderProps) {
  const box = useRef<HTMLDivElement>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const [zoom, setZoom] = useState<Zoom>("width")
  const [rotation, setRotation] = useState(0)
  const [sidebar, setSidebar] = useState(false)
  const [night, setNight] = useState(false)
  const [viewport, setViewport] = useState({ width: 800, height: 600 })
  const [current, setCurrent] = useState(1)
  const [pageInput, setPageInput] = useState("1")
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [matchIndex, setMatchIndex] = useState(0)
  // Real sizes of drawn pages at the current scale (css px).
  const sizes = useRef(new Map<number, number>())

  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = (): void => setViewport({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Keys (Ctrl+F, arrows, PageDown) work at once, without a click first.
  useEffect(() => box.current?.focus(), [])

  const turned = rotation % 180 !== 0
  const baseW = turned ? pageHeight : pageWidth
  const baseH = turned ? pageWidth : pageHeight
  const fitWidth = Math.max(0.1, (viewport.width - PAD) / baseW)
  const fitPage = Math.max(0.1, Math.min(fitWidth, (viewport.height - PAD) / baseH))
  const scale = zoom === "width" ? fitWidth : zoom === "page" ? fitPage : zoom

  const virtualizer = useVirtualizer({
    count: doc.numPages,
    getScrollElement: () => box.current,
    estimateSize: (i) => (sizes.current.get(i + 1) ?? baseH * scale) + PAGE_GAP,
    overscan: 1,
  })

  // A new scale or rotation invalidates every measured size; keep the page in view.
  const keep = useRef(1)
  keep.current = current
  useEffect(() => {
    sizes.current.clear()
    virtualizer.measure()
    virtualizer.scrollToIndex(keep.current - 1, { align: "start" })
  }, [scale, rotation, virtualizer])

  const onSize = useCallback((page: number, _w: number, h: number) => {
    if (sizes.current.get(page) !== h) sizes.current.set(page, h)
  }, [])

  const items = virtualizer.getVirtualItems()
  const offset = virtualizer.scrollOffset ?? 0
  useEffect(() => {
    // The page holding the upper third of the viewport.
    const probe = offset + viewport.height / 3
    const row = items.find((i) => i.end > probe) ?? items.at(-1)
    if (row) {
      setCurrent(row.index + 1)
      setPageInput(String(row.index + 1))
    }
  }, [offset, items, viewport.height])

  const goTo = (page: number): void => {
    const n = Math.min(doc.numPages, Math.max(1, Math.round(page)))
    virtualizer.scrollToIndex(n - 1, { align: "start" })
  }

  const needle = query.trim().toLowerCase()
  const search = usePdfSearch(doc, query)
  const located = useMemo(
    () =>
      search.total > 0 ? locateMatch(search.perPage, Math.min(matchIndex, search.total - 1)) : null,
    [search.perPage, search.total, matchIndex],
  )
  useEffect(() => setMatchIndex(0), [query])
  useEffect(() => {
    if (located) goTo(located.page)
    // goTo is stable for a document; this runs when the located match changes.
  }, [located?.page, located?.nth])

  const stepMatch = (direction: 1 | -1): void => {
    if (search.total === 0) return
    setMatchIndex((i) => (i + direction + search.total) % search.total)
  }

  const zoomBy = (direction: 1 | -1): void => {
    const now = scale
    const next =
      direction === 1
        ? (ZOOM_STEPS.find((z) => z > now + 0.001) ?? ZOOM_STEPS.at(-1)!)
        : ([...ZOOM_STEPS].reverse().find((z) => z < now - 0.001) ?? ZOOM_STEPS[0])
    setZoom(next)
  }

  const openFind = (): void => {
    setFindOpen(true)
    queueMicrotask(() => {
      findInput.current?.focus()
      findInput.current?.select()
    })
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey
    const typing = (e.target as HTMLElement).tagName === "INPUT"
    if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault()
      openFind()
    } else if (e.key === "F3") {
      e.preventDefault()
      stepMatch(e.shiftKey ? -1 : 1)
    } else if (mod && (e.key === "+" || e.key === "=")) {
      e.preventDefault()
      zoomBy(1)
    } else if (mod && e.key === "-") {
      e.preventDefault()
      zoomBy(-1)
    } else if (mod && e.key === "0") {
      e.preventDefault()
      setZoom("width")
    } else if (e.key === "Escape" && findOpen) {
      setFindOpen(false)
      box.current?.focus()
    } else if (!typing && e.key === "Home") {
      e.preventDefault()
      goTo(1)
    } else if (!typing && e.key === "End") {
      e.preventDefault()
      goTo(doc.numPages)
    }
  }

  const zoomValue = zoom === "width" || zoom === "page" ? zoom : String(zoom)
  const percent = Math.round(scale * 100)

  return (
    <div className="flex h-full flex-col bg-canvas text-text" onKeyDown={onKeyDown}>
      <header className="flex h-11 shrink-0 items-center gap-1 border-b border-border bg-chrome px-2 text-xs">
        <Button label={t("Pages")} pressed={sidebar} onClick={() => setSidebar((v) => !v)}>
          ☰
        </Button>
        <h1
          className="mx-2 min-w-0 max-w-[30%] shrink truncate text-sm font-medium"
          title={params.name}
        >
          {params.name}
        </h1>
        <div className="flex-1" />
        <Button
          label={t("Previous page")}
          onClick={() => goTo(current - 1)}
          disabled={current <= 1}
        >
          ↑
        </Button>
        <input
          aria-label={t("Page number")}
          value={pageInput}
          inputMode="numeric"
          onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === "Enter") goTo(Number(pageInput) || 1)
          }}
          onBlur={() => setPageInput(String(current))}
          className="h-7 w-12 px-1 text-center tabular-nums rounded-md border border-muted/70 bg-canvas text-text outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        />
        <span className="text-muted tabular-nums">/ {doc.numPages}</span>
        <Button
          label={t("Next page")}
          onClick={() => goTo(current + 1)}
          disabled={current >= doc.numPages}
        >
          ↓
        </Button>
        <div className="mx-2 h-5 w-px bg-border" />
        <Button label={t("Zoom out (Ctrl+-)")} onClick={() => zoomBy(-1)}>
          −
        </Button>
        <select
          aria-label={t("Zoom")}
          value={zoomValue}
          onChange={(e) => {
            const v = e.target.value
            setZoom(v === "width" || v === "page" ? v : Number(v))
          }}
          className="h-7 px-1 rounded-md border border-muted/70 bg-canvas text-text outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        >
          <option value="width">{t("Fit width ({percent}%)", { percent })}</option>
          <option value="page">{t("Fit page")}</option>
          {ZOOM_STEPS.map((z) => (
            <option key={z} value={z}>
              {Math.round(z * 100)}%
            </option>
          ))}
          {typeof zoom === "number" && !ZOOM_STEPS.some((z) => z === zoom) && (
            <option value={zoom}>{percent}%</option>
          )}
        </select>
        <Button label={t("Zoom in (Ctrl++)")} onClick={() => zoomBy(1)}>
          +
        </Button>
        <div className="mx-2 h-5 w-px bg-border" />
        <Button label={t("Rotate")} onClick={() => setRotation((r) => (r + 90) % 360)}>
          ⟳
        </Button>
        <Button
          label={t("Night mode (invert pages)")}
          pressed={night}
          onClick={() => setNight((v) => !v)}
        >
          ☾
        </Button>
        <Button label={t("Find (Ctrl+F)")} pressed={findOpen} onClick={openFind}>
          {t("Find")}
        </Button>
      </header>

      {findOpen && (
        <div
          role="search"
          className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-raised px-3 text-xs"
        >
          <input
            ref={findInput}
            aria-label={t("Find in document")}
            value={query}
            placeholder={t("Find")}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === "Enter") {
                e.preventDefault()
                stepMatch(e.shiftKey ? -1 : 1)
              } else if (e.key === "Escape") {
                setFindOpen(false)
                box.current?.focus()
              }
            }}
            className="h-7 w-64 px-2 rounded-md border border-muted/70 bg-canvas text-text outline-none focus:border-accent focus:ring-1 focus:ring-accent"
          />
          <span aria-live="polite" className="w-40 text-muted tabular-nums">
            {needle === ""
              ? ""
              : search.total === 0
                ? search.done
                  ? t("No matches")
                  : t("Searching… {scanned}/{pages}", {
                      scanned: search.scanned,
                      pages: doc.numPages,
                    })
                : t("{current} of {total}", {
                    current: Math.min(matchIndex, search.total - 1) + 1,
                    total: `${search.total}${search.done ? "" : "+"}`,
                  })}
          </span>
          <Button
            label={t("Previous match (Shift+Enter)")}
            onClick={() => stepMatch(-1)}
            disabled={search.total === 0}
          >
            ↑
          </Button>
          <Button
            label={t("Next match (Enter)")}
            onClick={() => stepMatch(1)}
            disabled={search.total === 0}
          >
            ↓
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {sidebar && (
          <PdfThumbs doc={doc} aspect={pageHeight / pageWidth} current={current} onSelect={goTo} />
        )}
        <div
          ref={box}
          tabIndex={0}
          role="document"
          aria-label={params.name}
          data-testid="pdf-body"
          className={`min-w-0 flex-1 overflow-auto outline-none ${night ? "pdf-night" : ""}`}
        >
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
              minWidth: "fit-content",
            }}
          >
            {items.map((row) => {
              const page = row.index + 1
              return (
                <div
                  key={row.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className="absolute left-0 flex w-full justify-center"
                  style={{
                    top: 0,
                    transform: `translateY(${row.start}px)`,
                    paddingTop: PAGE_GAP / 2,
                    paddingBottom: PAGE_GAP / 2,
                  }}
                >
                  <PdfPage
                    doc={doc}
                    pageNumber={page}
                    scale={scale}
                    rotation={rotation}
                    needle={needle}
                    currentNth={located?.page === page ? located.nth : -1}
                    onSize={onSize}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function Button({
  label,
  onClick,
  children,
  pressed,
  disabled,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
  pressed?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`h-7 min-w-7 rounded px-2 hover:bg-raised disabled:opacity-40 ${pressed ? "bg-accent/20 text-accent" : ""}`}
    >
      {children}
    </button>
  )
}
