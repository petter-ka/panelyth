import type { TextEditorApi } from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import { createBridgeCore } from "@panelyth/renderer-core"

/**
 * The editor window's preload API (window.panelyth there): its own file only,
 * through the session main bound to this window (ADR-0046). Nothing here can
 * name a path or another entry.
 */
export const bridge = createBridgeCore<TextEditorApi>(() =>
  t("This window was not opened for a file to edit."),
)
