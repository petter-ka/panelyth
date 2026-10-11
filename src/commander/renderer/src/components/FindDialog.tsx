import { FIND_ENCODINGS } from "@panelyth/contracts"
import { usePageItem } from "@panelyth/renderer-core"
import { Button, DialogWindow } from "@panelyth/ui"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react"
import {
  closeFind,
  feedToPanel,
  FIND_ATTRS,
  goToResult,
  isRunning,
  moveResultCursor,
  newSearch,
  resultsStore,
  setFindTab,
  startSearch,
  stopSearch,
  updateForm,
  useFindStore,
  type AttrRule,
  type FindAttr,
  type FindForm,
  type FindTab,
  type SizeUnit,
} from "../features/find"
import { formatCount, formatSize } from "../features/format"
import { useSettingsStore } from "../features/settings"
import { msg, t } from "@panelyth/i18n"

const field =
  "h-8 w-full rounded-md border border-border bg-canvas px-2 text-xs text-text outline-none focus:border-accent"

const ROW_HEIGHT = 22
const PAGE_ROWS = 12

const TABS: { id: FindTab; label: string }[] = [
  { id: "general", label: msg("General") },
  { id: "advanced", label: msg("Advanced") },
  { id: "results", label: msg("Results") },
]

const DEPTHS: { value: number; label: string }[] = [
  { value: -1, label: msg("All subfolders") },
  { value: 0, label: msg("Only these folders") },
  { value: 1, label: msg("1 level") },
  { value: 2, label: msg("2 levels") },
  { value: 3, label: msg("3 levels") },
  { value: 5, label: msg("5 levels") },
  { value: 10, label: msg("10 levels") },
]

const ENCODING_LABEL: Record<FindForm["encoding"], string> = {
  auto: msg("Auto (UTF-8, UTF-16, Windows-1252)"),
  "utf-8": "UTF-8",
  "utf-16le": "UTF-16 LE",
  "utf-16be": "UTF-16 BE",
  "windows-1252": msg("Windows-1252 (Western)"),
  "windows-1250": msg("Windows-1250 (Central European)"),
  "windows-1251": msg("Windows-1251 (Cyrillic)"),
  "iso-8859-2": "ISO-8859-2",
  "koi8-r": "KOI8-R",
}

const ATTR_LABEL: Record<FindAttr, string> = {
  readOnly: msg("Read-only"),
  hidden: msg("Hidden"),
  system: msg("System"),
  archive: msg("Archive"),
  executable: msg("Executable"),
}

/** Alt+F7 (UX-DESIGN "Find files"): General, Advanced and Results tabs. */
export function FindDialog() {
  const dialog = useFindStore((s) => s.dialog)
  const tab = useFindStore((s) => s.tab)
  const error = useFindStore((s) => s.error)
  const hasRun = useFindStore((s) => s.run !== null)
  if (!dialog) return null
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) closeFind()
      }}
      title={t("Find files")}
      contentClassName="w-[min(44rem,calc(100vw-2rem))]"
    >
      <div className="flex flex-col gap-3 text-xs" data-testid="find-dialog">
        <div
          role="tablist"
          aria-label={t("Find files")}
          className="flex gap-1 border-b border-border"
        >
          {TABS.map((tabDef) => (
            <button
              key={tabDef.id}
              type="button"
              role="tab"
              id={`find-tab-${tabDef.id}`}
              aria-selected={tab === tabDef.id}
              aria-controls={`find-panel-${tabDef.id}`}
              disabled={tabDef.id === "results" && !hasRun}
              onClick={() => setFindTab(tabDef.id)}
              className={`-mb-px border-b-2 px-3 py-1.5 disabled:opacity-40 ${tab === tabDef.id ? "border-accent text-text" : "border-transparent text-muted hover:text-text"}`}
            >
              {t(tabDef.label)}
            </button>
          ))}
        </div>
        {tab === "results" ? (
          <ResultsTab />
        ) : (
          <form
            id={`find-panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`find-tab-${tab}`}
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void startSearch()
            }}
          >
            {tab === "general" ? <GeneralTab /> : <AdvancedTab />}
            {error && (
              <p role="alert" className="text-danger">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button onClick={closeFind}>{t("Cancel")}</Button>
              <Button type="submit" variant="primary">
                {t("Start search")}
              </Button>
            </div>
          </form>
        )}
      </div>
    </DialogWindow>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="text-muted">{label}</span>
      {children}
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

function GeneralTab() {
  const form = useFindStore((s) => s.form)
  const history = useFindStore((s) => s.history)
  const hasText = form.text !== ""
  return (
    <>
      <Field label={t("Search for")}>
        <input
          aria-label={t("Search for")}
          className={field}
          value={form.mask}
          list="find-mask-history"
          spellCheck={false}
          onChange={(e) => updateForm({ mask: e.target.value })}
          onFocus={(e) => e.target.select()}
          autoFocus
        />
      </Field>
      <datalist id="find-mask-history">
        {history.masks.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      <p className="-mt-2 text-muted">
        Masks separated by ; — exclusions after |, e.g. *.log|old\ (a trailing \ excludes folders)
      </p>
      <div className="flex gap-3">
        <Field label={t("Search in")}>
          <input
            aria-label={t("Search in")}
            className={field}
            value={form.roots}
            spellCheck={false}
            onChange={(e) => updateForm({ roots: e.target.value })}
          />
        </Field>
        <div className="w-40">
          <Field label={t("Depth")}>
            <select
              aria-label={t("Depth")}
              className={field}
              value={form.depth}
              onChange={(e) => updateForm({ depth: Number(e.target.value) })}
            >
              {DEPTHS.map((d) => (
                <option key={d.value} value={d.value}>
                  {t(d.label)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      <Check
        label={t("Search hidden and system files")}
        checked={form.hidden}
        onChange={(hidden) => updateForm({ hidden })}
      />
      <Field label={t("Find text")}>
        <input
          aria-label={t("Find text")}
          className={field}
          value={form.text}
          list="find-text-history"
          spellCheck={false}
          onChange={(e) => updateForm({ text: e.target.value })}
        />
      </Field>
      <datalist id="find-text-history">
        {history.texts.map((text) => (
          <option key={text} value={text} />
        ))}
      </datalist>
      <fieldset
        disabled={!hasText}
        className="flex flex-wrap items-center gap-x-4 gap-y-2 disabled:opacity-50"
      >
        <Check
          label={t("Case sensitive")}
          checked={form.caseSensitive}
          onChange={(caseSensitive) => updateForm({ caseSensitive })}
        />
        <Check
          label={t("Whole words")}
          checked={form.wholeWords}
          onChange={(wholeWords) => updateForm({ wholeWords })}
        />
        <Check
          label={t("Skip binary files")}
          checked={form.skipBinary}
          onChange={(skipBinary) => updateForm({ skipBinary })}
        />
        <label className="flex items-center gap-2">
          <span className="text-muted">{t("Encoding")}</span>
          <select
            aria-label={t("Encoding")}
            className={`${field} w-auto`}
            value={form.encoding}
            onChange={(e) => updateForm({ encoding: e.target.value as FindForm["encoding"] })}
          >
            {(["auto", ...FIND_ENCODINGS] as const).map((enc) => (
              <option key={enc} value={enc}>
                {t(ENCODING_LABEL[enc])}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
    </>
  )
}

function AdvancedTab() {
  const form = useFindStore((s) => s.form)
  return (
    <>
      <div className="flex items-end gap-3">
        <Field label={t("Size at least")}>
          <input
            aria-label={t("Size at least")}
            inputMode="decimal"
            className={field}
            value={form.minSize}
            onChange={(e) => updateForm({ minSize: e.target.value })}
          />
        </Field>
        <Field label={t("Size at most")}>
          <input
            aria-label={t("Size at most")}
            inputMode="decimal"
            className={field}
            value={form.maxSize}
            onChange={(e) => updateForm({ maxSize: e.target.value })}
          />
        </Field>
        <div className="w-24">
          <Field label={t("Unit")}>
            <select
              aria-label={t("Size unit")}
              className={field}
              value={form.sizeUnit}
              onChange={(e) => updateForm({ sizeUnit: e.target.value as SizeUnit })}
            >
              {(["B", "KB", "MB", "GB"] as const).map((u) => (
                <option key={u}>{u}</option>
              ))}
            </select>
          </Field>
        </div>
      </div>
      <div className="flex gap-3">
        <Field label={t("Modified from")}>
          <input
            type="date"
            aria-label={t("Modified from")}
            className={field}
            value={form.after}
            onChange={(e) => updateForm({ after: e.target.value })}
          />
        </Field>
        <Field label={t("Modified until")}>
          <input
            type="date"
            aria-label={t("Modified until")}
            className={field}
            value={form.before}
            onChange={(e) => updateForm({ before: e.target.value })}
          />
        </Field>
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-muted">{t("Attributes")}</legend>
        {FIND_ATTRS.map((attr) => (
          <label key={attr} className="flex items-center gap-2">
            <span className="w-24">{t(ATTR_LABEL[attr])}</span>
            <select
              aria-label={t(ATTR_LABEL[attr])}
              className={`${field} w-40`}
              value={form.attrs[attr]}
              onChange={(e) =>
                updateForm({ attrs: { ...form.attrs, [attr]: e.target.value as AttrRule } })
              }
            >
              <option value="any">{t("Any")}</option>
              <option value="set">{t("Set")}</option>
              <option value="clear">{t("Not set")}</option>
            </select>
          </label>
        ))}
      </fieldset>
    </>
  )
}

function ResultsTab() {
  const run = useFindStore((s) => s.run)
  const progress = useFindStore((s) => s.progress)
  const running = useFindStore(isRunning)
  const cursor = useFindStore((s) => s.cursor)
  const error = useFindStore((s) => s.error)
  const scroll = useRef<HTMLDivElement>(null)
  const total = run?.total ?? 0
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
    if (last >= first) resultsStore.setRange(first, last)
  }, [first, last])
  useEffect(() => {
    if (total > 0) virtualizer.scrollToIndex(cursor)
  }, [cursor, total, virtualizer])
  useEffect(() => scroll.current?.focus(), [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step: Record<string, number> = {
      ArrowDown: 1,
      ArrowUp: -1,
      PageDown: PAGE_ROWS,
      PageUp: -PAGE_ROWS,
      Home: -Infinity,
      End: Infinity,
    }
    if (e.key in step) {
      e.preventDefault()
      const by = step[e.key]!
      moveResultCursor(Number.isFinite(by) ? cursor + by : by > 0 ? total - 1 : 0)
    } else if (e.key === "Enter" && total > 0) {
      e.preventDefault()
      void goToResult(cursor)
    }
  }

  return (
    <div
      id="find-panel-results"
      role="tabpanel"
      aria-labelledby="find-tab-results"
      className="flex flex-col gap-2"
    >
      <p aria-live="polite" className="truncate text-muted" data-testid="find-status">
        {statusText(running, total, progress)}
      </p>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <div
        ref={scroll}
        role="listbox"
        aria-label={t("Search results")}
        tabIndex={0}
        aria-activedescendant={total > 0 ? `find-result-${cursor}` : undefined}
        onKeyDown={onKeyDown}
        className="relative h-72 overflow-auto rounded-md border border-border bg-canvas outline-none focus:border-accent"
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((v) => (
            <ResultRow key={v.key} index={v.index} start={v.start} cursor={v.index === cursor} />
          ))}
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={newSearch}>{t("New search")}</Button>
        <Button onClick={stopSearch} disabled={!running}>
          {t("Stop")}
        </Button>
        <Button onClick={() => void goToResult(cursor)} disabled={total === 0}>
          {t("Go to file")}
        </Button>
        <Button variant="primary" onClick={() => void feedToPanel()} disabled={total === 0}>
          {t("Feed to panel")}
        </Button>
      </div>
    </div>
  )
}

function statusText(
  running: boolean,
  total: number,
  progress: ReturnType<typeof useFindStore.getState>["progress"],
): string {
  // Go's count leads: the list follows with the next (debounced) session refresh.
  const found = t("{count} found", { count: formatCount(Math.max(total, progress?.matches ?? 0)) })
  if (!progress) return running ? t("Searching… {found}", { found }) : found
  const scanned = t("{count, plural, one {# folder} other {# folders}}", { count: progress.dirs })
  const errors =
    progress.errors > 0 ? t(", {count} not readable", { count: formatCount(progress.errors) }) : ""
  if (running) {
    return t("Searching {current} — {found} in {scanned}{errors}", {
      current: progress.current || "…",
      found,
      scanned,
      errors,
    })
  }
  const end =
    progress.state === "cancelled"
      ? t("Stopped")
      : progress.state === "failed"
        ? t("Failed")
        : progress.truncated
          ? t("Stopped at the result limit")
          : t("Done")
  return t("{end}: {found} in {scanned}{errors} ({seconds} s)", {
    end,
    found,
    scanned,
    errors,
    seconds: (progress.elapsedMs / 1000).toFixed(1),
  })
}

function ResultRow({ index, start, cursor }: { index: number; start: number; cursor: boolean }) {
  const item = usePageItem(resultsStore, index)
  const sizeFormat = useSettingsStore((s) => s.settings.sizeFormat)
  return (
    <div
      id={`find-result-${index}`}
      role="option"
      aria-selected={cursor}
      onClick={() => moveResultCursor(index)}
      onDoubleClick={() => void goToResult(index)}
      style={{ position: "absolute", top: start, height: ROW_HEIGHT, left: 0, right: 0 }}
      className={`flex items-center gap-2 px-2 ${cursor ? "bg-accent/20 text-text" : "hover:bg-raised"}`}
    >
      {item ? (
        <>
          <span className="min-w-0 flex-1 truncate">
            <span className="text-muted">{item.dirPath ? withSeparator(item.dirPath) : ""}</span>
            {item.name}
          </span>
          <span className="shrink-0 text-muted tabular-nums">{formatSize(item, sizeFormat)}</span>
        </>
      ) : (
        <span className="h-2 w-1/2 rounded bg-skeleton" />
      )}
    </div>
  )
}

const withSeparator = (dir: string): string =>
  /[\\/]$/.test(dir) ? dir : dir + (dir.includes("\\") ? "\\" : "/")
