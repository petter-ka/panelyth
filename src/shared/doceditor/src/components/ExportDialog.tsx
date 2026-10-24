import { PDF_MARGINS, PDF_PAGE_SIZES, type PdfMargins, type PdfPageSize } from "@panelyth/contracts"
import { msg, t } from "@panelyth/i18n"
import { Button, DialogWindow } from "@panelyth/ui"
import { useState } from "react"
import { readPdfChoice, writePdfChoice } from "../print/prefs"
import { useStore } from "../store"
import type { Workspace } from "../workspace"

const PAGE_LABELS: Record<PdfPageSize, string> = { A4: "A4", Letter: msg("Letter") }
const MARGIN_LABELS: Record<PdfMargins, string> = {
  narrow: msg("Narrow"),
  normal: msg("Normal"),
  wide: msg("Wide"),
}

function Choice<T extends string>({
  legend,
  name,
  options,
  labels,
  value,
  onChange,
}: {
  legend: string
  name: string
  options: readonly T[]
  labels: Record<T, string>
  value: T
  onChange(value: T): void
}) {
  return (
    <fieldset className="mb-3">
      <legend className="mb-1.5 text-xs font-medium">{legend}</legend>
      <div className="flex gap-4">
        {options.map((option) => (
          <label key={option} className="flex items-center gap-1.5 text-xs">
            <input
              type="radio"
              name={name}
              value={option}
              checked={value === option}
              onChange={() => onChange(option)}
              className="accent-[var(--accent)]"
            />
            {/* A4 is a name, not a word: it stays as it is. */}
            {option === "A4" ? labels[option] : t(labels[option])}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/** The Export PDF dialog (C10.8): page size and margins, remembered for next time. */
export function ExportDialog({ workspace }: { workspace: Workspace }) {
  const open = useStore(workspace.chrome, (s) => s.exportDialog)
  if (!open) return null
  return <ExportForm workspace={workspace} />
}

function ExportForm({ workspace }: { workspace: Workspace }) {
  const [choice, setChoice] = useState(() => readPdfChoice())
  const exportNow = (): void => {
    writePdfChoice(choice)
    void workspace.exportPdf(choice)
  }
  return (
    <DialogWindow
      open
      onOpenChange={(open) => !open && workspace.closeExport()}
      title={t("Export PDF")}
      description={t("A PDF of the document on white paper, with page numbers.")}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          exportNow()
        }}
      >
        <Choice
          legend={t("Page size")}
          name="pdf-page-size"
          options={PDF_PAGE_SIZES}
          labels={PAGE_LABELS}
          value={choice.pageSize}
          onChange={(pageSize) => setChoice((c) => ({ ...c, pageSize }))}
        />
        <Choice
          legend={t("Margins")}
          name="pdf-margins"
          options={PDF_MARGINS}
          labels={MARGIN_LABELS}
          value={choice.margins}
          onChange={(margins) => setChoice((c) => ({ ...c, margins }))}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button type="submit" variant="primary" autoFocus data-testid="export-confirm">
            {t("Export")}
          </Button>
          <Button onClick={() => workspace.closeExport()}>{t("Cancel")}</Button>
        </div>
      </form>
    </DialogWindow>
  )
}
