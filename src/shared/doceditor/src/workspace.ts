import { openSearchPanel } from "@codemirror/search"
import type { Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { language } from "@codemirror/language"
import type { TextEditorApi, TextEditorExportParams, TextEditorSession } from "@panelyth/contracts"
import { t, useLocaleStore } from "@panelyth/i18n"
import { unwrap } from "@panelyth/renderer-core"
import { applySharedAppearance, followSystemTheme } from "./appearance"
import { isMarkdownName } from "./editor/markdownName"
import { nextMode, START_MODE, type ViewMode } from "./editor/modes"
import { createSourceEditor, readWrap, type SourceEditor } from "./editor/setup"
import type { Parser } from "@lezer/common"
import type { ImageResolver } from "./markdown/images"
import type { PictureProgress } from "./markdown/pictures"
import type { Preview } from "./markdown/preview"
import type { Exporter, ExportState } from "./print/exporter"
import { createDocumentController, type DocumentController } from "./save/controller"
import { createStatusModel, type StatusModel } from "./status/statusModel"
import { createStore, type Store } from "./store"
import { readSessionText } from "./text/read"

// One editor window's parts, created once outside React: the CodeMirror view
// (in an element React only places), the document controller, the status
// model, the Markdown modes, and the window's shortcuts and events. React
// renders the chrome from their small stores.

export interface ChromeState {
  wrap: boolean
  /** The language's name; null while unknown or for plain text. */
  language: string | null
  languageKnown: boolean
  /** A Markdown file: the mode switch shows. */
  markdown: boolean
  mode: ViewMode
  /** A picture on its way into the assets folder. */
  picture: PictureProgress | null
  /** Viewing only (F3): no edits until Edit, F4 or main's texteditor.editable. */
  readOnly: boolean
  /** The Export PDF dialog is open. */
  exportDialog: boolean
  /** An export: its print view being built (cancellable), then main printing it. */
  exporting: ExportState
}

export interface Workspace {
  readonly session: TextEditorSession
  /** The editor's element (hidden in Preview). */
  readonly element: HTMLElement
  /** The preview's element (Markdown; shown in Preview only). */
  readonly previewElement: HTMLElement
  readonly editor: SourceEditor
  readonly controller: DocumentController
  readonly status: StatusModel
  readonly chrome: Store<ChromeState>
  toggleWrap(): void
  openFind(): void
  openReplace(): void
  save(): void
  focus(): void
  /** Markdown: Source, Live or Preview; resolves when the mode is on screen. */
  setMode(mode: ViewMode): Promise<void>
  /** Ctrl+E. */
  cycleMode(): Promise<void>
  /** Edit, F4 or main's texteditor.editable: the read-only window becomes editable (one way). */
  startEditing(): void
  /** Ctrl+Shift+E or the header's button: the Export PDF dialog. */
  openExport(): void
  closeExport(): void
  /** Builds the print view and has main print it to a PDF (C10.8). */
  exportPdf(params: TextEditorExportParams): Promise<void>
  /** Stops an export still building its print view (Esc, the status bar's Cancel). */
  cancelExport(): void
  /** Resolves when the mode switches asked for so far are done. */
  settled(): Promise<void>
  /** Resolves when a Markdown file's live view, pictures and paste are ready (tests). */
  readonly markdownReady: Promise<void>
  destroy(): void
}

export interface WorkspaceOptions {
  api: TextEditorApi
  session: TextEditorSession
  text: string
  dark: boolean
  /** Window events and shortcuts (false in tests that drive the parts directly). */
  listen?: boolean
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)

export function createWorkspace(options: WorkspaceOptions): Workspace {
  const { api, session } = options
  const element = document.createElement("div")
  element.className = "h-full"
  const previewElement = document.createElement("div")
  previewElement.className = "h-full"
  previewElement.hidden = true
  const markdown = isMarkdownName(session.name)
  const chrome = createStore<ChromeState>({
    wrap: readWrap(),
    language: null,
    languageKnown: false,
    markdown,
    mode: markdown ? START_MODE : "source",
    picture: null,
    readOnly: session.readOnly,
    exportDialog: false,
    exporting: "idle",
  })
  let startEditing = (): void => undefined
  let onSaved = (): void => undefined
  const controller = createDocumentController({
    api,
    session,
    readText: (s) => readSessionText(s),
    onSaved: () => onSaved(),
    isReadOnly: () => chrome.get().readOnly,
    // A reload brings the latest session: main may have made the window editable meanwhile.
    onSession: (latest) => {
      if (!latest.readOnly) startEditing()
    },
  })
  let status: StatusModel | null = null

  const editor = createSourceEditor(element, {
    name: session.name,
    text: options.text,
    wrap: chrome.get().wrap,
    dark: options.dark,
    readOnly: session.readOnly,
    onUpdate(update) {
      if (update.docChanged) controller.docChanged(update.state.doc)
      status?.update(update.state, update.docChanged, update.selectionSet)
    },
    onLanguage(language) {
      chrome.set({ language: language?.name ?? null, languageKnown: true })
    },
  })
  const view = editor.view
  const statusModel = createStatusModel(view.state)
  status = statusModel

  controller.attach({
    doc: () => view.state.doc,
    reset(text) {
      // A reload (also the silent one of a read-only window) keeps the cursor and the view.
      const line = element.hidden ? null : editorTopLine()
      const head = view.state.selection.main.head
      editor.reset(text)
      view.dispatch({ selection: { anchor: Math.min(head, view.state.doc.length) } })
      if (line !== null) scrollEditorTo(line)
      statusModel.update(view.state, true, true)
      if (chrome.get().mode === "preview" && preview && markdownParser)
        void preview.show(view.state.doc, markdownParser, preview.topLine())
    },
  })

  // The Markdown modes ----------------------------------------------------
  let live: Extension | null = null
  let markdownParser: Parser | null = null
  let preview: Preview | null = null
  let resolver: ImageResolver | null = null
  let lastEditorMode: ViewMode = chrome.get().mode === "source" ? "source" : "live"
  let switching: Promise<void> = Promise.resolve()
  let exporter: Exporter | null = null

  const showLink = (url: string): void =>
    controller.notify(t("Link target: {url}", { url }), "info")

  const markdownReady: Promise<void> = markdown
    ? import("./markdown").then((m) => {
        markdownParser = m.markdownParser
        const r = m.createImageResolver(async (links) => {
          const { images } = await unwrap(() => api.resolveImages(links))
          return images
        })
        resolver = r
        live = m.liveMarkdown({ resolver: r, onLink: showLink })
        editor.setExtras(
          m.pictureInput({
            api,
            notify: (text, tone) => controller.notify(text, tone),
            progress: (picture) => chrome.set({ picture }),
          }),
        )
        onSaved = () => {
          // A picture that was missing may be there now.
          r.forgetMissing()
          view.dispatch({ effects: m.imagesChanged.of(null) })
        }
        if (chrome.get().mode !== "source") editor.setLook(live)
      })
    : Promise.resolve()

  /** The first line in view in the editor (a layout read, on a switch only). */
  const editorTopLine = (): number => {
    const top = view.scrollDOM.getBoundingClientRect().top - view.documentTop
    const block = view.lineBlockAtHeight(Math.max(0, top))
    return view.state.doc.lineAt(block.from).number
  }

  const scrollEditorTo = (line: number): void => {
    const doc = view.state.doc
    const pos = doc.line(Math.min(Math.max(1, line), doc.lines)).from
    view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start" }) })
  }

  async function loadPreview(): Promise<Preview> {
    if (preview) return preview
    const [{ createPreview }] = await Promise.all([import("./markdown/preview"), markdownReady])
    if (!preview) {
      preview = createPreview({ resolver: resolver!, onLink: showLink })
      previewElement.appendChild(preview.element)
    }
    return preview
  }

  async function applyMode(next: ViewMode): Promise<void> {
    const prev = chrome.get().mode
    if (!markdown || next === prev) return
    if (next === "preview") {
      const line = element.hidden ? 1 : editorTopLine()
      lastEditorMode = prev
      chrome.set({ mode: next })
      element.hidden = true
      previewElement.hidden = false
      const p = await loadPreview()
      if (chrome.get().mode !== "preview") return
      p.element.focus({ preventScroll: true })
      await p.show(view.state.doc, markdownParser!, line)
      return
    }
    let line: number
    if (prev === "preview") {
      line = preview?.topLine() ?? 1
      previewElement.hidden = true
      element.hidden = false
    } else {
      line = editorTopLine()
    }
    lastEditorMode = next
    // Until the live view has loaded, Live looks like Source; it switches when ready.
    editor.setLook(next === "live" ? live : null)
    chrome.set({ mode: next })
    view.requestMeasure()
    scrollEditorTo(line)
    view.focus()
  }

  const workspace: Workspace = {
    session,
    element,
    previewElement,
    editor,
    controller,
    status: statusModel,
    chrome,
    markdownReady,
    toggleWrap() {
      const wrap = !chrome.get().wrap
      chrome.set({ wrap })
      editor.setWrap(wrap)
    },
    openFind() {
      // Find and replace work in the editor modes; Preview hands over to the last of them.
      if (chrome.get().mode === "preview") {
        void workspace.setMode(lastEditorMode).then(() => workspace.openFind())
        return
      }
      view.focus()
      openSearchPanel(view)
    },
    openReplace() {
      // Nothing to replace in a read-only window: find instead.
      if (chrome.get().readOnly) return workspace.openFind()
      if (chrome.get().mode === "preview") {
        void workspace.setMode(lastEditorMode).then(() => workspace.openReplace())
        return
      }
      editor.openReplace()
    },
    save() {
      if (chrome.get().readOnly) return
      void controller.save()
    },
    startEditing() {
      if (!chrome.get().readOnly) return
      // The selection and the scroll stay: only the compartment changes.
      editor.setReadOnly(false)
      chrome.set({ readOnly: false })
      if (chrome.get().mode === "preview") void workspace.setMode(lastEditorMode)
      else view.focus()
    },
    focus() {
      if (chrome.get().mode === "preview") preview?.element.focus()
      else view.focus()
    },
    setMode(next) {
      // One switch after the other: a quick Ctrl+E Ctrl+E never interleaves.
      switching = switching.then(() => applyMode(next))
      return switching
    },
    cycleMode() {
      // The next mode is chosen when this switch's turn comes, after any still running.
      switching = switching.then(() => applyMode(nextMode(chrome.get().mode)))
      return switching
    },
    settled: () => switching,
    openExport() {
      if (chrome.get().exporting === "idle") chrome.set({ exportDialog: true })
    },
    closeExport() {
      chrome.set({ exportDialog: false })
    },
    async exportPdf(params) {
      chrome.set({ exportDialog: false })
      if (chrome.get().exporting !== "idle") return
      // "building" at once, before the export's code has loaded.
      chrome.set({ exporting: "building" })
      try {
        const m = await import("./print")
        exporter ??= m.createExporter({
          api,
          notify: (text, tone) => controller.notify(text, tone),
          setState: (exporting) => chrome.set({ exporting }),
          source: async () => {
            await markdownReady
            return {
              text: view.state.doc.toString(),
              markdown,
              parser: markdown ? markdownParser : (view.state.facet(language)?.parser ?? null),
              resolver,
            }
          },
        })
        await exporter.run(params)
      } finally {
        if (chrome.get().exporting === "building" && exporter?.state() !== "building")
          chrome.set({ exporting: "idle" })
      }
    },
    cancelExport() {
      exporter?.cancel()
    },
    destroy() {
      for (const off of cleanups) off()
      preview?.destroy()
      statusModel.destroy()
      editor.destroy()
    },
  }

  startEditing = () => workspace.startEditing()
  // Opened to read (F3, Enter): the rendered page; Edit returns to Live (owner request).
  if (markdown && session.readOnly) void workspace.setMode("preview")

  const cleanups: (() => void)[] = []
  if (options.listen !== false) {
    const onKey = (e: KeyboardEvent): void => {
      const mod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      const outside = !(e.target instanceof Node && view.dom.contains(e.target))
      if (e.key === "F4" && !mod && !e.altKey && !e.shiftKey) {
        // F4 in a read-only window starts editing it, as F4 on the file in the commander does.
        if (chrome.get().readOnly) {
          e.preventDefault()
          workspace.startEditing()
        }
      } else if (mod && !e.altKey && !e.shiftKey && e.code === "KeyS") {
        e.preventDefault()
        workspace.save()
      } else if (mod && !e.altKey && e.shiftKey && e.code === "KeyE") {
        e.preventDefault()
        workspace.openExport()
      } else if (e.key === "Escape" && chrome.get().exporting === "building") {
        workspace.cancelExport()
      } else if (mod && !e.altKey && !e.shiftKey && e.code === "KeyE" && markdown) {
        e.preventDefault()
        void workspace.cycleMode()
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyZ") {
        e.preventDefault()
        workspace.toggleWrap()
      } else if (outside && mod && !e.altKey && !e.shiftKey && e.code === "KeyF") {
        e.preventDefault()
        workspace.openFind()
      } else if (
        outside &&
        e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        !e.metaKey &&
        e.code === "KeyH"
      ) {
        e.preventDefault()
        workspace.openReplace()
      }
    }
    window.addEventListener("keydown", onKey)
    cleanups.push(() => window.removeEventListener("keydown", onKey))

    // Back in the window: did the file change on disk meanwhile?
    const onFocus = (): void => void controller.checkDisk()
    window.addEventListener("focus", onFocus)
    cleanups.push(() => window.removeEventListener("focus", onFocus))

    cleanups.push(api.onEvent("texteditor.closeRequest", () => void controller.requestClose()))
    cleanups.push(api.onEvent("texteditor.editable", () => workspace.startEditing()))
    cleanups.push(
      api.onEvent("settings.changed", ({ key, value }) => {
        if (key === "shared.appearance") editor.setDark(applySharedAppearance(value))
      }),
    )
    cleanups.push(followSystemTheme((dark) => editor.setDark(dark)))
    // A new language: CodeMirror's phrases and the find panel follow.
    cleanups.push(
      useLocaleStore.subscribe((s, prev) => {
        if (s.locale !== prev.locale) editor.relabel()
      }),
    )
  }

  return workspace
}
