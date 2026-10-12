import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react"
import type { ByteSource } from "../features/bytes"
import {
  backLines,
  decode,
  lineStartFrom,
  linesAt,
  previousLineStart,
  type Encoding,
} from "../features/text"
import { t } from "@panelyth/i18n"
import { createWheelStepper } from "@panelyth/ui"

// Text and hex views over byte windows (Stage C05): only the visible rows
// are read and rendered. The scroll position is a byte offset (text) or a
// row (hex), mapped onto a custom scroll bar, so a multi-GB file scrolls
// with the memory of one screen.

export const LINE_PX = 18
/** Rows assumed before layout (jsdom, the first frame). */
const FALLBACK_ROWS = 30
export const HEX_BYTES_PER_ROW = 16

/** A find match, as absolute byte offsets [start, end). */
export interface ByteMatch {
  start: number
  end: number
}

function useRows(ref: RefObject<HTMLElement | null>): number {
  const [rows, setRows] = useState(FALLBACK_ROWS)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const h = el.getBoundingClientRect().height
      setRows(h > 0 ? Math.max(1, Math.floor(h / LINE_PX)) : FALLBACK_ROWS)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return rows
}

/** Wheel steps in rows (non-passive, so the page never scrolls). */
function useWheelRows(ref: RefObject<HTMLElement | null>, onRows: (rows: number) => void): void {
  const handler = useRef(onRows)
  useEffect(() => {
    handler.current = onRows
  })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Rows follow the distance the wheel travelled: a trackpad's stream of
    // small events moves a row per row height, not a row per event.
    const rowStep = createWheelStepper({ stepPx: LINE_PX, maxSteps: 20, linePx: LINE_PX })
    const onWheel = (e: WheelEvent): void => {
      if (e.deltaY === 0) return
      e.preventDefault()
      const rows = rowStep(e)
      if (rows !== 0) handler.current(rows)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [ref])
}

/** Runs async moves one after another (held keys never race each other). */
function useSerial(): (task: () => Promise<void>) => void {
  const chain = useRef<Promise<void>>(Promise.resolve())
  return useCallback((task) => {
    chain.current = chain.current.then(task).catch(() => undefined)
  }, [])
}

interface ScrollbarProps {
  /** 0..1 */
  fraction: number
  onJump: (fraction: number) => void
  label: string
}

/** The position in the file; click or drag to jump. */
function ByteScrollbar({ fraction, onJump, label }: ScrollbarProps) {
  const track = useRef<HTMLDivElement>(null)
  const frame = useRef(0)
  const jumpTo = (clientY: number): void => {
    const r = track.current?.getBoundingClientRect()
    if (!r || r.height <= 0) return
    const f = Math.min(1, Math.max(0, (clientY - r.top) / r.height))
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => onJump(f))
  }
  const percent = Math.round(fraction * 100)
  return (
    <div
      ref={track}
      role="scrollbar"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      data-testid="byte-scrollbar"
      className="relative w-3 shrink-0 cursor-default border-l border-border bg-chrome"
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        jumpTo(e.clientY)
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) jumpTo(e.clientY)
      }}
    >
      <div
        className="absolute inset-x-0.5 h-8 rounded-sm bg-border"
        style={{ top: `calc(${fraction} * (100% - 2rem))` }}
      />
    </div>
  )
}

export interface ByteViewHandle {
  focus(): void
}

interface TextViewProps {
  source: ByteSource
  encoding: Encoding
  /** The text starts after the byte order mark. */
  floor: number
  wrap: boolean
  match: ByteMatch | null
  label: string
  /** Where the view is: its first byte and the file position 0..1. */
  onPosition?: (top: number, fraction: number) => void
  testId?: string
}

interface ShownLine {
  start: number
  text: string
  /** The match inside this line, as characters [from, to). */
  mark: [number, number] | null
}

/** Render with key={source.url + encoding}: each file and encoding starts fresh. */
export const TextView = forwardRef<ByteViewHandle, TextViewProps>(function TextView(
  { source, encoding, floor, wrap, match, label, onPosition, testId = "text-view" },
  ref,
) {
  const box = useRef<HTMLDivElement>(null)
  const rows = useRows(box)
  const [top, setTop] = useState(floor)
  const topRef = useRef(floor)
  const [endTop, setEndTop] = useState<number | null>(null)
  const [shown, setShown] = useState<ShownLine[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const serial = useSerial()
  useImperativeHandle(ref, () => ({ focus: () => box.current?.focus() }), [])

  const go = (next: number): void => {
    topRef.current = next
    setTop(next)
  }

  // The last screen's first line: the view never scrolls past the end.
  useEffect(() => {
    let live = true
    void (async () => {
      const last = await previousLineStart(source, source.size, encoding, floor)
      const end = await backLines(source, last, rows - 1, encoding, floor)
      if (live) setEndTop(end)
    })().catch(() => undefined)
    return () => {
      live = false
    }
  }, [source, encoding, floor, rows])

  // The rows on screen: one window read, decoded per line.
  useEffect(() => {
    let live = true
    void (async () => {
      const lines = await linesAt(source, top, encoding, rows)
      const first = lines[0]?.start ?? top
      const bytes = await source.read(first, lines.at(-1)?.end ?? first)
      const out = lines.map((l): ShownLine => {
        const text = decode(bytes.subarray(l.start - first, l.end - first), encoding)
        let mark: [number, number] | null = null
        if (match && match.start < Math.max(l.end, l.start + 1) && match.end > l.start) {
          const a = Math.max(match.start, l.start)
          const b = Math.min(match.end, l.end)
          const from = decode(bytes.subarray(l.start - first, a - first), encoding).length
          mark = [from, from + decode(bytes.subarray(a - first, b - first), encoding).length]
        }
        return { start: l.start, text, mark }
      })
      if (live) {
        setShown(out)
        setFailed(null)
      }
    })().catch((error: unknown) => {
      if (live) setFailed(error instanceof Error ? error.message : String(error))
    })
    return () => {
      live = false
    }
  }, [source, encoding, top, rows, match])

  // A new match: show its line with two lines of context above.
  useEffect(() => {
    if (!match) return
    serial(async () => {
      const unit = encoding === "utf-16le" || encoding === "utf-16be" ? 2 : 1
      const after = await lineStartFrom(source, match.start + unit, encoding, floor)
      const line = await previousLineStart(source, after, encoding, floor)
      go(await backLines(source, line, 2, encoding, floor))
    })
  }, [match, source, encoding, floor, serial])

  const span = endTop === null ? 0 : endTop - floor
  const fraction = span > 0 ? Math.min(1, (top - floor) / span) : 0
  useEffect(() => onPosition?.(top, fraction), [top, fraction, onPosition])

  const down = (n: number): void =>
    serial(async () => {
      const limit = endTop ?? topRef.current
      if (topRef.current >= limit) return
      const lines = await linesAt(source, topRef.current, encoding, n + 1)
      const target = lines.length > n ? lines[n]!.start : limit
      go(Math.min(target, limit))
    })
  const up = (n: number): void =>
    serial(async () => go(await backLines(source, topRef.current, n, encoding, floor)))
  const jump = (f: number): void =>
    serial(async () => {
      if (endTop === null) return
      const at = await lineStartFrom(
        source,
        floor + Math.round(f * (endTop - floor)),
        encoding,
        floor,
      )
      go(Math.min(at, endTop))
    })
  useWheelRows(box, (n) => (n > 0 ? down(n) : up(-n)))

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.altKey || e.metaKey) return
    const page = Math.max(1, rows - 1)
    const keys: Record<string, () => void> = {
      ArrowDown: () => down(1),
      ArrowUp: () => up(1),
      PageDown: () => down(page),
      PageUp: () => up(page),
      Home: () => serial(async () => go(floor)),
      End: () => serial(async () => go(endTop ?? topRef.current)),
    }
    const action = keys[e.key]
    if (!action || (e.ctrlKey && e.key !== "Home" && e.key !== "End")) return
    e.preventDefault()
    e.stopPropagation()
    action()
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div
        ref={box}
        tabIndex={0}
        role="document"
        aria-label={label}
        data-testid={testId}
        data-top={top}
        data-wrap={wrap}
        onKeyDown={onKeyDown}
        className={`min-w-0 flex-1 bg-canvas px-2 font-mono text-xs leading-[18px] text-text outline-none focus-visible:ring-1 focus-visible:ring-accent ${wrap ? "overflow-hidden" : "overflow-x-auto overflow-y-hidden"}`}
        style={{ tabSize: 8 }}
      >
        {failed ? (
          <p role="alert" className="p-2 font-sans text-danger">
            This file can't be read: {failed}
          </p>
        ) : (
          shown?.map((l) => (
            <div
              key={l.start}
              data-offset={l.start}
              className={wrap ? "whitespace-pre-wrap break-all" : "h-[18px] whitespace-pre"}
            >
              {l.mark ? (
                <>
                  {l.text.slice(0, l.mark[0])}
                  <mark className="rounded-sm bg-accent text-canvas" data-testid="find-mark">
                    {l.text.slice(l.mark[0], l.mark[1])}
                  </mark>
                  {l.text.slice(l.mark[1])}
                </>
              ) : (
                l.text || "​"
              )}
            </div>
          ))
        )}
      </div>
      <ByteScrollbar fraction={fraction} onJump={jump} label={t("{label} position", { label })} />
    </div>
  )
})

interface HexViewProps {
  source: ByteSource
  match: ByteMatch | null
  label: string
  onPosition?: (top: number, fraction: number) => void
  testId?: string
}

const hex2 = (b: number): string => b.toString(16).padStart(2, "0")
const printable = (b: number): string => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")

/** Offset, 16 bytes in two groups of 8, and their ASCII; render with key={source.url}. */
export const HexView = forwardRef<ByteViewHandle, HexViewProps>(function HexView(
  { source, match, label, onPosition, testId = "hex-view" },
  ref,
) {
  const box = useRef<HTMLDivElement>(null)
  const rows = useRows(box)
  const [topRow, setTopRow] = useState(0)
  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useImperativeHandle(ref, () => ({ focus: () => box.current?.focus() }), [])
  const totalRows = Math.ceil(source.size / HEX_BYTES_PER_ROW)
  const maxTop = Math.max(0, totalRows - rows)
  const clampRow = useCallback((r: number) => Math.max(0, Math.min(maxTop, r)), [maxTop])
  const digits = source.size > 0xffffffff ? 12 : 8

  useEffect(() => {
    let live = true
    const start = topRow * HEX_BYTES_PER_ROW
    source
      .read(start, start + rows * HEX_BYTES_PER_ROW)
      .then((b) => {
        if (!live) return
        setBytes(b)
        setFailed(null)
      })
      .catch((error: unknown) => {
        if (live) setFailed(error instanceof Error ? error.message : String(error))
      })
    return () => {
      live = false
    }
  }, [source, topRow, rows])

  // A new match: its row with two rows of context above (adjusted while rendering).
  const [shownMatch, setShownMatch] = useState(match)
  if (match !== shownMatch) {
    setShownMatch(match)
    if (match) setTopRow(clampRow(Math.floor(match.start / HEX_BYTES_PER_ROW) - 2))
  }

  const fraction = maxTop > 0 ? topRow / maxTop : 0
  useEffect(
    () => onPosition?.(topRow * HEX_BYTES_PER_ROW, fraction),
    [topRow, fraction, onPosition],
  )
  useWheelRows(box, (n) => setTopRow((r) => clampRow(r + n)))

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.altKey || e.metaKey) return
    const page = Math.max(1, rows - 1)
    const moves: Record<string, (r: number) => number> = {
      ArrowDown: (r) => r + 1,
      ArrowUp: (r) => r - 1,
      PageDown: (r) => r + page,
      PageUp: (r) => r - page,
      Home: () => 0,
      End: () => maxTop,
    }
    const move = moves[e.key]
    if (!move || (e.ctrlKey && e.key !== "Home" && e.key !== "End")) return
    e.preventDefault()
    e.stopPropagation()
    setTopRow((r) => clampRow(move(r)))
  }

  const lines: string[][] = []
  if (bytes) {
    for (let row = 0; row * HEX_BYTES_PER_ROW < bytes.length; row++) {
      lines.push([
        ((topRow + row) * HEX_BYTES_PER_ROW).toString(16).padStart(digits, "0"),
        ...Array.from(bytes.subarray(row * HEX_BYTES_PER_ROW, (row + 1) * HEX_BYTES_PER_ROW), (b) =>
          String(b),
        ),
      ])
    }
  }
  const base = topRow * HEX_BYTES_PER_ROW
  const marked = (i: number): boolean =>
    match !== null && base + i >= match.start && base + i < match.end

  return (
    <div className="flex min-h-0 flex-1">
      <div
        ref={box}
        tabIndex={0}
        role="document"
        aria-label={label}
        data-testid={testId}
        data-top={base}
        onKeyDown={onKeyDown}
        className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden bg-canvas px-2 font-mono text-xs leading-[18px] text-text outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        {failed ? (
          <p role="alert" className="p-2 font-sans text-danger">
            This file can't be read: {failed}
          </p>
        ) : (
          lines.map(([offset, ...cells], row) => {
            const values = cells.map(Number)
            const at = row * HEX_BYTES_PER_ROW
            const anyMark = match !== null && values.some((_, k) => marked(at + k))
            return (
              <div key={offset} className="flex h-[18px] gap-4 whitespace-pre">
                <span className="text-muted">{offset}</span>
                <span>
                  {anyMark
                    ? values.map((b, k) => (
                        <span key={k} className={marked(at + k) ? "bg-accent text-canvas" : ""}>
                          {hex2(b)}
                          {k === 7 ? "  " : " "}
                        </span>
                      ))
                    : values
                        .map((b, k) => hex2(b) + (k === 7 ? "  " : " "))
                        .join("")
                        .padEnd(HEX_BYTES_PER_ROW * 3 + 1)}
                </span>
                <span className="text-muted">{values.map(printable).join("")}</span>
              </div>
            )
          })
        )}
      </div>
      <ByteScrollbar
        fraction={fraction}
        onJump={(f) => setTopRow(clampRow(Math.round(f * maxTop)))}
        label={t("{label} position", { label })}
      />
    </div>
  )
})
