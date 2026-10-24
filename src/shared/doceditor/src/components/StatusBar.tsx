import { perLocale, t } from "@panelyth/i18n"
import { useStore } from "../store"
import { encodingLabel, lineEndingLabel, lineEndingName } from "../text/decode"
import type { Workspace } from "../workspace"

const numbers = perLocale((locale) => new Intl.NumberFormat(locale))
const fmt = (n: number): string => numbers().format(n)

function Cursor({ workspace }: { workspace: Workspace }) {
  const line = useStore(workspace.status.cursor, (s) => s.line)
  const column = useStore(workspace.status.cursor, (s) => s.column)
  const selected = useStore(workspace.status.cursor, (s) => s.selected)
  const ranges = useStore(workspace.status.cursor, (s) => s.ranges)
  return (
    <span data-testid="status-cursor" className="prose-nums">
      {t("Ln {line}, Col {column}", { line: fmt(line), column: fmt(column) })}
      {selected > 0 && ` · ${t("{count} selected", { count: fmt(selected) })}`}
      {ranges > 1 &&
        ` · ${t("{count, plural, one {# cursor} other {# cursors}}", { count: ranges })}`}
    </span>
  )
}

function Counts({ workspace }: { workspace: Workspace }) {
  const counts = useStore(workspace.status.count, (s) => s.counts)
  const ofSelection = useStore(workspace.status.count, (s) => s.ofSelection)
  if (!counts) return null
  const text = [
    t("{count, plural, one {# word} other {# words}}", { count: counts.words }),
    t("{count, plural, one {# character} other {# characters}}", { count: counts.characters }),
    t("{count, plural, one {# line} other {# lines}}", { count: counts.lines }),
  ].join(" · ")
  return (
    <span
      data-testid="status-counts"
      className="prose-nums"
      title={ofSelection ? t("Counts of the selection") : t("Counts of the document")}
    >
      {ofSelection ? t("Selection: {counts}", { counts: text }) : text}
    </span>
  )
}

function Notice({ workspace }: { workspace: Workspace }) {
  const notice = useStore(workspace.controller.store, (s) => s.notice)
  const diskChanged = useStore(workspace.controller.store, (s) => s.diskChanged)
  const dirty = useStore(workspace.controller.store, (s) => s.dirty)
  const picture = useStore(workspace.chrome, (s) => s.picture)
  const exporting = useStore(workspace.chrome, (s) => s.exporting)
  if (notice) {
    return (
      <span
        key={notice.id}
        role={notice.tone === "error" ? "alert" : "status"}
        data-testid="status-notice"
        data-tone={notice.tone}
        className={`flex min-w-0 items-center gap-1.5 ${notice.tone === "error" ? "text-danger" : "text-success"}`}
      >
        <span className="truncate" title={notice.text}>
          {notice.text}
        </span>
        {notice.tone === "error" && (
          <button
            type="button"
            className="shrink-0 rounded px-1 text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
            aria-label={t("Dismiss")}
            onClick={() => workspace.controller.store.set({ notice: null })}
          >
            ×
          </button>
        )}
      </span>
    )
  }
  if (exporting !== "idle") {
    return (
      <span
        role="status"
        className="flex min-w-0 items-center gap-1.5 text-text"
        data-testid="status-export"
      >
        <span className="truncate">{t("Exporting…")}</span>
        {/* Only while the print view is built: once main prints, it cannot be stopped. */}
        {exporting === "building" && (
          <button
            type="button"
            className="shrink-0 rounded px-1 text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
            onClick={() => workspace.cancelExport()}
            data-testid="export-cancel"
          >
            {t("Cancel")}
          </button>
        )}
      </span>
    )
  }
  if (picture) {
    return (
      <span role="status" className="truncate text-text" data-testid="status-picture">
        {t("Adding {name}… {percent}%", {
          name: picture.name,
          percent: Math.round((picture.sent / Math.max(1, picture.total)) * 100),
        })}
      </span>
    )
  }
  // With unsaved changes a change on disk is only noted: the next save asks.
  if (diskChanged && dirty) {
    return (
      <span className="truncate text-warning" data-testid="status-disk">
        {t("Changed on disk")}
      </span>
    )
  }
  return null
}

/** The bottom line: cursor, counts, a notice, then the file's encoding, line endings and language. */
export function StatusBar({ workspace }: { workspace: Workspace }) {
  const encoding = useStore(workspace.controller.store, (s) => s.encoding)
  const bom = useStore(workspace.controller.store, (s) => s.bom)
  const lineEnding = useStore(workspace.controller.store, (s) => s.lineEnding)
  const language = useStore(workspace.chrome, (s) => s.language)
  const languageKnown = useStore(workspace.chrome, (s) => s.languageKnown)
  return (
    <footer
      aria-label={t("Status bar")}
      className="flex h-7 shrink-0 items-center gap-4 border-t border-border bg-chrome px-3 text-2xs text-muted"
    >
      <Cursor workspace={workspace} />
      <Counts workspace={workspace} />
      <div className="flex min-w-0 flex-1 justify-end">
        <Notice workspace={workspace} />
      </div>
      <span data-testid="status-encoding">{encodingLabel(encoding, bom)}</span>
      <span data-testid="status-eol" title={lineEndingName(lineEnding)}>
        {lineEndingLabel(lineEnding)}
      </span>
      <span data-testid="status-language">
        {languageKnown ? (language ?? t("Plain text")) : ""}
      </span>
    </footer>
  )
}
