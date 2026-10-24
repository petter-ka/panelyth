import { lazy, Suspense, type ReactNode } from "react"
import { TitleBar } from "@panelyth/ui"
import type { DocumentParams } from "./params"
import { TextViewer } from "./text/TextViewer"
import { t } from "@panelyth/i18n"

// pdf.js is large: a text file never loads it.
const PdfViewer = lazy(() => import("./pdf/PdfViewer"))

/** The window's own title strip (Windows, ADR-0045) above the viewer. */
function Framed({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TitleBar title={title} rail={false} mark />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}

export function App({ params }: { params: DocumentParams | null }) {
  if (!params) {
    return (
      <Framed title="Panelyth">
        <p role="alert" className="p-6 text-sm text-muted">
          {t("This window was not opened for a document.")}
        </p>
      </Framed>
    )
  }
  return (
    <Framed title={params.name}>
      {params.kind === "pdf" ? (
        <Suspense fallback={<p className="p-6 text-sm text-muted">{t("Loading…")}</p>}>
          <PdfViewer params={params} />
        </Suspense>
      ) : (
        <TextViewer params={params} />
      )}
    </Framed>
  )
}
