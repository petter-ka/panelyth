// Saving from the editor (Stage 12, ADR-0035): a split button for the three
// targets, the save options, the confirmation before the original is
// replaced and the prompt for unsaved changes. A save is a job in Go; these
// controls start it and show what it reports.
import { useEffect, useState } from "react"
import {
  MAX_DPI,
  MAX_JPEG_QUALITY,
  MIN_JPEG_QUALITY,
  SAVE_FORMATS,
  type MetadataPolicy,
  type SaveFormat,
  type SaveTarget,
} from "@panelyth/contracts"
import { Button, DialogWindow, Spinner, Tooltip } from "@panelyth/ui"
import { t } from "@panelyth/i18n"
import { useEditorSettings } from "../../features/editor/editorSettings"
import {
  cancelClose,
  cancelSave,
  closeEditorNow,
  dismissSave,
  refreshEstimate,
  revealSaved,
  save,
  setSaveOptions,
  useEditorStore,
} from "../../features/editor/editorStore"
import { formatBytes } from "../../lib/format"
import { ChevronDownIcon } from "../ui/icons"
import {
  DropdownContent,
  DropdownItem,
  DropdownRoot,
  DropdownSeparator,
  DropdownTrigger,
} from "../ui/menu"
import { NumberField, Select, Slider } from "./controls"

export function targetLabel(target: SaveTarget): string {
  switch (target) {
    case "copy":
      return t("Save a copy")
    case "as":
      return t("Save as…")
    case "replace":
      return t("Replace original")
  }
}

function formatName(format: SaveFormat): string {
  return format === "jpeg" ? "JPEG" : format.toUpperCase()
}

/** What a format cannot carry, said before saving. */
function formatNote(format: SaveFormat, hasAlpha: boolean): string | null {
  switch (format) {
    case "jpeg":
      return hasAlpha
        ? t(
            "JPEG has no transparency: transparent areas become white. Each JPEG save loses a little quality; PNG does not.",
          )
        : t("Each JPEG save loses a little quality; PNG does not.")
    case "gif":
      return t("GIF holds 256 colors, no transparency here and no camera data.")
    case "bmp":
      return t("BMP holds no camera data, color profile or transparency.")
    case "tiff":
      return t("TIFF keeps the color profile and the resolution, not the camera data.")
    case "png":
      return null
  }
}

function SaveOptionsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const session = useEditorStore((s) => s.session)
  const options = useEditorStore((s) => s.saveOptions)
  const estimate = useEditorStore((s) => s.estimate)
  const output = useEditorStore((s) => s.output)
  const defaults = useEditorSettings((s) => s.settings)
  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => void refreshEstimate(), 250)
    return () => clearTimeout(timer)
  }, [open, options])
  if (!session) return null
  const note = formatNote(options.format, session.hasAlpha)
  return (
    <DialogWindow
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("Save options")}
      contentClassName="w-[min(24rem,calc(100vw-2rem))]"
    >
      <div className="space-y-3 p-4" data-testid="save-options">
        <Select<SaveFormat>
          label={t("Format")}
          value={options.format}
          options={SAVE_FORMATS.map((f) => ({ value: f, label: formatName(f) }))}
          onChange={(format) => setSaveOptions({ format })}
        />
        {options.format === "jpeg" && (
          <Slider
            label={t("Quality")}
            value={options.quality}
            min={MIN_JPEG_QUALITY}
            max={MAX_JPEG_QUALITY}
            defaultValue={defaults.jpegQuality}
            onChange={(quality) => setSaveOptions({ quality })}
          />
        )}
        {note && <p className="text-[0.6875rem] text-muted">{note}</p>}
        {session.format === "webp" && (
          <p className="text-[0.6875rem] text-muted">
            {t("WebP can't be written, so this picture is saved as PNG or JPEG.")}
          </p>
        )}
        <Select<MetadataPolicy>
          label={t("Camera data (EXIF)")}
          value={options.metadata}
          options={[
            { value: "keep", label: t("Keep") },
            { value: "stripGps", label: t("Remove location only") },
            { value: "strip", label: t("Remove all") },
          ]}
          onChange={(metadata) => setSaveOptions({ metadata })}
        />
        <NumberField
          label={t("Resolution (0 keeps the picture's)")}
          value={options.dpi}
          min={0}
          max={MAX_DPI}
          unit="dpi"
          disabled={options.format === "gif"}
          onChange={(dpi) => setSaveOptions({ dpi })}
        />
        <p className="text-xs" data-testid="save-estimate" aria-live="polite">
          {output && `${output.width} × ${output.height} px · `}
          {estimate === null ? "…" : t("about {size}", { size: formatBytes(estimate) })}
        </p>
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            {t("Done")}
          </Button>
        </div>
      </div>
    </DialogWindow>
  )
}

/** The Save split button with its state: saving, saved, failed. */
export function SaveControls() {
  const session = useEditorStore((s) => s.session)
  const state = useEditorStore((s) => s.save)
  const format = useEditorStore((s) => s.saveOptions.format)
  const ready = useEditorStore((s) => s.status === "ready")
  const preferred = useEditorSettings((s) => s.settings.saveTarget)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [confirmReplace, setConfirmReplace] = useState(false)
  const canReplace = session?.canReplace ?? false
  // Where there is no trash, "Replace" is not offered: the default falls back to a copy.
  const main: SaveTarget = preferred === "replace" && !canReplace ? "copy" : preferred
  const start = (target: SaveTarget): void => {
    if (target === "replace") setConfirmReplace(true)
    else void save(target)
  }
  // A dialog opened from the menu waits until the menu has closed and given
  // the focus back; otherwise the two fight over it.
  const afterMenu = (open: () => void): void => void setTimeout(open, 0)
  const saving = state.state === "saving"
  return (
    <div className="flex items-center gap-1.5" data-testid="save-controls" data-save={state.state}>
      {saving && (
        <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted" role="status">
          <Spinner size={12} />
          <span className="max-w-40 truncate">
            {state.name ? t("Saving {name}…", { name: state.name }) : t("Saving…")}
          </span>
          <button
            type="button"
            className="underline-offset-2 hover:text-text hover:underline"
            onClick={cancelSave}
          >
            {t("Cancel")}
          </button>
        </span>
      )}
      {state.state === "done" && (
        <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted" role="status">
          <span className="max-w-40 truncate" data-testid="save-done">
            {t("Saved as {name}", { name: state.name })}
          </span>
          <button
            type="button"
            className="underline-offset-2 hover:text-text hover:underline"
            onClick={revealSaved}
          >
            {t("Show in folder")}
          </button>
        </span>
      )}
      {state.state === "failed" && (
        <span className="flex items-center gap-1.5 text-[0.6875rem] text-danger" role="alert">
          <Tooltip content={state.error}>
            <span className="max-w-64 truncate" data-testid="save-error">
              {state.error}
            </span>
          </Tooltip>
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            aria-label={t("Dismiss the message")}
            onClick={dismissSave}
          >
            ×
          </button>
        </span>
      )}
      <div className="flex">
        <Button
          size="sm"
          variant="primary"
          className="rounded-r-none"
          disabled={!ready || saving}
          onClick={() => start(main)}
          data-testid="save-main"
        >
          {targetLabel(main)}
        </Button>
        <DropdownRoot>
          <DropdownTrigger asChild>
            <button
              type="button"
              aria-label={t("More ways to save")}
              disabled={!ready || saving}
              data-testid="save-more"
              className="grid h-7 w-6 place-items-center rounded-r-md border-l border-black/20 bg-accent text-accent-foreground disabled:opacity-50"
            >
              <ChevronDownIcon size={12} />
            </button>
          </DropdownTrigger>
          <DropdownContent align="end">
            <DropdownItem onSelect={() => start("copy")}>{targetLabel("copy")}</DropdownItem>
            <DropdownItem onSelect={() => start("as")}>{targetLabel("as")}</DropdownItem>
            <DropdownItem disabled={!canReplace} onSelect={() => afterMenu(() => start("replace"))}>
              {canReplace
                ? `${targetLabel("replace")}…`
                : session?.format === "webp"
                  ? t("Replace original (WebP can't be written)")
                  : t("Replace original (this drive has no trash)")}
            </DropdownItem>
            <DropdownSeparator />
            <DropdownItem onSelect={() => afterMenu(() => setOptionsOpen(true))}>
              {t("Save options… ({format})", { format: formatName(format) })}
            </DropdownItem>
          </DropdownContent>
        </DropdownRoot>
      </div>
      <SaveOptionsDialog open={optionsOpen} onClose={() => setOptionsOpen(false)} />
      <DialogWindow
        open={confirmReplace}
        onOpenChange={setConfirmReplace}
        title={t("Replace the original?")}
        description={t(
          "The original goes to the trash first, so you can get it back. The edited picture then takes its name.",
        )}
      >
        <div className="flex justify-end gap-2" data-testid="confirm-replace">
          <Button autoFocus onClick={() => setConfirmReplace(false)}>
            {t("Cancel")}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setConfirmReplace(false)
              void save("replace")
            }}
          >
            {t("Replace original")}
          </Button>
        </div>
      </DialogWindow>
    </div>
  )
}

/** Closing with unsaved changes: Save, Don't save, Cancel (Cancel has the focus). */
export function UnsavedPrompt() {
  const open = useEditorStore((s) => s.confirmClose)
  const saving = useEditorStore((s) => s.save.state === "saving")
  const failed = useEditorStore((s) => (s.save.state === "failed" ? s.save.error : ""))
  const preferred = useEditorSettings((s) => s.settings.saveTarget)
  // Closing never replaces the original without its own confirmation.
  const target: SaveTarget = preferred === "replace" ? "copy" : preferred
  return (
    <DialogWindow
      open={open}
      onOpenChange={(o) => !o && !saving && cancelClose()}
      title={t("Save your changes?")}
      description={t("The changes to this picture have not been saved.")}
    >
      {failed && (
        <p role="alert" className="mb-3 text-xs text-danger">
          {failed}
        </p>
      )}
      <div className="flex justify-end gap-2" data-testid="unsaved-prompt">
        <Button
          variant="primary"
          disabled={saving}
          onClick={() => {
            // The job's completion closes the editor (editorStore.onJob).
            void save(target).then((started) => {
              if (!started && useEditorStore.getState().save.state === "idle") cancelClose()
            })
          }}
        >
          {saving ? t("Saving…") : targetLabel(target)}
        </Button>
        <Button disabled={saving} onClick={closeEditorNow}>
          {t("Don't save")}
        </Button>
        <Button autoFocus disabled={saving} onClick={cancelClose}>
          {t("Cancel")}
        </Button>
      </div>
    </DialogWindow>
  )
}
