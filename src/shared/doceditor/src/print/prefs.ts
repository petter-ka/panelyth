import {
  PDF_MARGINS,
  PDF_PAGE_SIZES,
  type PdfMargins,
  type PdfPageSize,
  type TextEditorExportParams,
} from "@panelyth/contracts"

// The export dialog's choice, remembered for the next export in this origin.

const KEY = "panelyth.editor.pdf"

/** Letter where it is the norm (a locale in the United States), A4 everywhere else. */
export function defaultPageSize(locale: string = navigator.language): PdfPageSize {
  return /-US$/i.test(locale) ? "Letter" : "A4"
}

export function readPdfChoice(locale?: string): TextEditorExportParams {
  const fallback: TextEditorExportParams = {
    pageSize: defaultPageSize(locale),
    margins: "normal",
  }
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return fallback
    const value = JSON.parse(raw) as Partial<Record<keyof TextEditorExportParams, unknown>>
    return {
      pageSize: PDF_PAGE_SIZES.includes(value.pageSize as PdfPageSize)
        ? (value.pageSize as PdfPageSize)
        : fallback.pageSize,
      margins: PDF_MARGINS.includes(value.margins as PdfMargins)
        ? (value.margins as PdfMargins)
        : fallback.margins,
    }
  } catch {
    return fallback
  }
}

export function writePdfChoice(choice: TextEditorExportParams): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(choice))
  } catch {
    // storage unavailable: the choice lasts for this export
  }
}
