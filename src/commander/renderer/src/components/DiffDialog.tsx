import type { TextDiffFile, TextDiffOpenResult, TextDiffRow } from "@panelyth/contracts"
import { Button, DialogWindow } from "@panelyth/ui"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent } from "react"
import {
  closeDiff,
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
  const d = useCompareStore((s) => s.diff)
  const fromList = useCompareStore((s) => s.many !== null)
  if (!d) return null
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) closeDiff()
      }}
      title={t("Compare by content")}
      contentClassName="w-[min(100rem,calc(100vw-2rem))]"
    >
      <div className="flex flex-col gap-2 text-xs" data-testid="diff-dialog">
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
          <TextDiff key={d.info.diffId} info={d.info} maxChars={d.maxChars} fromList={fromList} />
        )}
        {(d.error || !d.info || d.info.diffId === 0) && (
          <div className="flex justify-end gap-2">
            {fromList && <FileSteps />}
            <Button onClick={closeDiff} autoFocus>
              {fromList ? t("Back to the list") : t("Close")}
            </Button>
          </div>
        )}
      </div>
    </DialogWindow>
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
}: {
  info: TextDiffOpenResult
  maxChars: number
  fromList: boolean
}) {
  const scroll = useRef<HTMLDivElement>(null)
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
      <div
        ref={scroll}
        role="region"
        aria-label={t("Lines of both files")}
        tabIndex={0}
        onKeyDown={onKeyDown}
        data-testid="diff-rows"
        className="relative h-[calc(100vh-14rem)] min-h-40 overflow-auto rounded-md border border-border bg-canvas font-mono text-[0.75rem] leading-[18px] outline-none focus:border-accent"
      >
        <div
          style={{
            height: virtualizer.getTotalSize(),
            position: "relative",
            // Wide enough for the longest line seen so far, on both sides.
            minWidth: `calc(${2 * Math.min(maxChars, 600)}ch + 2 * ${GUTTER} + 2rem)`,
          }}
        >
          {items.map((v) => (
            <Line key={v.key} index={v.index} start={v.start} />
          ))}
        </div>
      </div>
    </>
  )
}

/** A changed line with the part that differs marked (not by color alone: it is underlined too). */
function Marked({ text, from, to }: { text: string; from: number; to: number }) {
  if (to <= from) return <>{text}</>
  return (
    <>
      {text.slice(0, from)}
      <mark className="rounded-sm bg-warning/40 text-inherit underline decoration-dotted underline-offset-2">
        {text.slice(from, to)}
      </mark>
      {text.slice(to)}
    </>
  )
}

function Line({ index, start }: { index: number; start: number }) {
  const row = diffRows.getRow(index)
  const style = { position: "absolute" as const, top: start, height: ROW_HEIGHT, left: 0, right: 0 }
  if (!row) {
    return (
      <div style={style} className="flex items-center px-2">
        <span className="h-2 w-1/4 rounded bg-skeleton" />
      </div>
    )
  }
  const right = row.op === "equal" ? row.left : (row.right ?? "")
  const number = "shrink-0 px-2 text-right text-muted tabular-nums select-none"
  const text = "min-w-0 flex-1 overflow-hidden whitespace-pre"
  return (
    <div style={style} data-op={row.op} className="flex">
      <div className={`flex w-1/2 border-r border-border ${LEFT_TONE[row.op]}`}>
        <span className={number} style={{ width: GUTTER }}>
          {row.l || ""}
        </span>
        <span className={text}>
          {!row.l ? (
            ""
          ) : row.spans ? (
            <Marked text={row.left} from={row.spans[0]} to={row.spans[1]} />
          ) : (
            row.left
          )}
          {row.cut && row.l ? "…" : ""}
        </span>
      </div>
      <div className={`flex w-1/2 ${RIGHT_TONE[row.op]}`}>
        <span className={number} style={{ width: GUTTER }}>
          {row.r || ""}
        </span>
        <span className={text}>
          {!row.r ? (
            ""
          ) : row.spans ? (
            <Marked text={right} from={row.spans[2]} to={row.spans[3]} />
          ) : (
            right
          )}
          {row.cut && row.r ? "…" : ""}
        </span>
      </div>
    </div>
  )
}
