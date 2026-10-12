import type { RenamePlan, RenamePreviewRow } from "@panelyth/contracts"
import { Button, DialogWindow } from "@panelyth/ui"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useEffect, useRef, useState } from "react"
import {
  CASES,
  closeMultiRename,
  PLACEHOLDERS,
  previewRow,
  previewRowCurrent,
  showPreviewRows,
  startMultiRename,
  undoMultiRename,
  updatePlan,
  useRenameStore,
  type PlanField,
  type RenameDialogState,
} from "../features/rename"
import { formatCount } from "../features/format"
import { msg, t } from "@panelyth/i18n"

const field =
  "h-8 w-full rounded-md border border-border bg-canvas px-2 text-xs text-text outline-none focus:border-accent aria-invalid:border-danger"

const ROW_HEIGHT = 22
const COLUMNS = "grid grid-cols-[minmax(0,1fr)_1.25rem_minmax(0,1fr)_9.5rem] items-center gap-x-2"

/** Why a row is not renamed, in words: never by color alone. */
const CONFLICTS: Record<string, string> = {
  duplicate: msg("Same name twice"),
  exists: msg("Name is taken"),
  cycle: msg("Names are exchanged"),
}

function statusOf(row: RenamePreviewRow): { label: string; tone: string; detail?: string } {
  switch (row.status) {
    case "unchanged":
      return { label: t("Unchanged"), tone: "text-muted" }
    case "invalid":
      return {
        label: t("Invalid name"),
        tone: "text-danger",
        ...(row.reason !== undefined && { detail: row.reason }),
      }
    case "conflict":
      return { label: t(CONFLICTS[row.reason ?? ""] ?? CONFLICTS.exists!), tone: "text-warning" }
    case "rename":
      return { label: "", tone: "" }
  }
}

/**
 * Multi-rename (Stage C09, CFR-22, UX-DESIGN "Dialogs"): mask fields with
 * placeholder buttons, search and replace, case and counter, and a live
 * preview of old and new names with the names that are invalid or not free.
 * Start runs the plan as one job; Undo last takes the previous one back.
 */
export function MultiRenameDialog() {
  const open = useRenameStore((s) => s.dialog !== null)
  if (!open) return null
  return (
    <DialogWindow
      open
      onOpenChange={(next) => {
        if (!next) closeMultiRename()
      }}
      title={t("Multi-rename")}
      contentClassName="w-[min(56rem,calc(100vw-2rem))]"
    >
      <RenameForm />
    </DialogWindow>
  )
}

function RenameForm() {
  const d = useRenameStore((s) => s.dialog)
  const masks = useRef<Record<"nameMask" | "extMask", HTMLInputElement | null>>({
    nameMask: null,
    extMask: null,
  })
  /** The mask field a placeholder button writes into: the one used last. */
  const target = useRef<"nameMask" | "extMask">("nameMask")
  // The dialog closed: the store is ahead of the parent's render.
  if (!d) return null
  const plan = d.plan
  const problem = (f: PlanField): string | null =>
    d.problem && d.problem.field === f ? d.problem.message : null

  const insert = (text: string): void => {
    const key = target.current
    const input = masks.current[key]
    const value = plan[key]
    const start = input?.selectionStart ?? value.length
    const end = input?.selectionEnd ?? value.length
    updatePlan({ [key]: value.slice(0, start) + text + value.slice(end) })
    // The caret goes behind what was inserted, once React wrote the value.
    requestAnimationFrame(() => {
      input?.focus()
      input?.setSelectionRange(start + text.length, start + text.length)
    })
  }
  const counts = d.counts
  const canStart = !d.busy && d.problem === null && counts !== null && counts.renamed > 0

  return (
    <form
      className="flex flex-col gap-3 text-xs"
      data-testid="multi-rename-dialog"
      onSubmit={(e) => {
        e.preventDefault()
        if (canStart) void startMultiRename()
      }}
    >
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-3">
        <MaskField
          label={t("Name mask")}
          value={plan.nameMask}
          error={problem("nameMask")}
          autoFocus
          inputRef={(el) => {
            masks.current.nameMask = el
          }}
          onFocus={() => {
            target.current = "nameMask"
          }}
          onChange={(nameMask) => updatePlan({ nameMask })}
        />
        <MaskField
          label={t("Extension mask")}
          value={plan.extMask}
          error={problem("extMask")}
          inputRef={(el) => {
            masks.current.extMask = el
          }}
          onFocus={() => {
            target.current = "extMask"
          }}
          onChange={(extMask) => updatePlan({ extMask })}
        />
      </div>
      <div
        className="flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label={t("Placeholders")}
      >
        {PLACEHOLDERS.map((p) => (
          <Button key={p.text} size="sm" title={t(p.label)} onClick={() => insert(p.text)}>
            <span className="font-mono">{p.text}</span>
          </Button>
        ))}
        <span className="text-muted">
          {t(
            "[N2-5] takes characters 2 to 5; [C10+2:3] counts from 10 in steps of 2 with 3 digits.",
          )}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-muted">{t("Search for")}</span>
          <input
            aria-label={t("Search for")}
            aria-invalid={problem("search") !== null}
            className={field}
            value={plan.search}
            spellCheck={false}
            onChange={(e) => updatePlan({ search: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted">{t("Replace with")}</span>
          <input
            aria-label={t("Replace with")}
            className={field}
            value={plan.replace}
            spellCheck={false}
            onChange={(e) => updatePlan({ replace: e.target.value })}
          />
        </label>
      </div>
      {problem("search") && (
        <p role="alert" className="-mt-2 text-danger">
          {t("The expression can't be used: {reason}", { reason: problem("search")! })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Check
          label={t("Regular expression")}
          checked={plan.regex}
          onChange={(regex) => updatePlan({ regex })}
        />
        <Check
          label={t("Match case")}
          checked={plan.matchCase}
          onChange={(matchCase) => updatePlan({ matchCase })}
        />
        <label className="flex items-center gap-2">
          <span className="text-muted">{t("Case")}</span>
          <select
            aria-label={t("Case")}
            className={`${field} w-auto`}
            value={plan.case}
            onChange={(e) => updatePlan({ case: e.target.value as RenamePlan["case"] })}
          >
            {CASES.map((c) => (
              <option key={c.value} value={c.value}>
                {t(c.label)}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="flex items-center gap-2">
          <legend className="sr-only">{t("Counter")}</legend>
          <span className="text-muted" aria-hidden="true">
            {t("Counter")}
          </span>
          <NumberField
            label={t("Start at")}
            value={plan.start}
            invalid={problem("counter") !== null}
            onChange={(start) => updatePlan({ start })}
          />
          <NumberField
            label={t("Step")}
            value={plan.step}
            onChange={(step) => updatePlan({ step })}
          />
          <NumberField
            label={t("Digits")}
            value={plan.digits}
            min={1}
            max={10}
            onChange={(digits) => updatePlan({ digits })}
          />
        </fieldset>
      </div>
      <PreviewTable d={d} />
      {d.error && (
        <p role="alert" className="text-danger">
          {d.error}
        </p>
      )}
      <div className="flex items-center gap-2">
        {d.undo && (
          <Button
            onClick={() => void undoMultiRename()}
            title={t("Takes back the last multi-rename: {count} in {folder}", {
              count: formatCount(d.undo.count),
              folder: d.undo.dir,
            })}
          >
            {t("Undo last")}
          </Button>
        )}
        <span className="flex-1" />
        <Button onClick={closeMultiRename}>{t("Cancel")}</Button>
        <Button type="submit" variant="primary" disabled={!canStart}>
          {t("Start")}
        </Button>
      </div>
    </form>
  )
}

function MaskField({
  label,
  value,
  error,
  autoFocus,
  inputRef,
  onFocus,
  onChange,
}: {
  label: string
  value: string
  error: string | null
  autoFocus?: boolean
  inputRef(el: HTMLInputElement | null): void
  onFocus(): void
  onChange(value: string): void
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted">{label}</span>
      <input
        ref={inputRef}
        aria-label={label}
        aria-invalid={error !== null}
        className={`${field} font-mono`}
        value={value}
        autoFocus={autoFocus}
        spellCheck={false}
        onFocus={onFocus}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && (
        <span role="alert" className="text-danger">
          {t("The mask can't be used: {reason}", { reason: error })}
        </span>
      )}
    </label>
  )
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange(checked: boolean): void
}) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

/**
 * A whole number. What is typed stays in the field while it is not a number
 * yet ("", "-"), and the plan keeps its last value.
 */
function NumberField({
  label,
  value,
  min,
  max,
  invalid = false,
  onChange,
}: {
  label: string
  value: number
  min?: number
  max?: number
  invalid?: boolean
  onChange(value: number): void
}) {
  const [text, setText] = useState(String(value))
  const shown = Number.parseInt(text, 10) === value || !/\d/.test(text) ? text : String(value)
  return (
    <label className="flex items-center gap-1">
      <span>{label}</span>
      <input
        type="number"
        aria-label={label}
        aria-invalid={invalid}
        className={`${field} w-16 tabular-nums`}
        value={shown}
        min={min}
        max={max}
        onChange={(e) => {
          setText(e.target.value)
          const n = Number.parseInt(e.target.value, 10)
          if (Number.isSafeInteger(n)) onChange(n)
        }}
      />
    </label>
  )
}

/** What the batch comes to, as one sentence. */
function summary(d: RenameDialogState): string {
  const c = d.counts
  if (!c) return t("Reading the names…")
  const parts = [
    t("{renamed} of {total, plural, one {# name} other {# names}} will change", {
      renamed: formatCount(c.renamed),
      total: c.total,
    }),
  ]
  if (c.conflicts > 0)
    parts.push(
      t("{count, plural, one {# name is} other {# names are}} not free", { count: c.conflicts }),
    )
  if (c.invalid > 0)
    parts.push(
      t("{count, plural, one {# name is} other {# names are}} invalid", { count: c.invalid }),
    )
  return parts.join(" · ")
}

/**
 * Old and new names, virtualized: only the rows in view are mounted, and
 * only their pages are asked of Go. Rows of the plan before the current one
 * stay (dimmed) until they are named again.
 */
function PreviewTable({ d }: { d: RenameDialogState }) {
  const scroll = useRef<HTMLDivElement>(null)
  const total = d.counts?.total ?? 0
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
    if (last >= first) showPreviewRows(first, last)
  }, [first, last])
  const problems = d.counts ? d.counts.conflicts + d.counts.invalid : 0

  return (
    <div className="flex flex-col gap-1">
      <div className={`${COLUMNS} px-2 text-muted`} aria-hidden="true">
        <span>{t("Old name")}</span>
        <span />
        <span>{t("New name")}</span>
        <span />
      </div>
      <div
        ref={scroll}
        role="table"
        aria-label={t("Preview")}
        aria-rowcount={total}
        tabIndex={0}
        data-testid="rename-preview"
        className="h-64 overflow-auto rounded-md border border-border bg-canvas outline-none focus-visible:border-accent"
      >
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((v) => {
            const row = previewRow(v.index)
            return (
              <div
                key={v.index}
                role="row"
                aria-rowindex={v.index + 1}
                className={`${COLUMNS} absolute inset-x-0 px-2 ${previewRowCurrent(v.index) ? "" : "opacity-60"}`}
                style={{ top: v.start, height: ROW_HEIGHT }}
              >
                {row && <PreviewCells row={row} />}
              </div>
            )
          })}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span role="status" aria-live="polite" data-testid="rename-summary">
          {summary(d)}
        </span>
        {problems > 0 && d.counts && d.counts.firstProblem >= 0 && (
          <Button
            size="sm"
            onClick={() => {
              virtualizer.scrollToIndex(d.counts!.firstProblem, { align: "start" })
              scroll.current?.focus()
            }}
          >
            {t("Show the first one")}
          </Button>
        )}
      </div>
    </div>
  )
}

function PreviewCells({ row }: { row: RenamePreviewRow }) {
  const status = statusOf(row)
  return (
    <>
      <span role="cell" className="truncate text-muted">
        {row.name}
      </span>
      <span aria-hidden="true" className="text-muted">
        →
      </span>
      <span
        role="cell"
        className={`truncate ${row.status === "unchanged" ? "text-muted" : status.tone}`}
      >
        {row.newName}
      </span>
      <span role="cell" className={`truncate ${status.tone}`} title={status.detail}>
        {status.label}
      </span>
    </>
  )
}
