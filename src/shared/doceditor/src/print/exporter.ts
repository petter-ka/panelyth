import type { TextEditorApi, TextEditorExportParams } from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import { unwrap } from "@panelyth/renderer-core"
import { buildPrintView, type BuildOptions, type PrintSource } from "./printView"

// The PDF export's flow (C10.8): build the print view (cancellable, in
// slices), have main print this page to the PDF the user names, take the
// view away again. One export at a time.

export type ExportState = "idle" | "building" | "printing"

export interface ExporterDeps {
  api: Pick<TextEditorApi, "exportPdf">
  /** The document as it is now, with its parser and picture resolver. */
  source(): Promise<PrintSource>
  notify(text: string, tone: "info" | "error"): void
  setState(state: ExportState): void
  /** Where the print view goes (document.body; outside the app's root). */
  mount?: HTMLElement
  build?: BuildOptions
}

export interface Exporter {
  run(params: TextEditorExportParams): Promise<void>
  /** Stops an export whose print view is still being built. */
  cancel(): void
  state(): ExportState
}

export function createExporter(deps: ExporterDeps): Exporter {
  let state: ExportState = "idle"
  let cancelled = false
  const set = (next: ExportState): void => {
    state = next
    deps.setState(next)
  }

  return {
    state: () => state,
    cancel() {
      // Only while building: once main is printing, Chromium's printToPDF cannot be stopped.
      if (state === "building") cancelled = true
    },
    async run(params) {
      if (state !== "idle") return
      cancelled = false
      set("building")
      const view = document.createElement("div")
      view.className = "print-view"
      view.dataset.testid = "print-view"
      view.setAttribute("aria-hidden", "true")
      ;(deps.mount ?? document.body).appendChild(view)
      try {
        const source = await deps.source()
        const built = await buildPrintView(view, source, {
          ...deps.build,
          cancelled: () => cancelled,
        })
        if (!built || cancelled) return
        set("printing")
        const result = await unwrap(() => deps.api.exportPdf(params))
        if (result.saved) deps.notify(t("Exported {name}", { name: result.name ?? "" }), "info")
      } catch (error) {
        deps.notify(
          t("The PDF could not be exported: {message}", {
            message: error instanceof Error ? error.message : String(error),
          }),
          "error",
        )
      } finally {
        view.remove()
        set("idle")
      }
    },
  }
}
