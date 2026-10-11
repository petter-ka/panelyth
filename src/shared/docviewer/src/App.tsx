import { lazy, Suspense } from "react"
import type { DocumentParams } from "./params"
import { TextViewer } from "./text/TextViewer"
import { t } from "@panelyth/i18n"

// pdf.js is large: a text file never loads it.
const PdfViewer = lazy(() => import("./pdf/PdfViewer"))

export function App({ params }: { params: DocumentParams | null }) {
  if (!params) {
    return (
      <p role="alert" className="p-6 text-sm text-muted">
        {t("This window was not opened for a document.")}
      </p>
    )
  }
  return params.kind === "pdf" ? (
    <Suspense fallback={<p className="p-6 text-sm text-muted">{t("Loading…")}</p>}>
      <PdfViewer params={params} />
    </Suspense>
  ) : (
    <TextViewer params={params} />
  )
}
