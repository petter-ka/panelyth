// The legacy build carries the polyfills for newer JavaScript built-ins (Map
// upserts), so a document opens whichever Chromium the shell's Electron has.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"

// The worker, CMaps, fonts, ICC profiles and wasm decoders are files of this
// origin (vite.config.ts); the CSP allows nothing else (ADR-0033).
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export { pdfjs }
export type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs"

export const PDFJS_DATA = {
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  iccUrl: "/pdfjs/iccs/",
  wasmUrl: "/pdfjs/wasm/",
  // No eval, no XFA scripting: documents are only read (ADR-0033).
  isEvalSupported: false,
  enableXfa: false,
} as const
