import { t } from "@panelyth/i18n"
import { Button, useTitleBarShown } from "@panelyth/ui"
import type { KeyboardEvent } from "react"
import { VIEW_MODE_LABELS, VIEW_MODES, type ViewMode } from "../editor/modes"
import { useStore } from "../store"
import type { Workspace } from "../workspace"

const MOD =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+"

/** Source, Live, Preview: a radio group (arrow keys move, Ctrl+E steps). Markdown only. */
function ModeSwitch({ workspace }: { workspace: Workspace }) {
  const mode = useStore(workspace.chrome, (s) => s.mode)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0
    if (step === 0) return
    e.preventDefault()
    const i = (VIEW_MODES.indexOf(mode) + step + VIEW_MODES.length) % VIEW_MODES.length
    const next: ViewMode = VIEW_MODES[i]!
    void workspace.setMode(next)
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={t("View")}
      title={`${t("View")} (${MOD}E)`}
      data-testid="mode-switch"
      className="flex h-7 shrink-0 items-center rounded-md border border-border bg-raised p-0.5"
      onKeyDown={onKeyDown}
    >
      {VIEW_MODES.map((m) => (
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={mode === m}
          tabIndex={mode === m ? 0 : -1}
          data-mode={m}
          data-testid={`mode-${m}`}
          onClick={() => void workspace.setMode(m)}
          className="h-full rounded px-2.5 text-xs text-muted hover:text-text focus-visible:outline-2 focus-visible:outline-accent aria-checked:bg-canvas aria-checked:text-text aria-checked:shadow-sm"
        >
          {t(VIEW_MODE_LABELS[m])}
        </button>
      ))}
    </div>
  )
}

/** The window's top line: the file's name (a dot while unsaved), the view, Find, Wrap and Save. */
export function Header({ workspace }: { workspace: Workspace }) {
  const { controller, chrome, session } = workspace
  const dirty = useStore(controller.store, (s) => s.dirty)
  const saving = useStore(controller.store, (s) => s.saving)
  const wrap = useStore(chrome, (s) => s.wrap)
  const markdown = useStore(chrome, (s) => s.markdown)
  const mode = useStore(chrome, (s) => s.mode)
  const readOnly = useStore(chrome, (s) => s.readOnly)
  const exporting = useStore(chrome, (s) => s.exporting !== "idle")
  const stripShown = useTitleBarShown()
  return (
    <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-chrome px-3">
      <h1 className="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium">
        {/* The title strip names the file when it is shown (Windows); else the header does. */}
        <span className={stripShown ? "sr-only" : "truncate"} data-testid="file-name">
          {session.name}
        </span>
        {readOnly && (
          <span
            data-testid="readonly-mark"
            className="shrink-0 rounded border border-border px-1.5 py-px text-2xs font-normal text-muted"
          >
            {t("Read-only")}
          </span>
        )}
        {dirty && (
          <span
            data-testid="dirty-dot"
            role="img"
            aria-label={t("Unsaved changes")}
            className="inline-block size-2 shrink-0 rounded-full bg-accent"
          />
        )}
      </h1>
      {markdown && <ModeSwitch workspace={workspace} />}
      <Button
        variant="toolbar"
        size="sm"
        title={`${t("Find and replace")} (${MOD}F)`}
        onClick={() => workspace.openFind()}
      >
        {t("Find")}
      </Button>
      {/* Live wraps like a page and Preview is a page: the toggle is Source's. */}
      <Button
        variant="toolbar"
        size="sm"
        aria-pressed={wrap}
        disabled={mode !== "source"}
        title={`${t("Word wrap")} (Alt+Z)`}
        onClick={() => workspace.toggleWrap()}
      >
        {t("Wrap")}
      </Button>
      {/* Every file type, read-only windows too. */}
      <Button
        variant="toolbar"
        size="sm"
        disabled={exporting}
        title={`${t("Export PDF")} (${MOD}Shift+E)`}
        onClick={() => workspace.openExport()}
        data-testid="export-pdf"
      >
        {t("Export PDF")}
      </Button>
      {readOnly ? (
        <Button
          variant="primary"
          size="sm"
          title={t("Edit (F4)")}
          onClick={() => workspace.startEditing()}
          data-testid="edit"
        >
          {t("Edit")}
        </Button>
      ) : (
        <Button
          variant="primary"
          size="sm"
          disabled={saving}
          title={`${t("Save")} (${MOD}S)`}
          onClick={() => workspace.save()}
          data-testid="save"
        >
          {saving ? t("Saving…") : t("Save")}
        </Button>
      )}
    </header>
  )
}
