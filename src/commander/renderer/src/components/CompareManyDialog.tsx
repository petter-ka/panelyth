import { Button, DialogWindow } from "@panelyth/ui"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useEffect, useRef, type KeyboardEvent } from "react"
import {
  closeCompareMany,
  MANY_RESULTS,
  manyRows,
  moveManyCursor,
  openManyDiff,
  toggleManyShow,
  useCompareStore,
  type CompareManyState,
  type ManyResult,
} from "../features/compare"
import { formatCount } from "../features/format"
import { isActiveJob } from "../features/queue"
import { msg, t } from "@panelyth/i18n"

const ROW_HEIGHT = 24

const RESULT_LABEL: Record<ManyResult, string> = {
  different: msg("Different"),
  missing: msg("Missing"),
  unreadable: msg("Not read"),
}
// The word says the result; the color only repeats it.
const RESULT_TONE: Record<ManyResult, string> = {
  different: "text-warning",
  missing: "text-danger",
  unreadable: "text-muted",
}

/**
 * Compare by content for several marked files (Stage C10.5): each file
 * against the file of its name in the other panel, as one job. The list
 * holds the files that are not identical; Enter opens a differing pair side
 * by side. The dialog steps aside while that view is open.
 */
export function CompareManyDialog() {
  const m = useCompareStore((s) => s.many)
  const diffOpen = useCompareStore((s) => s.diff !== null)
  if (!m || diffOpen) return null
  const running = m.job === null ? m.error === null : isActiveJob(m.job)
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) closeCompareMany()
      }}
      title={t("Compare by content")}
      description={t("{count} marked files, each with the file of its name in {folder}", {
        count: formatCount(m.count),
        folder: m.folder,
      })}
      contentClassName="w-[min(48rem,calc(100vw-2rem))]"
    >
      <div className="flex flex-col gap-2 text-xs" data-testid="compare-many">
        {m.error ? (
          <p role="alert" className="text-danger">
            {m.error}
          </p>
        ) : running ? (
          <Progress m={m} />
        ) : (
          <Results m={m} />
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={closeCompareMany} autoFocus={running || m.error !== null}>
            {running ? t("Stop") : t("Close")}
          </Button>
        </div>
      </div>
    </DialogWindow>
  )
}

function Progress({ m }: { m: CompareManyState }) {
  const job = m.job
  const seen = job ? job.done + job.failed + job.skipped : 0
  return (
    <p aria-live="polite" className="py-2 text-muted" data-testid="compare-many-status">
      {job && job.total > 0
        ? t("Comparing… {done} of {total}", {
            done: formatCount(seen),
            total: formatCount(job.total),
          })
        : t("Comparing…")}
    </p>
  )
}

function summary(m: CompareManyState): string {
  const job = m.job!
  if (job.state === "cancelled") return t("The comparison was stopped.")
  if (job.state === "failed") return job.error || t("The files could not be compared.")
  const leftOut =
    job.skipped > 0
      ? " · " +
        t("{count, plural, one {# folder or link left out} other {# folders or links left out}}", {
          count: job.skipped,
        })
      : ""
  if (job.done === 0 && job.failed === 0) return t("There was no file to compare.") + leftOut
  if (job.failed === 0) {
    return (
      t("{count, plural, one {The file is identical.} other {All # files are identical.}}", {
        count: job.done,
      }) + leftOut
    )
  }
  // The filter buttons below say how the others differ.
  return (
    t("Identical: {same} · Not identical: {other}", {
      same: formatCount(job.done),
      other: formatCount(job.failed),
    }) + leftOut
  )
}

function Results({ m }: { m: CompareManyState }) {
  const job = m.job!
  const allSame = job.state === "completed" && job.failed === 0
  return (
    <>
      <p
        aria-live="polite"
        className={`font-semibold ${allSame ? "text-success" : "text-text"}`}
        data-testid="compare-many-status"
      >
        {summary(m)}
      </p>
      {job.failed > 0 &&
        (m.loading ? (
          <p className="text-muted">{t("Reading the results…")}</p>
        ) : (
          <>
            <div role="group" aria-label={t("Show")} className="flex flex-wrap gap-1.5">
              {MANY_RESULTS.map((result) => (
                <button
                  key={result}
                  type="button"
                  aria-pressed={m.show.includes(result)}
                  disabled={m.counts[result] === 0}
                  onClick={() => toggleManyShow(result)}
                  className="rounded-md border border-border px-2 py-0.5 text-text hover:bg-raised disabled:opacity-40 aria-pressed:border-accent aria-pressed:bg-accent/10"
                >
                  {t(RESULT_LABEL[result])} {formatCount(m.counts[result])}
                </button>
              ))}
            </div>
            <ResultList cursor={m.cursor} version={m.show} />
          </>
        ))}
    </>
  )
}

function ResultList({ cursor, version }: { cursor: number; version: readonly ManyResult[] }) {
  const scroll = useRef<HTMLDivElement>(null)
  const count = manyRows.count()
  // TanStack Virtual returns methods that React Compiler cannot safely memoize.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scroll.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  })
  useEffect(() => scroll.current?.focus(), [])
  // The cursor stays in view; a changed filter starts at the top.
  useEffect(() => {
    if (count > 0) virtualizer.scrollToIndex(cursor, { align: "auto" })
  }, [cursor, version, count, virtualizer])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const page = Math.max(1, Math.floor((scroll.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1)
    const to: Record<string, number> = {
      ArrowDown: cursor + 1,
      ArrowUp: cursor - 1,
      PageDown: cursor + page,
      PageUp: cursor - page,
      Home: 0,
      End: count - 1,
    }
    if (e.key in to) {
      e.preventDefault()
      moveManyCursor(to[e.key]!)
    } else if (e.key === "Enter") {
      e.preventDefault()
      void openManyDiff()
    }
  }
  return (
    <div
      ref={scroll}
      role="listbox"
      aria-label={t("Files that are not identical")}
      aria-activedescendant={count > 0 ? `compare-many-row-${cursor}` : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-testid="compare-many-rows"
      className="relative h-72 overflow-auto rounded-md border border-border bg-canvas outline-none focus:border-accent"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((v) => {
          const row = manyRows.get(v.index)
          if (!row) return null
          return (
            <div
              key={v.key}
              id={`compare-many-row-${v.index}`}
              role="option"
              aria-selected={v.index === cursor}
              data-result={row.result}
              onClick={() => moveManyCursor(v.index)}
              onDoubleClick={() => {
                moveManyCursor(v.index)
                void openManyDiff()
              }}
              style={{
                position: "absolute",
                top: v.start,
                height: ROW_HEIGHT,
                left: 0,
                right: 0,
              }}
              className="flex cursor-default items-center gap-3 px-2 aria-selected:bg-accent/20"
            >
              <span className="min-w-0 flex-2 truncate text-text">{row.name}</span>
              <span className={`w-20 shrink-0 font-medium ${RESULT_TONE[row.result]}`}>
                {t(RESULT_LABEL[row.result])}
              </span>
              <span className="min-w-0 flex-3 truncate text-muted">{row.message}</span>
            </div>
          )
        })}
      </div>
      {count === 0 && (
        <p className="absolute inset-x-0 top-6 text-center text-muted">
          {t("No rows with the chosen results.")}
        </p>
      )}
    </div>
  )
}
