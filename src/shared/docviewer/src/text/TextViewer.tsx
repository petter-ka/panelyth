import { useVirtualizer } from "@tanstack/react-virtual"
import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import type { DocumentParams } from "../params"
import {
  decodeText,
  findMatches,
  lineEndingOf,
  MAX_LINE_CHARS,
  MAX_TEXT_BYTES,
  splitLines,
} from "./decode"
import { useDocumentBytes } from "./useDocumentBytes"

const FONT_SIZES = [11, 12, 13, 14, 16, 18, 20, 24] as const
const DEFAULT_FONT = 2

const formatBytes = (n: number): string =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KB`
      : n < 1024 ** 3
        ? `${(n / 1024 ** 2).toFixed(1)} MB`
        : `${(n / 1024 ** 3).toFixed(2)} GB`

interface LineProps {
  text: string
  /** Match starts on this line; the current one is `current`. */
  starts: readonly number[]
  length: number
  current: number
}

/** One line, with its matches marked. Plain lines are a single text node. */
const Line = memo(function Line({ text, starts, length, current }: LineProps) {
  const shown = text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) : text
  const cut = shown.length !== text.length
  if (starts.length === 0) {
    return (
      <>
        {shown}
        {cut && (
          <span className="text-muted"> … ({text.length - shown.length} more characters)</span>
        )}
      </>
    )
  }
  const parts: React.ReactNode[] = []
  let at = 0
  for (const start of starts) {
    if (start < at || start >= shown.length) continue
    if (start > at) parts.push(shown.slice(at, start))
    parts.push(
      <mark key={start} className={`text-hit ${start === current ? "current" : ""}`}>
        {shown.slice(start, start + length)}
      </mark>,
    )
    at = start + length
  }
  parts.push(shown.slice(at))
  return <>{parts}</>
})

export function TextViewer({ params }: { params: DocumentParams }) {
  const bytes = useDocumentBytes(params.src, params.sizeBytes)
  const decoded = useMemo(
    () => (bytes.status === "ready" ? decodeText(bytes.bytes, bytes.truncated) : null),
    [bytes],
  )
  const lines = useMemo(() => (decoded ? splitLines(decoded.text) : []), [decoded])
  const ending = useMemo(() => (decoded ? lineEndingOf(decoded.text) : "none"), [decoded])
  const longest = useMemo(
    () =>
      Math.min(
        MAX_LINE_CHARS,
        lines.reduce((m, l) => Math.max(m, l.length), 0),
      ),
    [lines],
  )

  const [font, setFont] = useState(DEFAULT_FONT)
  const [wrap, setWrap] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState("")
  const deferred = useDeferredValue(query)
  const [matchIndex, setMatchIndex] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const findInput = useRef<HTMLInputElement>(null)

  const fontPx = FONT_SIZES[font]!
  const rowHeight = Math.round(fontPx * 1.5)
  const matches = useMemo(() => findMatches(lines, deferred), [lines, deferred])
  const byLine = useMemo(() => {
    const map = new Map<number, number[]>()
    for (const m of matches) {
      const list = map.get(m.line)
      if (list) list.push(m.start)
      else map.set(m.line, [m.start])
    }
    return map
  }, [matches])
  const current = matches[Math.min(matchIndex, matches.length - 1)]

  const gutterChars = String(Math.max(lines.length, 1)).length + 1
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => box.current,
    estimateSize: () => rowHeight,
    overscan: 20,
  })
  useEffect(() => virtualizer.measure(), [rowHeight, wrap, virtualizer])
  // Keys (Ctrl+F, arrows, PageDown) work at once, without a click first.
  const ready = bytes.status === "ready"
  useEffect(() => {
    if (ready) box.current?.focus()
  }, [ready])

  useEffect(() => setMatchIndex(0), [deferred])
  useEffect(() => {
    if (current) virtualizer.scrollToIndex(current.line, { align: "center" })
  }, [current, virtualizer])

  const step = (direction: 1 | -1): void => {
    if (matches.length === 0) return
    setMatchIndex((i) => (i + direction + matches.length) % matches.length)
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
    if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault()
      openFind()
    } else if (e.key === "F3") {
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    } else if (mod && (e.key === "+" || e.key === "=")) {
      e.preventDefault()
      setFont((f) => Math.min(FONT_SIZES.length - 1, f + 1))
    } else if (mod && e.key === "-") {
      e.preventDefault()
      setFont((f) => Math.max(0, f - 1))
    } else if (mod && e.key === "0") {
      e.preventDefault()
      setFont(DEFAULT_FONT)
    } else if (e.key === "Escape" && findOpen) {
      setFindOpen(false)
      box.current?.focus()
    }
  }

  if (bytes.status === "loading") {
    return <p className="p-6 text-sm text-muted">Loading…</p>
  }
  if (bytes.status === "error") {
    return (
      <p role="alert" className="p-6 text-sm text-danger">
        {bytes.message}
      </p>
    )
  }

  return (
    <div className="flex h-full flex-col bg-canvas text-text" onKeyDown={onKeyDown}>
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-chrome px-3 text-xs">
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium" title={params.name}>
          {params.name}
        </h1>
        <ToolbarButton label="Find (Ctrl+F)" onClick={openFind} pressed={findOpen}>
          Find
        </ToolbarButton>
        <ToolbarButton label="Wrap long lines" onClick={() => setWrap((w) => !w)} pressed={wrap}>
          Wrap
        </ToolbarButton>
        <ToolbarButton
          label="Smaller text (Ctrl+-)"
          onClick={() => setFont((f) => Math.max(0, f - 1))}
          disabled={font === 0}
        >
          A−
        </ToolbarButton>
        <ToolbarButton
          label="Larger text (Ctrl++)"
          onClick={() => setFont((f) => Math.min(FONT_SIZES.length - 1, f + 1))}
          disabled={font === FONT_SIZES.length - 1}
        >
          A+
        </ToolbarButton>
      </header>

      {findOpen && (
        <div
          role="search"
          className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-raised px-3 text-xs"
        >
          <input
            ref={findInput}
            aria-label="Find in text"
            value={query}
            placeholder="Find"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                step(e.shiftKey ? -1 : 1)
              }
            }}
            className="h-7 w-64 rounded border border-border bg-canvas px-2 text-text outline-none focus:border-accent"
          />
          <span aria-live="polite" className="w-28 text-muted tabular-nums">
            {query === ""
              ? ""
              : matches.length === 0
                ? "No matches"
                : `${Math.min(matchIndex, matches.length - 1) + 1} of ${matches.length}${matches.length >= 50_000 ? "+" : ""}`}
          </span>
          <ToolbarButton
            label="Previous match (Shift+Enter)"
            onClick={() => step(-1)}
            disabled={matches.length === 0}
          >
            ↑
          </ToolbarButton>
          <ToolbarButton
            label="Next match (Enter)"
            onClick={() => step(1)}
            disabled={matches.length === 0}
          >
            ↓
          </ToolbarButton>
          <ToolbarButton
            label="Close find (Esc)"
            onClick={() => {
              setFindOpen(false)
              box.current?.focus()
            }}
          >
            ✕
          </ToolbarButton>
        </div>
      )}

      <div
        ref={box}
        tabIndex={0}
        role="document"
        aria-label={params.name}
        data-testid="text-body"
        className="min-h-0 flex-1 overflow-auto outline-none"
        style={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: fontPx }}
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            width: wrap ? "100%" : `calc(${gutterChars + longest + 2}ch + 1rem)`,
            minWidth: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((row) => {
            const text = lines[row.index] ?? ""
            const starts = byLine.get(row.index) ?? []
            return (
              <div
                key={row.key}
                data-index={row.index}
                ref={wrap ? virtualizer.measureElement : undefined}
                className="absolute left-0 flex w-full"
                style={{
                  top: 0,
                  transform: `translateY(${row.start}px)`,
                  ...(wrap ? {} : { height: rowHeight }),
                  lineHeight: `${rowHeight}px`,
                }}
              >
                <span
                  aria-hidden="true"
                  className="sticky left-0 shrink-0 bg-canvas pr-3 pl-2 text-right text-muted select-none"
                  style={{ width: `${gutterChars + 1}ch`, boxSizing: "content-box" }}
                >
                  {row.index + 1}
                </span>
                <span
                  className={wrap ? "min-w-0 break-words whitespace-pre-wrap" : "whitespace-pre"}
                >
                  <Line
                    text={text}
                    starts={starts}
                    length={deferred.length}
                    current={current?.line === row.index ? current.start : -1}
                  />
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {bytes.truncated && (
        <p className="shrink-0 border-t border-border bg-raised px-3 py-1.5 text-xs text-warning">
          Showing the first {formatBytes(MAX_TEXT_BYTES)} of {formatBytes(params.sizeBytes)}. Use
          the commander&apos;s lister (F3 hex view) or an editor (F4) for the rest.
        </p>
      )}
      <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-border bg-chrome px-3 text-[0.6875rem] text-muted">
        <span>{lines.length.toLocaleString()} lines</span>
        <span>{formatBytes(params.sizeBytes)}</span>
        <span>{decoded?.encoding}</span>
        <span>{ending}</span>
      </footer>
    </div>
  )
}

function ToolbarButton({
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
