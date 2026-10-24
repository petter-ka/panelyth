import type { Text } from "@codemirror/state"
import {
  TEXTEDIT_MAX_CHARS,
  type LineEnding,
  type TextEditorApi,
  type TextEditorSession,
  type TextFileEncoding,
} from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import { PanelythError, unwrap } from "@panelyth/renderer-core"
import { createStore, type Store } from "../store"
import { chunkText } from "./chunks"

// The document's life outside the editor (ADR-0046): what is saved, whether the
// text differs from it, the save with its conflict and encoding questions, the
// check when the window regains focus, and closing with unsaved changes. No
// React and no CodeMirror view here: the editor reports its document, React
// shows this store.

export type DocDialog =
  { kind: "conflict"; gone: boolean } | { kind: "unencodable"; line: number } | { kind: "close" }

export interface DocNotice {
  /** A new id restarts the announcement. */
  id: number
  text: string
  tone: "info" | "error"
}

export interface DocState {
  /** The text differs from the file as last saved or loaded. */
  dirty: boolean
  saving: boolean
  reloading: boolean
  encoding: TextFileEncoding
  bom: number
  lineEnding: LineEnding
  dialog: DocDialog | null
  /** The file changed (or went) on disk while there were no unsaved changes: offer Reload. */
  banner: "changed" | "gone" | null
  /** The disk's version differs from the one the edits started from. */
  diskChanged: boolean
  notice: DocNotice | null
}

/** Where the text lives: the editor's document. */
export interface DocumentHost {
  doc(): Text
  /** Replaces the document (Reload) without undo history across it. */
  reset(text: string): void
}

export interface ControllerOptions {
  api: TextEditorApi
  session: TextEditorSession
  /** The file's text now (fetch of the session's token URL, decoded). */
  readText(session: TextEditorSession): Promise<string>
  /** How long "Saved" and other notices stay (ms). */
  noticeMs?: number
  /** After each successful save (pictures that named nothing are asked again). */
  onSaved?(): void
  /** Viewing only (F3): no save; a change on disk reloads by itself (nothing can be unsaved). */
  isReadOnly?(): boolean
  /** The session as main reports it after a reload (it may have become editable). */
  onSession?(session: TextEditorSession): void
}

interface SaveOptions {
  force: boolean
  asUtf8: boolean
}

/** The words for a failed call, keeping the edits (they are never dropped). */
export function saveErrorText(error: unknown): string {
  if (error instanceof PanelythError) {
    switch (error.code) {
      case "TEXTEDIT_SESSION_GONE":
        return t("This editing session has ended. Copy your text to keep it, then reopen the file.")
      case "PERMISSION_DENIED":
        return t("You don't have permission to save this file.")
      case "NOT_FOUND":
        return t("The file's folder is no longer there.")
      case "BUSY":
        return t("The file is in use by another program. Try again in a moment.")
      case "SIDECAR_UNAVAILABLE":
        return t("The background service is not running. Try again in a moment.")
      default:
        return t("The file could not be saved: {message}", { message: error.message })
    }
  }
  return t("The file could not be saved: {message}", {
    message: error instanceof Error ? error.message : String(error),
  })
}

export interface DocumentController {
  readonly store: Store<DocState>
  attach(host: DocumentHost): void
  /** The editor's document changed (from its update listener). */
  docChanged(doc: Text): void
  /** Ctrl+S; ignored while a save runs or a question is open. */
  save(): Promise<void>
  resolveConflict(choice: "overwrite" | "reload" | "cancel"): Promise<void>
  resolveUnencodable(choice: "utf8" | "cancel"): Promise<void>
  /** Main asks (texteditor.closeRequest): the window is closing with unsaved changes. */
  requestClose(): Promise<void>
  resolveClose(choice: "save" | "discard" | "cancel"): Promise<void>
  /** The window regained focus: has the file changed on disk? */
  checkDisk(): Promise<void>
  reload(): Promise<void>
  dismissBanner(): void
  /** The version the edits started from (tests, diagnostics). */
  baseVersion(): string
  /** A short notice in the status bar (info goes away by itself; an error stays until dismissed). */
  notify(text: string, tone: DocNotice["tone"]): void
}

export function createDocumentController(options: ControllerOptions): DocumentController {
  const { api, readText } = options
  const noticeMs = options.noticeMs ?? 2500
  const store = createStore<DocState>({
    dirty: false,
    saving: false,
    reloading: false,
    encoding: options.session.encoding,
    bom: options.session.bom,
    lineEnding: options.session.lineEnding,
    dialog: null,
    banner: null,
    diskChanged: false,
    notice: null,
  })
  let host: DocumentHost | null = null
  let savedDoc: Text | null = null
  let base = options.session.version
  let last: SaveOptions = { force: false, asUtf8: false }
  let closeAfterSave = false
  let checking = false
  let noticeId = 0
  let noticeTimer: ReturnType<typeof setTimeout> | null = null
  // The last setDirty call: closing waits for main to know the state.
  let dirtySync: Promise<unknown> = Promise.resolve()

  const notify = (text: string, tone: DocNotice["tone"], sticky = false): void => {
    if (noticeTimer !== null) clearTimeout(noticeTimer)
    noticeTimer = null
    const notice = { id: ++noticeId, text, tone }
    store.set({ notice })
    if (!sticky) {
      noticeTimer = setTimeout(() => {
        if (store.get().notice?.id === notice.id) store.set({ notice: null })
      }, noticeMs)
    }
  }

  // Main hears about the dirty state only when it changes, never per keystroke.
  const setDirty = (dirty: boolean): void => {
    if (store.get().dirty === dirty) return
    store.set(dirty && store.get().banner === "changed" ? { dirty, banner: null } : { dirty })
    dirtySync = api.setDirty(dirty).catch(() => undefined)
  }

  const isClean = (doc: Text): boolean => savedDoc !== null && doc.eq(savedDoc)

  const closeWindow = async (discard: boolean): Promise<void> => {
    await dirtySync
    try {
      await unwrap(() => api.close(discard))
    } catch (error) {
      notify(saveErrorText(error), "error", true)
    }
  }

  const runSave = async (opts: SaveOptions): Promise<void> => {
    if (!host || store.get().saving) return
    last = opts
    const snapshot = host.doc()
    // Lines joined with "\n": the sidecar writes the file's own line endings.
    const text = snapshot.toString()
    if (text.length > TEXTEDIT_MAX_CHARS) {
      closeAfterSave = false
      notify(t("The text is too long to save here."), "error", true)
      return
    }
    store.set({ saving: true, dialog: null })
    try {
      // In order, one at a time: the staging buffer is a sequence.
      const chunks = chunkText(text)
      for (let seq = 0; seq < chunks.length; seq++) {
        const chunk = chunks[seq]!
        await unwrap(() => api.write(seq, chunk))
      }
      const result = await unwrap(() =>
        api.commit({ baseVersion: base, force: opts.force, asUtf8: opts.asUtf8 }),
      )
      if (result.status === "saved") {
        base = result.version
        savedDoc = snapshot
        last = { force: false, asUtf8: false }
        const encodingChanged = result.encoding !== store.get().encoding
        store.set({
          saving: false,
          encoding: result.encoding,
          bom: encodingChanged || opts.asUtf8 ? 0 : store.get().bom,
          banner: null,
          diskChanged: false,
        })
        // Edits made while the save ran keep the document dirty.
        setDirty(!isClean(host.doc()))
        notify(t("Saved"), "info")
        options.onSaved?.()
        if (closeAfterSave) {
          if (store.get().dirty) {
            await runSave(last)
          } else {
            closeAfterSave = false
            await closeWindow(false)
          }
        }
        return
      }
      store.set({
        saving: false,
        dialog:
          result.status === "conflict"
            ? { kind: "conflict", gone: result.gone }
            : { kind: "unencodable", line: result.line },
      })
    } catch (error) {
      closeAfterSave = false
      store.set({ saving: false })
      notify(saveErrorText(error), "error", true)
    }
  }

  const reload = async (): Promise<void> => {
    if (!host || store.get().reloading) return
    store.set({ reloading: true, dialog: null, banner: null })
    try {
      const session = await unwrap(() => api.session())
      options.onSession?.(session)
      // The disk's version before the bytes: a change in between makes the next save a conflict.
      const { disk } = await unwrap(() => api.check())
      if (!disk) {
        store.set({ reloading: false, diskChanged: true })
        notify(t("The file is no longer on disk."), "error", true)
        return
      }
      const text = await readText(session)
      host.reset(text)
      savedDoc = host.doc()
      base = disk.version
      closeAfterSave = false
      store.set({
        reloading: false,
        encoding: session.encoding,
        bom: session.bom,
        lineEnding: session.lineEnding,
        diskChanged: false,
      })
      setDirty(false)
    } catch (error) {
      store.set({ reloading: false })
      notify(
        t("The file could not be reloaded: {message}", {
          message: error instanceof Error ? error.message : String(error),
        }),
        "error",
        true,
      )
    }
  }

  return {
    store,
    attach(next) {
      host = next
      savedDoc = next.doc()
    },
    docChanged(doc) {
      setDirty(!isClean(doc))
    },
    async save() {
      if (options.isReadOnly?.() || store.get().dialog || store.get().reloading) return
      await runSave({ force: false, asUtf8: false })
    },
    async resolveConflict(choice) {
      if (store.get().dialog?.kind !== "conflict") return
      if (choice === "cancel") {
        closeAfterSave = false
        store.set({ dialog: null })
        return
      }
      // Overwrite sends the text again: only a successful commit consumes the staging buffer.
      if (choice === "overwrite") await runSave({ ...last, force: true })
      else await reload()
    },
    async resolveUnencodable(choice) {
      if (store.get().dialog?.kind !== "unencodable") return
      if (choice === "cancel") {
        closeAfterSave = false
        store.set({ dialog: null })
        return
      }
      await runSave({ ...last, asUtf8: true })
    },
    async requestClose() {
      const state = store.get()
      if (!state.dirty && !state.saving) return closeWindow(false)
      if (!state.dialog) store.set({ dialog: { kind: "close" } })
    },
    async resolveClose(choice) {
      if (store.get().dialog?.kind !== "close") return
      store.set({ dialog: null })
      if (choice === "cancel") return
      if (choice === "discard") return closeWindow(true)
      closeAfterSave = true
      // A save already running closes the window when it is done.
      if (!store.get().saving) await runSave({ force: false, asUtf8: false })
    },
    async checkDisk() {
      const state = store.get()
      if (checking || state.saving || state.reloading || state.dialog) return
      checking = true
      try {
        const { disk } = await unwrap(() => api.check())
        if (disk?.version === base) {
          store.set({ diskChanged: false, banner: null })
          return
        }
        // Read-only: nothing can be unsaved, so the window follows the file by itself.
        if (disk && options.isReadOnly?.()) {
          checking = false
          await reload()
          return
        }
        // With unsaved changes the next save meets the conflict dialog anyway.
        const dirty = store.get().dirty
        store.set({ diskChanged: true, banner: dirty ? null : disk ? "changed" : "gone" })
      } catch {
        // A failed check changes nothing; the save checks again.
      } finally {
        checking = false
      }
    },
    reload,
    dismissBanner() {
      store.set({ banner: null })
    },
    baseVersion: () => base,
    notify: (text, tone) => notify(text, tone, tone === "error"),
  }
}
