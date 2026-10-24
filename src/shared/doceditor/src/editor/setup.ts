import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import {
  bracketMatching,
  indentOnInput,
  indentUnit,
  type LanguageDescription,
} from "@codemirror/language"
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search"
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state"
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  type ViewUpdate,
} from "@codemirror/view"
import { defaultIndent, detectIndent, type IndentStyle } from "./indent"
import { editorPhrases } from "./phrases"
import { createFindPanel, openReplacePanel, relabelSearchPanel } from "./searchPanel"
import { adoptEditorStyles } from "./styleSheets"
import { appearance } from "./theme"

// The source editor (ADR-0046): CodeMirror 6, outside React. React renders the
// header and the status bar around it; this module owns the view. A later
// stage adds the Markdown modes (Live, Preview) beside this one.

const WRAP_KEY = "panelyth.editor.wrap"

export function readWrap(): boolean {
  try {
    return localStorage.getItem(WRAP_KEY) === "1"
  } catch {
    return false
  }
}

function writeWrap(wrap: boolean): void {
  try {
    localStorage.setItem(WRAP_KEY, wrap ? "1" : "0")
  } catch {
    // storage unavailable: the choice lasts for this window
  }
}

export interface SourceEditorOptions {
  /** The file's name: its language, its indentation convention, the editor's label. */
  name: string
  text: string
  wrap: boolean
  dark: boolean
  /** Viewing only: nothing can change the text until setReadOnly(false). */
  readOnly?: boolean
  /** Every update the view makes (the document, the selection, focus). */
  onUpdate(update: ViewUpdate): void
  /** The file's language once its name is matched (null: plain text); its colours follow. */
  onLanguage(language: LanguageDescription | null): void
}

export interface SourceEditor {
  readonly view: EditorView
  /** A fresh document (Reload): no undo history across it. */
  reset(text: string): void
  setWrap(wrap: boolean): void
  setDark(dark: boolean): void
  /** CodeMirror's phrases and the find panel in the current language. */
  relabel(): void
  openReplace(): void
  /**
   * The view's look: null for Source (line numbers), or the live view's
   * extension. The document, its undo history and the selection stay.
   */
  setLook(look: Extension | null): void
  /** Extensions a file type adds (Markdown: pasting and dropping pictures). */
  setExtras(extras: Extension): void
  /** Read-only or editable; the document, the selection and the scroll stay. */
  setReadOnly(readOnly: boolean): void
  destroy(): void
}

/**
 * Read-only: no change by input or command (EditorState.readOnly), the DOM not
 * editable, yet focusable (tabindex), so the cursor moves, text can be
 * selected and copied, and find works.
 */
const readOnlyLook = (readOnly: boolean): Extension =>
  readOnly
    ? [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({ tabindex: "0" }),
      ]
    : []

/** Source's own parts: the gutter with line numbers. */
const sourceLook = (): Extension => [lineNumbers(), highlightActiveLineGutter()]

function indentExtensions(style: IndentStyle): Extension {
  return [indentUnit.of(style.unit), EditorState.tabSize.of(style.tabSize)]
}

/** The editor's fixed parts (everything but the compartments). */
function baseExtensions(): Extension {
  return [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true, createPanel: createFindPanel }),
    appearance,
    Prec.high(
      keymap.of([
        // Also from the find field: Ctrl+H there shows the replace row.
        {
          key: "Ctrl-h",
          run: openReplacePanel,
          preventDefault: true,
          scope: "editor search-panel",
        },
        {
          key: "Mod-Alt-f",
          run: openReplacePanel,
          preventDefault: true,
          scope: "editor search-panel",
        },
      ]),
    ),
    keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
  ]
}

export function createSourceEditor(
  parent: HTMLElement,
  options: SourceEditorOptions,
): SourceEditor {
  const languageSlot = new Compartment()
  const indentSlot = new Compartment()
  const wrapSlot = new Compartment()
  const darkSlot = new Compartment()
  const phrasesSlot = new Compartment()
  const lookSlot = new Compartment()
  const extrasSlot = new Compartment()
  const readOnlySlot = new Compartment()
  let readOnly = options.readOnly ?? false
  let languageSupport: Extension = []
  let look: Extension = sourceLook()
  let extras: Extension = []
  let destroyed = false
  let wrap = options.wrap
  let dark = options.dark

  const stateFor = (text: string): EditorState =>
    EditorState.create({
      doc: text,
      extensions: [
        baseExtensions(),
        languageSlot.of(languageSupport),
        indentSlot.of(indentExtensions(detectIndent(text) ?? defaultIndent(options.name))),
        wrapSlot.of(wrap ? EditorView.lineWrapping : []),
        darkSlot.of(EditorView.darkTheme.of(dark)),
        phrasesSlot.of(EditorState.phrases.of(editorPhrases())),
        lookSlot.of(look),
        extrasSlot.of(extras),
        readOnlySlot.of(readOnlyLook(readOnly)),
        EditorView.contentAttributes.of({ "aria-label": options.name }),
        EditorView.updateListener.of((update) => options.onUpdate(update)),
      ],
    })

  adoptEditorStyles()
  const view = new EditorView({ state: stateFor(options.text), parent })

  // The language loads on first use; the text shows at once, coloured when it arrives.
  void import("./languages").then(({ languageFor }) => {
    if (destroyed) return
    const language = languageFor(options.name)
    options.onLanguage(language)
    void language?.load().then((support) => {
      if (destroyed) return
      languageSupport = support
      view.dispatch({ effects: languageSlot.reconfigure(support) })
    })
  })

  return {
    view,
    reset(text) {
      view.setState(stateFor(text))
    },
    setWrap(next) {
      wrap = next
      writeWrap(next)
      view.dispatch({ effects: wrapSlot.reconfigure(next ? EditorView.lineWrapping : []) })
    },
    setDark(next) {
      if (next === dark) return
      dark = next
      view.dispatch({ effects: darkSlot.reconfigure(EditorView.darkTheme.of(next)) })
    },
    relabel() {
      view.dispatch({
        effects: phrasesSlot.reconfigure(EditorState.phrases.of(editorPhrases())),
      })
      relabelSearchPanel(view)
    },
    openReplace() {
      view.focus()
      openReplacePanel(view)
    },
    setLook(next) {
      look = next ?? sourceLook()
      view.dispatch({ effects: lookSlot.reconfigure(look) })
    },
    setReadOnly(next) {
      if (next === readOnly) return
      readOnly = next
      view.dispatch({ effects: readOnlySlot.reconfigure(readOnlyLook(next)) })
    },
    setExtras(next) {
      extras = next
      view.dispatch({ effects: extrasSlot.reconfigure(next) })
    },
    destroy() {
      destroyed = true
      view.destroy()
    },
  }
}
