import type { CompareProgress, CompareShow, ComparePlan, DiffAction } from "@panelyth/contracts"
import { COMPARE_SHOW } from "@panelyth/contracts"
import { isMarked, usePageItem } from "@panelyth/renderer-core"
import { Button, DialogWindow } from "@panelyth/ui"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useEffect, useRef, type KeyboardEvent } from "react"
import {
  closeSync,
  confirmSync,
  hasWork,
  isCompared,
  isComparing,
  moveSyncCursor,
  selectAllSyncRows,
  setDirection,
  SHOW_LABEL,
  startCompare,
  startSync,
  stopCompare,
  SYMBOL,
  symbolOf,
  syncRows,
  toggleShow,
  toggleSyncRow,
  updateCompareDates,
  updateSyncOptions,
  updateSyncRoot,
  useCompareStore,
  type SyncDialogState,
} from "../features/compare"
import { formatBytes, formatCount, formatDate } from "../features/format"
import { useSettingsStore } from "../features/settings"
import { msg, t } from "@panelyth/i18n"

const field =
  "h-8 w-full rounded-md border border-border bg-canvas px-2 text-xs text-text outline-none focus:border-accent"

const ROW_HEIGHT = 22
const PAGE_ROWS = 14
const COLUMNS =
  "grid grid-cols-[minmax(0,1fr)_5.5rem_8.5rem_2.5rem_8.5rem_5.5rem] items-center gap-x-2"

/** The tone of each symbol: what is copied, what is deleted, what is left alone. */
const TONE: Record<CompareShow, string> = {
  copyRight: "text-accent",
  copyLeft: "text-success",
  equal: "text-muted",
  different: "text-warning",
  delete: "text-danger",
}

/** What each direction button does to the selected rows. */
const DIRECTIONS: readonly {
  action: DiffAction | "delete" | "default"
  symbol: string
  label: string
}[] = [
  { action: "copyRight", symbol: SYMBOL.copyRight, label: msg("Copy to the right") },
  { action: "copyLeft", symbol: SYMBOL.copyLeft, label: msg("Copy to the left") },
  { action: "none", symbol: SYMBOL.different, label: msg("Leave alone") },
  { action: "delete", symbol: SYMBOL.delete, label: msg("Delete the one-sided entry") },
  { action: "default", symbol: "↺", label: msg("Default direction") },
]

/**
 * Synchronize directories (Stage C08, UX-DESIGN "Dialogs"): the two roots,
 * the compare options, the result table with a direction per row, filters,
 * and Synchronize. A sync applies the rows the table shows, after a
 * confirmation that says what is copied and deleted.
 */
export function SyncDialog() {
  const open = useCompareStore((s) => s.sync !== null)
  if (!open) return null
  return (
    <DialogWindow
      open
      onOpenChange={(next) => {
        if (!next) closeSync()
      }}
      title={t("Synchronize directories")}
      contentClassName="w-[min(76rem,calc(100vw-2rem))]"
    >
      <SyncBody />
    </DialogWindow>
  )
}

function SyncBody() {
  const s = useCompareStore((st) => st.sync)
  if (!s) return null
  const comparing = isComparing(s)
  const compared = isCompared(s)
  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="sync-dialog">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!comparing) void startCompare()
        }}
      >
        <div className="flex gap-3">
          <Root label={t("Left folder")} value={s.left.path} side="left" />
          <Root label={t("Right folder")} value={s.right.path} side="right" />
        </div>
        <Options s={s} />
      </form>
      <p aria-live="polite" className="truncate text-muted" data-testid="sync-status">
        {statusText(s.progress, comparing)}
      </p>
      {s.confirming && s.plan && s.run ? (
        <Confirm s={s} plan={s.plan} left={s.run.left} right={s.run.right} />
      ) : (
        <>
          <Toolbar s={s} enabled={compared} />
          <Table s={s} />
          {s.error && (
            <p role="alert" className="text-danger">
              {s.error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-muted" data-testid="sync-summary">
              {compared && s.plan ? summaryText(s.plan) : ""}
            </p>
            <Button onClick={closeSync}>{t("Close")}</Button>
            <Button
              variant="primary"
              disabled={!compared || !hasWork(s.plan)}
              onClick={() => confirmSync(true)}
            >
              {t("Synchronize…")}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function Root({ label, value, side }: { label: string; value: string; side: "left" | "right" }) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-muted">{label}</span>
      <input
        aria-label={label}
        className={field}
        value={value}
        spellCheck={false}
        onChange={(e) => updateSyncRoot(side, e.target.value)}
      />
    </label>
  )
}

function Check({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange(checked: boolean): void
}) {
  return (
    <label className={`flex items-center gap-2 ${disabled ? "opacity-50" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  )
}

/** The compare options; the date rules are the ones Shift+F2 uses (Settings). */
function Options({ s }: { s: SyncDialogState }) {
  const tolerance = useSettingsStore((st) => st.settings.compareToleranceMs)
  const dst = useSettingsStore((st) => st.settings.compareDst)
  const ignoreDates = useSettingsStore((st) => st.settings.compareIgnoreDates)
  const comparing = isComparing(s)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Check
        label={t("Left to right only (the right side becomes a copy of the left)")}
        checked={s.asymmetric}
        onChange={(asymmetric) => updateSyncOptions({ asymmetric })}
      />
      <Check
        label={t("Compare contents")}
        checked={s.content}
        onChange={(content) => updateSyncOptions({ content })}
      />
      <label className={`flex items-center gap-2 ${ignoreDates ? "opacity-50" : ""}`}>
        <span className="text-muted">{t("Dates")}</span>
        <select
          aria-label={t("Dates")}
          className={`${field} w-auto`}
          value={tolerance}
          disabled={ignoreDates}
          onChange={(e) => updateCompareDates({ toleranceMs: e.target.value === "0" ? 0 : 2000 })}
        >
          <option value={2000}>{t("Within 2 seconds (FAT drives)")}</option>
          <option value={0}>{t("Exact")}</option>
        </select>
      </label>
      <Check
        label={t("Ignore a one-hour difference (daylight saving time)")}
        checked={dst}
        disabled={ignoreDates}
        onChange={(next) => updateCompareDates({ dst: next })}
      />
      <Check
        label={t("Ignore dates")}
        checked={ignoreDates}
        onChange={(next) => updateCompareDates({ ignoreDates: next })}
      />
      <span className="flex-1" />
      {comparing ? (
        <Button onClick={stopCompare}>{t("Stop")}</Button>
      ) : (
        <Button type="submit" variant={s.run ? "secondary" : "primary"} autoFocus>
          {s.run ? t("Compare again") : t("Compare")}
        </Button>
      )}
    </div>
  )
}

function statusText(progress: CompareProgress | null, comparing: boolean): string {
  if (!progress) {
    return comparing ? t("Comparing…") : t("Choose the two folders and press Compare.")
  }
  const entries = formatCount(progress.entries)
  if (progress.state === "running") {
    return progress.phase === "content"
      ? t("Comparing contents: {files} files, {size}", {
          files: formatCount(progress.compared),
          size: formatBytes(progress.bytes),
        })
      : t("Comparing: {entries} entries in {folders} folders", {
          entries,
          folders: formatCount(progress.dirs),
        })
  }
  if (progress.state === "cancelled") return t("Stopped. Compare again to see the differences.")
  if (progress.state === "failed") return t("One of the folders could not be read.")
  const parts = [
    t("Compared {entries} entries in {seconds} s.", {
      entries,
      seconds: (progress.elapsedMs / 1000).toFixed(1),
    }),
  ]
  if (progress.errors > 0)
    parts.push(
      t("{count} folders or entries could not be read and were left out.", {
        count: formatCount(progress.errors),
      }),
    )
  if (progress.links > 0)
    parts.push(t("{count} links were not compared.", { count: formatCount(progress.links) }))
  if (progress.truncated)
    parts.push(t("Only the first {count} rows are listed.", { count: formatCount(progress.rows) }))
  return parts.join(" ")
}

function summaryText(plan: ComparePlan): string {
  if (!hasWork(plan)) return t("Nothing to synchronize in the rows shown.")
  return t("To the right: {right} · to the left: {left} · to delete: {deletes}", {
    right: formatCount(plan.copyRight.files),
    left: formatCount(plan.copyLeft.files),
    deletes: formatCount(plan.deleteRight + plan.deleteLeft),
  })
}

/** The filters (which symbols the table lists) and the direction buttons. */
function Toolbar({ s, enabled }: { s: SyncDialogState; enabled: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label={t("Show")} className="flex items-center gap-1">
        <span className="mr-1 text-muted">{t("Show")}</span>
        {COMPARE_SHOW.map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={s.show.includes(kind)}
            aria-label={t(SHOW_LABEL[kind])}
            title={t(SHOW_LABEL[kind])}
            disabled={!enabled}
            data-testid={`sync-show-${kind}`}
            onClick={() => void toggleShow(kind)}
            className="flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-muted hover:bg-raised disabled:opacity-40 aria-pressed:border-accent aria-pressed:bg-accent/10 aria-pressed:text-text"
          >
            <span className={`font-semibold ${TONE[kind]}`} aria-hidden="true">
              {SYMBOL[kind]}
            </span>
            <span className="tabular-nums">{formatCount(s.plan?.counts[kind] ?? 0)}</span>
          </button>
        ))}
      </div>
      <span className="flex-1" />
      <div role="group" aria-label={t("Direction of the selected rows")} className="flex gap-1">
        {DIRECTIONS.map((d) => (
          <button
            key={d.action}
            type="button"
            aria-label={t(d.label)}
            title={t(d.label)}
            disabled={!enabled || (s.run?.total ?? 0) === 0}
            data-testid={`sync-set-${d.action}`}
            onClick={() => void setDirection(d.action)}
            className="grid size-7 place-items-center rounded-md border border-border font-semibold text-text hover:bg-raised disabled:opacity-40"
          >
            <span aria-hidden="true">{d.symbol}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function Table({ s }: { s: SyncDialogState }) {
  const scroll = useRef<HTMLDivElement>(null)
  const total = s.run?.total ?? 0
  const cursor = s.cursor
  // TanStack Virtual returns methods that React Compiler cannot safely memoize.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scroll.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  })
  const items = virtualizer.getVirtualItems()
  const first = items[0]?.index ?? 0
  const last = items.at(-1)?.index ?? -1
  useEffect(() => {
    if (last >= first) syncRows.setRange(first, last)
  }, [first, last, s.run?.version])
  useEffect(() => {
    if (total > 0) virtualizer.scrollToIndex(cursor)
  }, [cursor, total, virtualizer])
  // A finished compare hands the keys to its table.
  const ready = isCompared(s) && total > 0
  useEffect(() => {
    if (ready) scroll.current?.focus()
  }, [ready, s.run?.compareId])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step: Record<string, number> = {
      ArrowDown: 1,
      ArrowUp: -1,
      PageDown: PAGE_ROWS,
      PageUp: -PAGE_ROWS,
      Home: -Infinity,
      End: Infinity,
    }
    const direction: Record<string, DiffAction | "delete" | "default"> = {
      ArrowRight: "copyRight",
      ArrowLeft: "copyLeft",
      "=": "none",
      Delete: "delete",
      Backspace: "default",
    }
    if (e.key in step) {
      e.preventDefault()
      const by = step[e.key]!
      moveSyncCursor(Number.isFinite(by) ? cursor + by : by > 0 ? total - 1 : 0, e.shiftKey)
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault()
      selectAllSyncRows()
    } else if (e.key in direction && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      void setDirection(direction[e.key]!)
    }
  }

  return (
    <div className="flex flex-col rounded-md border border-border">
      <div
        className={`${COLUMNS} h-7 border-b border-border bg-chrome px-2 text-[0.6875rem] font-semibold tracking-wide text-muted uppercase`}
        aria-hidden="true"
      >
        <span>{t("Name")}</span>
        <span className="text-right">{t("Left size")}</span>
        <span>{t("Left date")}</span>
        <span />
        <span>{t("Right date")}</span>
        <span className="text-right">{t("Right size")}</span>
      </div>
      <div
        ref={scroll}
        role="listbox"
        aria-label={t("Differences")}
        aria-multiselectable="true"
        tabIndex={0}
        aria-activedescendant={total > 0 ? `sync-row-${cursor}` : undefined}
        onKeyDown={onKeyDown}
        data-testid="sync-table"
        className="relative h-[min(22rem,45vh)] overflow-auto bg-canvas outline-none focus:ring-1 focus:ring-accent"
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((v) => (
            <Row
              key={v.key}
              index={v.index}
              start={v.start}
              cursor={v.index === cursor}
              marks={s.marks}
            />
          ))}
        </div>
      </div>
      <p className="border-t border-border px-2 py-1 text-[0.6875rem] text-muted">
        {t(
          "Keys: → and ← set the direction, = leaves a row alone, Delete deletes a one-sided entry, Backspace restores the default.",
        )}
      </p>
    </div>
  )
}

function Row({
  index,
  start,
  cursor,
  marks,
}: {
  index: number
  start: number
  cursor: boolean
  marks: SyncDialogState["marks"]
}) {
  const item = usePageItem(syncRows, index)
  const dateFormat = useSettingsStore((st) => st.settings.dateFormat)
  const diff = item?.diff
  const selected = isMarked(marks, index, item?.id)
  const symbol = diff ? symbolOf(diff) : null
  // A copy that replaces a newer file, and the side a delete removes, stand out.
  const overNewer =
    (diff?.action === "copyRight" && diff.state === "rightNewer") ||
    (diff?.action === "copyLeft" && diff.state === "leftNewer")
  const side = (which: "left" | "right") => {
    const sd = diff?.[which]
    const doomed = diff?.action === (which === "left" ? "deleteLeft" : "deleteRight")
    const tone = doomed ? "text-danger line-through" : "text-muted"
    const size = (
      <span key="size" className={`truncate text-right tabular-nums ${tone}`}>
        {sd ? (item?.kind === "dir" ? "<DIR>" : formatBytes(sd.sizeBytes)) : ""}
      </span>
    )
    const date = (
      <span key="date" className={`truncate tabular-nums ${tone}`}>
        {sd ? formatDate(sd.modifiedMs, dateFormat) : ""}
      </span>
    )
    return which === "left" ? [size, date] : [date, size]
  }
  return (
    <div
      id={`sync-row-${index}`}
      role="option"
      aria-selected={selected || cursor}
      data-action={diff?.action}
      data-state={diff?.state}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey) toggleSyncRow(index)
        else moveSyncCursor(index, e.shiftKey)
      }}
      style={{ position: "absolute", top: start, height: ROW_HEIGHT, left: 0, right: 0 }}
      className={`${COLUMNS} px-2 ${selected ? "bg-accent/20" : cursor ? "bg-raised" : "hover:bg-raised/60"} ${cursor ? "outline outline-1 -outline-offset-1 outline-accent" : ""}`}
    >
      {item && diff && symbol ? (
        <>
          <span className="min-w-0 truncate text-text">
            <span className="text-muted">{diff.dir ? diff.dir + "/" : ""}</span>
            {item.name}
            {item.kind === "dir" ? "/" : ""}
          </span>
          {side("left")}
          <span
            className={`text-center font-semibold ${overNewer ? "text-warning" : TONE[symbol]}`}
            title={overNewer ? t("Replaces a newer file") : t(SHOW_LABEL[symbol])}
          >
            <span aria-hidden="true">{SYMBOL[symbol]}</span>
            <span className="sr-only">
              {overNewer ? t("Replaces a newer file") : t(SHOW_LABEL[symbol])}
            </span>
          </span>
          {side("right")}
        </>
      ) : (
        <span className="h-2 w-1/3 rounded bg-skeleton" />
      )}
    </div>
  )
}

/** The confirmation: what a sync of the shown rows copies, creates and deletes. */
function Confirm({
  s,
  plan,
  left,
  right,
}: {
  s: SyncDialogState
  plan: ComparePlan
  left: string
  right: string
}) {
  const deletes = plan.deleteLeft + plan.deleteRight
  return (
    <div className="flex flex-col gap-3" data-testid="sync-confirm">
      <ul className="flex flex-col gap-1.5 rounded-md border border-border bg-canvas p-3">
        {plan.copyRight.files > 0 && (
          <li>
            {t("Copy {count, plural, one {# file} other {# files}} ({size}) to the right: {path}", {
              count: plan.copyRight.files,
              size: formatBytes(plan.copyRight.bytes),
              path: right,
            })}
          </li>
        )}
        {plan.copyLeft.files > 0 && (
          <li>
            {t("Copy {count, plural, one {# file} other {# files}} ({size}) to the left: {path}", {
              count: plan.copyLeft.files,
              size: formatBytes(plan.copyLeft.bytes),
              path: left,
            })}
          </li>
        )}
        {plan.folders > 0 && (
          <li>
            {t("Create {count, plural, one {# folder} other {# folders}}", {
              count: plan.folders,
            })}
          </li>
        )}
        {plan.deleteRight > 0 && (
          <li className="text-danger">
            {t("Delete {count, plural, one {# entry} other {# entries}} on the right: {path}", {
              count: plan.deleteRight,
              path: right,
            })}
          </li>
        )}
        {plan.deleteLeft > 0 && (
          <li className="text-danger">
            {t("Delete {count, plural, one {# entry} other {# entries}} on the left: {path}", {
              count: plan.deleteLeft,
              path: left,
            })}
          </li>
        )}
        {plan.overwriteNewer > 0 && (
          <li className="text-warning">
            {t(
              "{count, plural, one {# newer file is} other {# newer files are}} replaced by an older one.",
              { count: plan.overwriteNewer },
            )}
          </li>
        )}
      </ul>
      <p className="text-muted">
        {t(
          "Only the rows the table shows are synchronized. An entry that changed since the comparison is left alone and reported.",
        )}
      </p>
      {deletes > 0 && (
        <Check
          label={t("Delete permanently instead of moving to the trash")}
          checked={s.deletePermanently}
          onChange={(deletePermanently) => updateSyncOptions({ deletePermanently })}
        />
      )}
      {s.error && (
        <p role="alert" className="text-danger">
          {s.error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={() => confirmSync(false)}>{t("Back")}</Button>
        <Button
          variant={deletes > 0 || plan.overwriteNewer > 0 ? "danger" : "primary"}
          disabled={s.starting}
          onClick={() => void startSync()}
          autoFocus
        >
          {t("Synchronize")}
        </Button>
      </div>
    </div>
  )
}
