import { documentKindOf, type ContentItem } from "@panelyth/contracts"
import { currentAppearance } from "@panelyth/ui"
import { bridge } from "../bridge"
import { notice } from "./files"
import { IS_WINDOWS } from "./format"
import { useSettingsStore } from "./settings"
import { currentLocale, t } from "@panelyth/i18n"

// PDF and text files open in a document window of their own (ADR-0033),
// unless Settings → Panels → "Open PDFs and text files with" names the system
// default app. Main decides again from the resolved path, and the window has
// no bridge: it only reads the one file.

/** True when this file would open in a document window under the current setting. */
export const opensInDocumentWindow = (item: ContentItem): boolean =>
  item.kind !== "dir" &&
  useSettingsStore.getState().settings.documentOpen === "window" &&
  documentKindOf(item.name) !== null

/**
 * Shell scripts are text, but Enter on one means run it: it follows "Run
 * programs with Enter" like any program, and F3 shows it (ADR-0033 amended).
 * Each of these is a program to the sidecar on its platform, so main asks
 * first. Other code (.js, .ps1) is read far more often than run: Enter shows it.
 */
const RUN_ON_ENTER: ReadonlySet<string> = new Set(
  IS_WINDOWS ? ["bat", "cmd"] : ["sh", "bash", "zsh"],
)
export const runsOnEnter = (item: ContentItem): boolean => RUN_ON_ENTER.has(item.ext)

/**
 * Opens the file in a document window. Resolves false when the caller should
 * fall back (not a document, or the window could not open).
 */
export async function openDocumentWindow(item: ContentItem): Promise<boolean> {
  if (!opensInDocumentWindow(item)) return false
  try {
    await bridge.openDocument(item.id, currentAppearance().theme, currentLocale())
    return true
  } catch (error) {
    notice(
      t("{name} can't be opened in a window: {reason}", {
        name: item.name,
        reason: error instanceof Error ? error.message : String(error),
      }),
    )
    return false
  }
}
