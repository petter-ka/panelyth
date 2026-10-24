import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { EditorView } from "@codemirror/view"
import { tags } from "@lezer/highlight"
import type { Extension } from "@codemirror/state"

// The editor's look from the app's tokens (src/shared/ui/src/styles.css): every
// colour is a CSS variable, so one theme serves the light and the dark themes
// and a theme change needs no reconfiguration. Never a literal colour here.

const mix = (token: string, percent: number): string =>
  `color-mix(in srgb, var(${token}) ${percent}%, transparent)`

export const editorTheme: Extension = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--canvas)",
    color: "var(--text)",
    fontSize: "0.875rem",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "1.55",
  },
  ".cm-content": { caretColor: "var(--accent)", padding: "6px 0" },
  ".cm-line": { padding: "0 12px 0 8px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: mix("--accent", 28) },
  ".cm-selectionBackground": { backgroundColor: mix("--accent", 18) },
  ".cm-activeLine": { backgroundColor: mix("--text", 5) },
  ".cm-gutters": {
    backgroundColor: "var(--canvas)",
    color: "var(--muted)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 14px", minWidth: "3ch" },
  ".cm-activeLineGutter": { backgroundColor: mix("--text", 5), color: "var(--text)" },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: mix("--accent", 22),
    outline: `1px solid ${mix("--accent", 60)}`,
  },
  "&.cm-focused .cm-nonmatchingBracket": { backgroundColor: mix("--danger", 30) },
  ".cm-searchMatch": {
    backgroundColor: mix("--warning", 30),
    outline: `1px solid ${mix("--warning", 55)}`,
    borderRadius: "2px",
  },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: mix("--accent", 45) },
  ".cm-selectionMatch": { backgroundColor: mix("--accent", 14) },
  ".cm-specialChar": { color: "var(--danger)" },
  ".cm-placeholder": { color: "var(--muted)" },
  ".cm-panels": {
    backgroundColor: "var(--chrome)",
    color: "var(--text)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-tooltip": {
    backgroundColor: "var(--chrome)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: "6px",
  },
  // The go-to-line dialog (Ctrl+Alt+G).
  ".cm-dialog": { padding: "6px 10px", fontSize: "0.75rem" },
  ".cm-dialog input": {
    background: "var(--raised)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    padding: "2px 6px",
  },
  ".cm-dialog button": {
    background: "var(--raised)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
  },
})

/** Syntax colours: the label palette (its blue, purple…), tuned per theme in styles.css. */
export const highlightStyle = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword],
    color: "var(--label-purple)",
  },
  { tag: [tags.definitionKeyword, tags.moduleKeyword, tags.self], color: "var(--label-purple)" },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "var(--label-green)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit], color: "var(--label-orange)" },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment],
    color: "var(--muted)",
    fontStyle: "italic",
  },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: "var(--label-blue)",
  },
  {
    tag: [tags.definition(tags.variableName), tags.definition(tags.function(tags.variableName))],
    color: "var(--label-blue)",
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)],
    color: "var(--label-yellow)",
  },
  { tag: [tags.propertyName, tags.attributeName], color: "var(--label-blue)" },
  { tag: [tags.tagName, tags.angleBracket], color: "var(--label-red)" },
  { tag: [tags.attributeValue], color: "var(--label-green)" },
  {
    tag: [tags.escape, tags.character, tags.color, tags.constant(tags.variableName)],
    color: "var(--label-orange)",
  },
  { tag: [tags.meta, tags.processingInstruction, tags.annotation], color: "var(--label-gray)" },
  { tag: [tags.operator, tags.punctuation, tags.separator, tags.bracket], color: "var(--text)" },
  { tag: tags.invalid, color: "var(--danger)" },
  // Markdown and other prose.
  { tag: tags.heading, color: "var(--label-blue)", fontWeight: "700" },
  { tag: [tags.heading1, tags.heading2], fontWeight: "700" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--accent)", textDecoration: "underline" },
  { tag: tags.quote, color: "var(--muted)", fontStyle: "italic" },
  { tag: tags.monospace, color: "var(--label-orange)" },
  { tag: [tags.list, tags.contentSeparator], color: "var(--label-purple)" },
  { tag: tags.labelName, color: "var(--label-yellow)" },
  { tag: tags.inserted, color: "var(--success)" },
  { tag: tags.deleted, color: "var(--danger)" },
  { tag: tags.changed, color: "var(--warning)" },
])

/** The theme and the syntax colours, ready for an editor's extensions. */
export const appearance: Extension = [editorTheme, syntaxHighlighting(highlightStyle)]
