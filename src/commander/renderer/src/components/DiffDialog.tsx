import type { TextDiffFile, TextDiffOpenResult, TextDiffRow } from "@panelyth/contracts"
import { Button, DialogWindow } from "@panelyth/ui"
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual"
import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from "react"
import {
  closeDiff,
  compareDiffAgain,
  diffRows,
  hasManyDiff,
  openManyDiff,
  useCompareStore,
  type DiffDialogState,
} from "../features/compare"
import { formatBytes, formatCount } from "../features/format"
import { t } from "@panelyth/i18n"

const ROW_HEIGHT = 18
const GUTTER = "3.5rem"

type Side = "left" | "right"

/**
 * The two panes keep the same scroll position. Setting a position that is
 * already there raises no scroll event, so they do not chase each other.
 */
function follow(from: HTMLElement, to: HTMLElement | null): void {
  if (!to) return
  if (to.scrollTop !== from.scrollTop) to.scrollTop = from.scrollTop
  if (to.scrollLeft !== from.scrollLeft) to.scrollLeft = from.scrollLeft
}

/** Row backgrounds: a changed pair, a line only on the left, a line only on the right. */
const LEFT_TONE: Record<TextDiffRow["op"], string> = {
  equal: "",
  changed: "bg-warning/15",
  removed: "bg-danger/15",
  added: "bg-raised/60",
}
const RIGHT_TONE: Record<TextDiffRow["op"], string> = {
  equal: "",
  changed: "bg-warning/15",
  removed: "bg-raised/60",
  added: "bg-success/15",
}

/**
 * Compare by content (Stage C08): two text files side by side, compared line
 * by line in Go and paged from it; files that are not text, or too large,
 * get the answer of a streamed comparison: identical or not. Opened from
 * the list of several compared files (Stage C10.5), it also steps to the
 * next and the previous file that differs.
 */
export function DiffDialog() {
  const open = useCompareStore((s) => s.diff !== null)
  if (!open) return null
  return (
    <DialogWindow
      open
      onOpenChange={(next) => {
        if (!next) closeDiff()
      }}
      title={t("Compare by content")}
      contentClassName="w-[min(100rem,calc(100vw-2rem))]"
    >
      <DiffView />
    </DialogWindow>
  )
}

/**
 * The comparison itself: in the dialog, or filling its window (ADR-0048),
 * where `fill` lets the lines take the window's height.
 */
export function DiffView({ fill = false }: { fill?: boolean }) {
  const d = useCompareStore((s) => s.diff)
  const fromList = useCompareStore((s) => s.many !== null)
  if (!d) return null
  return (
    <div
      className={`flex flex-col gap-2 text-xs ${fill ? "min-h-0 flex-1" : ""}`}
      data-testid="diff-dialog"
    >
      <div className="flex gap-3">
        <FileHead name={d.left.name} file={d.info?.left} />
        <FileHead name={d.right.name} file={d.info?.right} />
      </div>
      {d.error ? (
        <p role="alert" className="text-danger">
          {d.error}
        </p>
      ) : !d.info ? (
        <p aria-live="polite" className="text-muted" data-testid="diff-status">
          {t("Comparing…")}
        </p>
      ) : d.info.diffId === 0 ? (
        <ContentAnswer d={d} info={d.info} />
      ) : (
        <TextDiff
          key={d.info.diffId}
          info={d.info}
          maxChars={d.maxChars}
          fromList={fromList}
          fill={fill}
        />
      )}
      {(d.error || !d.info || d.info.diffId === 0) && (
        <div className={`flex justify-end gap-2 ${fill ? "mt-auto" : ""}`}>
          {d.error && <Button onClick={compareDiffAgain}>{t("Compare again")}</Button>}
          {fromList && <FileSteps />}
          <Button onClick={closeDiff} autoFocus>
            {fromList ? t("Back to the list") : t("Close")}
          </Button>
        </div>
      )}
    </div>
  )
}

function FileHead({ name, file }: { name: string; file: TextDiffFile | undefined }) {
  const detail = !file
    ? ""
    : file.encoding
      ? t("{lines} lines · {size} · {encoding}", {
          lines: formatCount(file.lines),
          size: formatBytes(file.sizeBytes),
          encoding: file.encoding.toUpperCase(),
        })
      : formatBytes(file.sizeBytes)
  return (
    <div className="flex min-w-0 flex-1 items-baseline gap-2 rounded-md border border-border bg-canvas px-2 py-1">
      <span className="min-w-0 truncate font-semibold text-text">{name}</span>
      <span className="shrink-0 text-muted tabular-nums">{detail}</span>
    </div>
  )
}

/** Files without a text diff: the streamed comparison's progress and its answer. */
function ContentAnswer({ d, info }: { d: DiffDialogState; info: TextDiffOpenResult }) {
  const why =
    info.reason === "tooLarge"
      ? t("These files are too large for a text comparison; their bytes are compared.")
      : t("These are not text files; their bytes are compared.")
  const job = d.job
  let answer: string
  let tone: string
  if (!job || job.state === "queued" || job.state === "running" || job.state === "paused") {
    const percent =
      job && job.bytesTotal > 0 ? Math.floor((job.bytesDone / job.bytesTotal) * 100) : 0
    answer = t("Comparing… {percent} %", { percent })
    tone = "text-muted"
  } else if (job.state === "cancelled") {
    answer = t("The comparison was cancelled.")
    tone = "text-muted"
  } else if (job.state === "failed") {
    answer = job.error || t("The files could not be compared.")
    tone = "text-danger"
  } else if (job.failed === 0) {
    answer = t("The files are identical.")
    tone = "text-success"
  } else {
    answer = t("The files are different.")
    tone = "text-warning"
  }
  return (
    <div className="flex flex-col gap-1.5 py-2">
      <p className="text-muted">{why}</p>
      <p aria-live="polite" className={`text-sm font-semibold ${tone}`} data-testid="diff-answer">
        {answer}
      </p>
      {d.detail && <p className="text-muted">{d.detail}</p>}
    </div>
  )
}

function summary(info: TextDiffOpenResult): string {
  if (info.identical) return t("The files are identical.")
  if (info.changes === 0)
    return t("No line differs, but the files are not the same: line ends or encoding differ.")
  const shown = info.blocks.length
  return info.changes > shown
    ? t("{count} differences (the first {shown} can be stepped through)", {
        count: formatCount(info.changes),
        shown: formatCount(shown),
      })
    : t("{count, plural, one {# difference} other {# differences}}", { count: info.changes })
}

/** Opened from the list of several files: the previous and the next file that differs. */
function FileSteps() {
  return (
    <>
      <Button
        size="sm"
        disabled={!hasManyDiff(-1)}
        onClick={() => void openManyDiff(-1)}
        title="Shift+P"
      >
        {t("Previous file")}
      </Button>
      <Button
        size="sm"
        disabled={!hasManyDiff(1)}
        onClick={() => void openManyDiff(1)}
        title="Shift+N"
      >
        {t("Next file")}
      </Button>
    </>
  )
}

function TextDiff({
  info,
  maxChars,
  fromList,
  fill,
}: {
  info: TextDiffOpenResult
  maxChars: number
  fromList: boolean
  fill: boolean
}) {
  const scroll = useRef<HTMLDivElement>(null)
  const otherPane = useRef<HTMLDivElement>(null)
  // The visible rows render again when a page of them arrives.
  useSyncExternalStore(diffRows.subscribe, diffRows.getVersion)
  // TanStack Virtual returns methods that React Compiler cannot safely memoize.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: info.rows,
    getScrollElement: () => scroll.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })
  const items = virtualizer.getVirtualItems()
  const first = items[0]?.index ?? 0
  const last = items.at(-1)?.index ?? -1
  useEffect(() => {
    if (last >= first) diffRows.setRange(first, last, info.rows)
  }, [first, last, info.rows])
  useEffect(() => scroll.current?.focus(), [])

  /** The next (or previous) changed place from the top of the view. */
  const step = (direction: 1 | -1): void => {
    const top = Math.floor((scroll.current?.scrollTop ?? 0) / ROW_HEIGHT)
    const blocks = info.blocks
    const target =
      direction > 0
        ? blocks.find(([start]) => start > top)
        : blocks.findLast(([start]) => start < top)
    if (target) virtualizer.scrollToIndex(target[0], { align: "start" })
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    // Shift+N / Shift+P: the next and the previous file of the list.
    if (fromList && (e.key === "N" || e.key === "P")) {
      e.preventDefault()
      void openManyDiff(e.key === "N" ? 1 : -1)
      return
    }
    if (e.key === "n") {
      e.preventDefault()
      step(1)
    } else if (e.key === "p") {
      e.preventDefault()
      step(-1)
    }
  }
  const none = info.changes === 0

  return (
    <>
      <div className="flex items-center gap-2">
        <p
          aria-live="polite"
          className={`min-w-0 flex-1 truncate ${info.identical ? "text-success" : "text-text"}`}
          data-testid="diff-status"
        >
          {summary(info)}
        </p>
        <Button size="sm" disabled={none} onClick={() => step(-1)} title="P">
          {t("Previous difference")}
        </Button>
        <Button size="sm" disabled={none} onClick={() => step(1)} title="N">
          {t("Next difference")}
        </Button>
        {fromList && <FileSteps />}
        <Button size="sm" onClick={closeDiff}>
          {fromList ? t("Back to the list") : t("Close")}
        </Button>
      </div>
      {/* Two panes, one file each; they scroll together, so a long line never hides one of them. */}
      <div
        data-testid="diff-rows"
        onKeyDown={onKeyDown}
        className={`flex gap-3 ${fill ? "min-h-0 flex-1" : "h-[calc(100vh-14rem)] min-h-40"}`}
      >
        <Pane
          side="left"
          label={t("Lines of the left file")}
          scrollRef={scroll}
          onScroll={(e) => follow(e.currentTarget, otherPane.current)}
          size={virtualizer.getTotalSize()}
          maxChars={maxChars}
          items={items}
        />
        <Pane
          side="right"
          label={t("Lines of the right file")}
          scrollRef={otherPane}
          onScroll={(e) => follow(e.currentTarget, scroll.current)}
          size={virtualizer.getTotalSize()}
          maxChars={maxChars}
          items={items}
        />
      </div>
    </>
  )
}

/** One file of the comparison; the left pane is the virtualizer's scroll element. */
function Pane({
  side,
  label,
  scrollRef,
  onScroll,
  size,
  maxChars,
  items,
}: {
  side: Side
  label: string
  scrollRef: RefObject<HTMLDivElement | null>
  onScroll: (e: UIEvent<HTMLDivElement>) => void
  size: number
  maxChars: number
  items: VirtualItem[]
}) {
  return (
    <div
      ref={scrollRef}
      role="region"
      aria-label={label}
      tabIndex={0}
      onScroll={onScroll}
      data-side={side}
      className="relative min-w-0 flex-1 overflow-auto rounded-md border border-border bg-canvas font-mono text-[0.75rem] leading-[18px] outline-none focus:border-accent"
    >
      <div
        style={{
          height: size,
          position: "relative",
          // Wide enough for the longest line seen so far.
          minWidth: `calc(${Math.min(maxChars, 600)}ch + ${GUTTER} + 1rem)`,
        }}
      >
        {items.map((v) => (
          <Line key={v.key} side={side} index={v.index} start={v.start} />
        ))}
      </div>
    </div>
  )
}

/**
 * A changed line with the words and characters that differ marked (not by
 * color alone: they are underlined too). `spans` holds groups of [left from,
 * left to, right from, right to]; `at` is 0 for the left line, 2 for the right.
 */
function Marked({ text, spans, at }: { text: string; spans: number[]; at: 0 | 2 }) {
  const parts: ReactNode[] = []
  let done = 0
  for (let k = 0; k + 3 < spans.length; k += 4) {
    const from = spans[k + at]!
    const to = spans[k + at + 1]!
    if (to <= from) continue
    if (from > done) parts.push(text.slice(done, from))
    parts.push(
      <mark
        key={k}
        className="rounded-sm bg-warning/40 text-inherit underline decoration-dotted underline-offset-2"
      >
        {text.slice(from, to)}
      </mark>,
    )
    done = to
  }
  parts.push(text.slice(done))
  return <>{parts}</>
}

function Line({ side, index, start }: { side: Side; index: number; start: number }) {
  const row = diffRows.getRow(index)
  const style = { position: "absolute" as const, top: start, height: ROW_HEIGHT, left: 0, right: 0 }
  if (!row) {
    return (
      <div style={style} className="flex items-center px-2">
        <span className="h-2 w-1/4 rounded bg-skeleton" />
      </div>
    )
  }
  const left = side === "left"
  const n = left ? row.l : row.r
  // An equal row carries its text once, in `left`.
  const text = left ? row.left : row.op === "equal" ? row.left : (row.right ?? "")
  return (
    <div
      style={style}
      data-op={row.op}
      data-side={side}
      className={`flex ${(left ? LEFT_TONE : RIGHT_TONE)[row.op]}`}
    >
      <span
        className="shrink-0 px-2 text-right text-muted tabular-nums select-none"
        style={{ width: GUTTER }}
      >
        {n || ""}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre">
        {!n ? "" : row.spans ? <Marked text={text} spans={row.spans} at={left ? 0 : 2} /> : text}
        {row.cut && n ? "…" : ""}
      </span>
    </div>
  )
}
