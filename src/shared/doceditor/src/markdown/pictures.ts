import type { Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import {
  TEXTEDIT_IMAGE_CHUNK_BYTES,
  TEXTEDIT_MAX_IMAGE_BYTES,
  type TextEditorApi,
} from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import { PanelythError, unwrap } from "@panelyth/renderer-core"

// Pictures pasted or dropped into a Markdown document (ADR-0046, C10.7): each
// is sent in 1 MiB chunks, one after the other, committed into the assets
// folder by the sidecar, and linked where the cursor or the drop was. One
// picture at a time, never in parallel; the text changes only by the link.

export interface PictureProgress {
  name: string
  sent: number
  total: number
}

export interface PictureDeps {
  api: Pick<TextEditorApi, "assetChunk" | "assetCommit">
  notify(text: string, tone: "info" | "error"): void
  /** A picture on its way (null when done). */
  progress(state: PictureProgress | null): void
}

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|avif)$/i

export const isPictureFile = (file: File): boolean =>
  file.type.startsWith("image/") || (file.type === "" && IMAGE_EXTENSIONS.test(file.name))

/** The name the sidecar starts from: a dropped file's name without its extension. */
export function pictureName(file: File, pasted: boolean): string {
  if (pasted) return "screenshot"
  const base = file.name.replace(/\.[^.]*$/, "").trim()
  return (base || "image").slice(0, 100)
}

/** Markdown for a picture: the alt's brackets escaped, a link with spaces or parentheses in <>. */
export function pictureMarkdown(alt: string, link: string): string {
  const safeAlt = alt.replace(/[\\[\]]/g, (c) => `\\${c}`)
  const safeLink = /[\s()<>]/.test(link) ? `<${link.replace(/[<>]/g, encodeURIComponent)}>` : link
  return `![${safeAlt}](${safeLink})`
}

function failureText(name: string, error: unknown): string {
  if (error instanceof PanelythError) {
    const reason = (error.details as { reason?: unknown } | undefined)?.reason
    if (reason === "notImage" || error.code === "UNSUPPORTED_MEDIA")
      return t("{name} isn't a picture.", { name })
    if (reason === "tooLarge") return t("{name} is larger than 25 MB.", { name })
    if (reason === "folder") return t("The pictures folder beside this document can't be written.")
    if (error.code === "BUSY")
      return t("Another picture is still being added. Try again in a moment.")
    if (error.code === "PERMISSION_DENIED")
      return t("You don't have permission to write the pictures folder.")
  }
  return t("{name} could not be added: {message}", {
    name,
    message: error instanceof Error ? error.message : String(error),
  })
}

interface Tracker {
  pos: number
}

/**
 * Sends the pictures one by one and links each at the tracked position.
 * Resolves when all are done; a refused picture leaves the text unchanged.
 */
export async function addPictures(
  view: EditorView,
  files: readonly File[],
  at: Tracker,
  pasted: boolean,
  deps: PictureDeps,
): Promise<number> {
  let inserted = 0
  for (const file of files) {
    const name = pictureName(file, pasted)
    if (!isPictureFile(file)) continue
    if (file.size > TEXTEDIT_MAX_IMAGE_BYTES) {
      deps.notify(t("{name} is larger than 25 MB.", { name: file.name || name }), "error")
      continue
    }
    if (file.size === 0) {
      deps.notify(t("{name} isn't a picture.", { name: file.name || name }), "error")
      continue
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const total = bytes.byteLength
      for (let seq = 0, offset = 0; offset < total; seq++, offset += TEXTEDIT_IMAGE_CHUNK_BYTES) {
        // A copy, not a view: a view would carry its whole buffer over IPC.
        const chunk = bytes.slice(offset, offset + TEXTEDIT_IMAGE_CHUNK_BYTES)
        await unwrap(() => deps.api.assetChunk(seq, chunk))
        if (total > TEXTEDIT_IMAGE_CHUNK_BYTES)
          deps.progress({ name: file.name || name, sent: offset + chunk.byteLength, total })
      }
      const { link } = await unwrap(() => deps.api.assetCommit(name))
      const text = (inserted > 0 ? "\n" : "") + pictureMarkdown(name, link)
      const pos = Math.min(at.pos, view.state.doc.length)
      view.dispatch({
        changes: { from: pos, insert: text },
        selection: { anchor: pos + text.length },
        userEvent: pasted ? "input.paste" : "input.drop",
        scrollIntoView: true,
      })
      // The next picture goes after this one (the tracker maps it the same way).
      at.pos = pos + text.length
      inserted++
    } catch (error) {
      deps.notify(failureText(file.name || name, error), "error")
    } finally {
      deps.progress(null)
    }
  }
  return inserted
}

/** Paste (image data on the clipboard) and drop (picture files) in the editor. */
export function pictureInput(deps: PictureDeps): Extension {
  const trackers = new Set<Tracker>()
  let queue: Promise<unknown> = Promise.resolve()

  const run = (view: EditorView, files: File[], pos: number, pasted: boolean): void => {
    const tracker: Tracker = { pos }
    trackers.add(tracker)
    queue = queue
      .then(() => addPictures(view, files, tracker, pasted, deps))
      .finally(() => trackers.delete(tracker))
  }

  return [
    // Where a picture goes follows the edits made while it uploads.
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return
      for (const tracker of trackers) tracker.pos = update.changes.mapPos(tracker.pos, 1)
    }),
    EditorView.domEventHandlers({
      paste(event, view) {
        const items = [...(event.clipboardData?.items ?? [])]
        const files = items
          .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
          .map((i) => i.getAsFile())
          .filter((f): f is File => f !== null)
        if (files.length === 0) return false
        event.preventDefault()
        // Read-only: nothing is sent and nothing goes in.
        if (view.state.readOnly) return true
        run(view, files, view.state.selection.main.head, true)
        return true
      },
      drop(event, view) {
        const files = [...(event.dataTransfer?.files ?? [])]
        // Dropped text keeps CodeMirror's own behaviour.
        if (files.length === 0) return false
        // Files that are not pictures are ignored (never read into the text).
        event.preventDefault()
        if (view.state.readOnly) return true
        const pictures = files.filter(isPictureFile)
        if (pictures.length === 0) return true
        const pos =
          view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head
        run(view, pictures, pos, false)
        return true
      },
    }),
  ]
}
