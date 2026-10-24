import { t } from "@panelyth/i18n"

/**
 * CodeMirror's own words (EditorState.phrases): what screen readers announce
 * after a search or a replace, and the go-to-line dialog. CodeMirror puts the
 * number where the "$" is, so the translations carry "$" for it.
 */
export function editorPhrases(): Record<string, string> {
  return {
    "Go to line": t("Go to line"),
    go: t("Go"),
    close: t("Close"),
    "current match": t("current match"),
    "on line": t("on line"),
    "replaced $ matches": t("Replaced {count} matches", { count: "$" }),
    "replaced match on line $": t("Replaced the match on line {line}", { line: "$" }),
    "Selection deleted": t("Selection deleted"),
    "Control character": t("Control character"),
  }
}
