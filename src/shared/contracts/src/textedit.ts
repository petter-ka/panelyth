// The text and Markdown editor (Stage C10.6, ADR-0046): an editor window of its
// own (origin app://texteditor), opened by the commander. The window never
// names a path or an entry: main mints a session at open, binds it to the
// window and adds it to every call. The file's bytes reach the page through a
// read-only token (as the document window's do); the text goes back to the
// sidecar in chunks, which writes it atomically in the file's own encoding.

/** The encodings the editor keeps; the names are the lister's (commander features/text.ts). */
export const TEXT_ENCODINGS = [
  "utf-8",
  "utf-16le",
  "utf-16be",
  "windows-1252",
  "windows-1250",
  "windows-1251",
  "iso-8859-2",
  "koi8-r",
] as const
export type TextFileEncoding = (typeof TEXT_ENCODINGS)[number]

/** The file's line endings; a file with mixed ones is saved with the most common. */
export const LINE_ENDINGS = ["lf", "crlf", "cr"] as const
export type LineEnding = (typeof LINE_ENDINGS)[number]

/** The largest file the editor edits; a larger one is viewed in the lister. */
export const TEXTEDIT_MAX_BYTES = 8 * 1024 * 1024
/** One chunk of text on its way to a save (UTF-16 code units). */
export const TEXTEDIT_CHUNK_CHARS = 256 * 1024
/** The text a save may carry in all (UTF-16 code units). */
export const TEXTEDIT_MAX_CHARS = 16 * 1024 * 1024

/** What the sidecar knows of the file when the session opens and after each save. */
export interface TextFileState {
  /** SHA-256 of the file's bytes, hex: the version a save starts from. */
  version: string
  sizeBytes: number
  mtimeNs: number
}

// Sidecar methods: called by main only, never by a renderer.

export interface TextEditOpenParams {
  entryId: number
}
export interface TextEditOpenResult extends TextFileState {
  sessionId: string
  /** The file's name, for the title (never its folder). */
  name: string
  /** Absolute path: main keeps it (the read token, a reveal); the page never sees it. */
  path: string
  encoding: TextFileEncoding
  /** The byte order mark's length (0 when there is none); kept on save. */
  bom: number
  lineEnding: LineEnding
}

export interface TextEditWriteParams {
  sessionId: string
  /** 0 for the first chunk of a save; each next one is one more. */
  seq: number
  text: string
}

export interface TextEditCommitParams {
  sessionId: string
  /** The version the edits started from. */
  baseVersion: string
  /** Overwrite a file that changed on disk since. */
  force: boolean
  /** Save as UTF-8 (with no byte order mark) when the text cannot be written in the file's encoding. */
  asUtf8: boolean
}

/** A save's outcome. A conflict or an unencodable character is an answer, not an error. */
export type TextEditCommitResult =
  | ({ status: "saved"; encoding: TextFileEncoding } & TextFileState)
  /** The file changed on disk (or is gone) since `baseVersion`; nothing was written. */
  | { status: "conflict"; gone: boolean }
  /** A character cannot be written in the file's encoding; nothing was written. */
  | { status: "unencodable"; line: number }

export interface TextEditSessionParams {
  sessionId: string
}
export interface TextEditCheckResult {
  /** The file on disk now; null when it is gone. */
  disk: TextFileState | null
}

// Main methods: the editor window's profile (TEXTEDITOR_METHODS).

/** Why a file did not open in the editor (main's refusal reason). */
export type TextEditRefusal = "binary" | "tooLarge" | "folder" | "notLocal"

export interface TextEditorSession {
  name: string
  sizeBytes: number
  version: string
  encoding: TextFileEncoding
  bom: number
  lineEnding: LineEnding
  /** panelyth-media://m/<token>: the file's bytes, read-only, for this window only. */
  src: string
  /** The shared appearance's theme, design style and language, for the first paint. */
  theme: string
  style: string
  lang: string
  /**
   * Opened to read (F3 or Enter on a Markdown file): Live without editing, until
   * the page's Edit (or F4, or main's `texteditor.editable`) turns editing on.
   */
  readOnly: boolean
}

export interface TextEditorWriteParams {
  seq: number
  text: string
}
export interface TextEditorCommitParams {
  baseVersion: string
  force: boolean
  asUtf8: boolean
}
export interface TextEditorDirtyParams {
  dirty: boolean
}
export interface TextEditorCloseParams {
  /** Close even with unsaved changes (the user chose "Don't save"). */
  discard: boolean
}

// Stage C10.7: pictures pasted or dropped into a document, and the pictures
// a document links to. A picture is copied into the assets folder beside the
// document (never linked where it lies: the page names no path); identical
// bytes already there are reused.

/** The pictures a document can hold (checked by their bytes, not their names). */
export const TEXTEDIT_IMAGE_TYPES = ["png", "jpeg", "gif", "webp", "bmp", "avif"] as const
export type TextEditImageType = (typeof TEXTEDIT_IMAGE_TYPES)[number]
/** The largest picture a document takes. */
export const TEXTEDIT_MAX_IMAGE_BYTES = 25 * 1024 * 1024
/** One chunk of a picture on its way to the sidecar. */
export const TEXTEDIT_IMAGE_CHUNK_BYTES = 1024 * 1024
/** The linked pictures resolved in one call (a visible range's). */
export const TEXTEDIT_MAX_IMAGE_LINKS = 200
/** The assets folder's name when Settings names none. */
export const TEXTEDIT_DEFAULT_ASSETS = "assets"

export interface TextEditAssetChunkParams {
  sessionId: string
  /** 0 starts a new picture (dropping one not committed); then one more each. */
  seq: number
  /** The bytes, base64 (the sidecar's protocol is JSON). */
  data: string
}
export interface TextEditAssetCommitParams {
  sessionId: string
  /** A name to start from (a dropped file's), else "image"; cleaned and made unique by the sidecar. */
  name: string
  /** The folder beside the document (Settings → Edit); one plain name, no separators. */
  folder: string
}
export interface TextEditAssetCommitResult {
  /** The relative Markdown link, with forward slashes and spaces encoded: "assets/image-1.png". */
  link: string
  /** True when identical bytes were already in the folder and that file is linked instead. */
  reused: boolean
}

export interface TextEditResolveImagesParams {
  sessionId: string
  /** Links as written in the document (relative); each is resolved against its folder. */
  links: string[]
}
export interface TextEditResolvedImage {
  link: string
  /** The picture's path when the link names one inside the document's folder tree, else null. */
  path: string | null
  /** Its type by its bytes (the token's MIME type). */
  type: TextEditImageType | null
}
export interface TextEditResolveImagesResult {
  images: TextEditResolvedImage[]
}

/** The page's side: chunks of the picture's bytes, then a commit. */
export interface TextEditorAssetChunkParams {
  seq: number
  /** The bytes (a structured clone over IPC; main encodes them for the sidecar). */
  data: Uint8Array
}
export interface TextEditorAssetCommitParams {
  name: string
}
export interface TextEditorResolveImagesParams {
  links: string[]
}
export interface TextEditorResolveImagesResult {
  /** Each link with a read-only token URL for an <img>, or null when it names no picture there. */
  images: { link: string; src: string | null }[]
}

// Stage C10.8: a clean PDF of the document. The page lays out a print view
// (Preview's rendering for Markdown, the source with syntax colours for other
// text) on white paper; main asks where to save in its own dialog, prints the
// editor window's page with Chromium and writes the file atomically.

export const PDF_PAGE_SIZES = ["A4", "Letter"] as const
export type PdfPageSize = (typeof PDF_PAGE_SIZES)[number]
export const PDF_MARGINS = ["narrow", "normal", "wide"] as const
export type PdfMargins = (typeof PDF_MARGINS)[number]

export interface TextEditorExportParams {
  pageSize: PdfPageSize
  margins: PdfMargins
}
export interface TextEditorExportResult {
  /** False when the save dialog was cancelled. */
  saved: boolean
  /** The PDF's file name (never its folder), for the notice. */
  name: string | null
}
