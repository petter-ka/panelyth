import { BrowserWindow, type WebContents } from "electron"
import { basename, dirname, join } from "node:path"
import type {
  PdfMargins,
  SidecarMethodMap,
  TextEditImageType,
  TextEditOpenResult,
  TextEditorSession,
} from "@panelyth/contracts"
import { childFrameArgs, childFrameOptions, trackChildFrame } from "./childFrame"
import { broadcast, type TextEditorHandlers } from "./ipc/router"
import { RpcError } from "./sidecar/RpcClient"
import { appIconPath } from "./paths"
import { hardenWebContents } from "./security"
import { securePreferences } from "./window"

// The text editor window (Stage C10.6, ADR-0046): one window per file, opened
// by the commander's F4. The sidecar holds the session; main binds it to the
// window and adds it to every call, so the page never names a file. Closing a
// window with unsaved changes asks the page first.

type TextEditMethod =
  | "textedit.open"
  | "textedit.write"
  | "textedit.commit"
  | "textedit.check"
  | "textedit.close"
  | "textedit.assetChunk"
  | "textedit.assetCommit"
  | "textedit.resolveImages"

export interface TextEditorDeps {
  call<M extends TextEditMethod>(
    method: M,
    params: SidecarMethodMap[M]["params"],
  ): Promise<SidecarMethodMap[M]["result"]>
  /** A read-only token URL for the file, fetchable from the editor's origin only. */
  mintSrc(path: string): string
  /** Stage C10.7: a token URL for a picture the document links to, for an <img> only. */
  mintImage(path: string, type: TextEditImageType): string
  /** Stage C10.7: the assets folder's name (Settings → Edit; "assets" when none). */
  assetsFolder(): Promise<string>
  /** Stage C10.8: main's save dialog for a PDF, over the editor window; null when cancelled. */
  savePdfDialog(win: BrowserWindow, defaultPath: string): Promise<string | null>
  /** Stage C10.8: the PDF written whole (a partial file, then a rename), asynchronously. */
  writeFileAtomic(path: string, data: Buffer): Promise<void>
  /** The shared appearance's stored theme ("system" included), design style and language. */
  theme(): string
  style(): string
  lang(): string
  /** The window's first background: the theme's chrome. */
  background(): string
  log(message: string, fields: Record<string, unknown>): void
}

export interface TextEditorWindowOptions {
  url: string
  origin: string
  preload: string
  devTools: boolean
  platform: NodeJS.Platform
  /** Windows: the page draws the title strip with the window's buttons (ADR-0045). */
  titleBar: boolean
}

interface Editor {
  win: BrowserWindow
  session: TextEditOpenResult
  dirty: boolean
  /** The page agreed to close (saved, or "Don't save"). */
  closing: boolean
  /** Opened to read (F3 or Enter on Markdown) and not yet turned to editing. */
  readOnly: boolean
}

/** Stage C10.8: the page margins of a PDF, in millimetres. */
const PDF_MARGIN_MM: Record<PdfMargins, number> = { narrow: 10, normal: 18, wide: 25 }

/** Page numbers at the foot of every page (Chromium fills the classes in). */
const PDF_FOOTER =
  '<div style="width:100%;font-size:8px;color:#777;text-align:center;font-family:sans-serif">' +
  '<span class="pageNumber"></span> / <span class="totalPages"></span></div>'

const GONE = (): RpcError =>
  new RpcError("TEXTEDIT_SESSION_GONE", "this editor window has no file", false)

export class TextEditorWindows {
  private readonly bySender = new Map<number, Editor>()
  private readonly byFile = new Map<string, Editor>()

  constructor(
    private readonly options: TextEditorWindowOptions,
    private readonly deps: TextEditorDeps,
  ) {}

  get count(): number {
    return this.bySender.size
  }

  /** The key of a file: paths differ only by case on Windows and macOS file systems. */
  private key(path: string): string {
    return this.options.platform === "linux" ? path : path.toLowerCase()
  }

  /**
   * Opens a file in an editor window, or brings its window forward. The
   * sidecar's refusals (a binary, too large, a folder, not on this computer)
   * reach the caller as they are.
   */
  async open(entryId: number, options: { readOnly?: boolean } = {}): Promise<void> {
    const readOnly = options.readOnly === true
    const session = await this.deps.call("textedit.open", { entryId })
    const open = this.byFile.get(this.key(session.path))
    if (open && !open.win.isDestroyed()) {
      void this.deps.call("textedit.close", { sessionId: session.sessionId }).catch(() => undefined)
      if (open.win.isMinimized()) open.win.restore()
      open.win.focus()
      // F4 on a file a window shows to read: editing starts there.
      if (!readOnly && open.readOnly) {
        open.readOnly = false
        broadcast([open.win.webContents], "texteditor.editable", {})
      }
      return
    }
    const win = new BrowserWindow({
      width: 1000,
      height: 760,
      minWidth: 520,
      minHeight: 360,
      show: false,
      title: session.name,
      icon: appIconPath(),
      backgroundColor: this.deps.background(),
      ...childFrameOptions(this.options.titleBar),
      webPreferences: securePreferences(
        this.options.preload,
        this.options.devTools,
        childFrameArgs(this.options.titleBar),
      ),
    })
    win.setMenuBarVisibility(false)
    if (this.options.titleBar) trackChildFrame(win)
    hardenWebContents(win.webContents, this.options.origin)
    // The title is main's: the file's name and whether it has unsaved changes.
    win.on("page-title-updated", (event) => event.preventDefault())
    const editor: Editor = { win, session, dirty: false, closing: false, readOnly }
    const senderId = win.webContents.id
    this.bySender.set(senderId, editor)
    this.byFile.set(this.key(session.path), editor)
    win.on("close", (event) => {
      if (!editor.dirty || editor.closing) return
      event.preventDefault()
      broadcast([win.webContents], "texteditor.closeRequest", {})
    })
    win.on("closed", () => {
      this.bySender.delete(senderId)
      if (this.byFile.get(this.key(editor.session.path)) === editor) {
        this.byFile.delete(this.key(editor.session.path))
      }
      void this.deps
        .call("textedit.close", { sessionId: editor.session.sessionId })
        .catch((error: unknown) =>
          this.deps.log("text editor session not closed", { error: String(error) }),
        )
    })
    win.once("ready-to-show", () => win.show())
    void win.loadURL(this.options.url)
  }

  /**
   * Quitting: each window with unsaved changes asks its page (Save, Don't save,
   * Cancel), and the quit stops. True when one did. The sidecar must still run
   * then, or a Save could not be written: main asks before it stops anything.
   */
  askUnsaved(): boolean {
    let asked = false
    for (const editor of this.bySender.values()) {
      if (!editor.dirty || editor.closing || editor.win.isDestroyed()) continue
      asked = true
      if (editor.win.isMinimized()) editor.win.restore()
      editor.win.focus()
      broadcast([editor.win.webContents], "texteditor.closeRequest", {})
    }
    return asked
  }

  private editorOf(sender: WebContents): Editor {
    const editor = this.bySender.get(sender.id)
    if (!editor || editor.win.isDestroyed()) throw GONE()
    return editor
  }

  private title(editor: Editor): string {
    return `${editor.dirty ? "● " : ""}${editor.session.name}`
  }

  handlers(): TextEditorHandlers {
    return {
      "texteditor.session": async (event): Promise<TextEditorSession> => {
        const editor = this.editorOf(event.sender)
        const { session } = editor
        // After a reload the page starts from the file as it is on disk now.
        const { disk } = await this.deps.call("textedit.check", { sessionId: session.sessionId })
        if (!disk) throw new RpcError("NOT_FOUND", "the file is gone", false)
        return {
          name: session.name,
          sizeBytes: disk.sizeBytes,
          version: disk.version,
          encoding: session.encoding,
          bom: session.bom,
          lineEnding: session.lineEnding,
          src: this.deps.mintSrc(session.path),
          theme: this.deps.theme(),
          style: this.deps.style(),
          lang: this.deps.lang(),
          readOnly: editor.readOnly,
        }
      },
      "texteditor.write": async (event, { seq, text }) =>
        this.deps.call("textedit.write", {
          sessionId: this.editorOf(event.sender).session.sessionId,
          seq,
          text,
        }),
      "texteditor.commit": async (event, { baseVersion, force, asUtf8 }) => {
        const editor = this.editorOf(event.sender)
        const result = await this.deps.call("textedit.commit", {
          sessionId: editor.session.sessionId,
          baseVersion,
          force,
          asUtf8,
        })
        if (result.status === "saved") {
          // Saved as UTF-8: the next save keeps it so, without the old byte order mark.
          editor.session = {
            ...editor.session,
            encoding: result.encoding,
            bom: asUtf8 || result.encoding !== editor.session.encoding ? 0 : editor.session.bom,
          }
        }
        return result
      },
      "texteditor.check": async (event) =>
        this.deps.call("textedit.check", {
          sessionId: this.editorOf(event.sender).session.sessionId,
        }),
      // Stage C10.7: a picture's bytes go to the sidecar as base64 (its protocol is JSON).
      "texteditor.assetChunk": async (event, { seq, data }) =>
        this.deps.call("textedit.assetChunk", {
          sessionId: this.editorOf(event.sender).session.sessionId,
          seq,
          data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64"),
        }),
      "texteditor.assetCommit": async (event, { name }) =>
        this.deps.call("textedit.assetCommit", {
          sessionId: this.editorOf(event.sender).session.sessionId,
          name,
          folder: await this.deps.assetsFolder(),
        }),
      // The sidecar keeps the links inside the document's folder tree; the page gets tokens, never paths.
      "texteditor.resolveImages": async (event, { links }) => {
        const { images } = await this.deps.call("textedit.resolveImages", {
          sessionId: this.editorOf(event.sender).session.sessionId,
          links,
        })
        return {
          images: images.map((i) => ({
            link: i.link,
            src: i.path !== null && i.type !== null ? this.deps.mintImage(i.path, i.type) : null,
          })),
        }
      },
      // Stage C10.8: the page shows its print view; main names the file and prints the page.
      "texteditor.exportPdf": async (event, { pageSize, margins }) => {
        const editor = this.editorOf(event.sender)
        const { path } = editor.session
        const stem = basename(path).replace(/\.[^.]*$/, "") || "document"
        const target = await this.deps.savePdfDialog(editor.win, join(dirname(path), `${stem}.pdf`))
        if (!target) return { saved: false, name: null }
        const inches = PDF_MARGIN_MM[margins] / 25.4
        const pdf = await event.sender.printToPDF({
          pageSize,
          printBackground: true,
          margins: { top: inches, bottom: inches, left: inches, right: inches },
          displayHeaderFooter: true,
          headerTemplate: "<span></span>",
          footerTemplate: PDF_FOOTER,
        })
        await this.deps.writeFileAtomic(target, pdf)
        return { saved: true, name: basename(target) }
      },
      "texteditor.setDirty": (event, { dirty }) => {
        const editor = this.editorOf(event.sender)
        // Unsaved changes mean the page turned to editing (its Edit button or F4).
        if (dirty) editor.readOnly = false
        if (editor.dirty !== dirty) {
          editor.dirty = dirty
          editor.win.setTitle(this.title(editor))
          // macOS: the dot in the window's close button.
          if (this.options.platform === "darwin") editor.win.setDocumentEdited(dirty)
        }
        return { ok: true }
      },
      "texteditor.close": (event, { discard }) => {
        const editor = this.editorOf(event.sender)
        if (editor.dirty && !discard) {
          throw new RpcError("INVALID_ARGUMENT", "unsaved changes: save first or discard", false)
        }
        editor.closing = true
        editor.win.close()
        return { ok: true }
      },
    }
  }
}
