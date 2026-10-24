import { msg } from "@panelyth/i18n"

/** The three ways to see a Markdown file (ADR-0046): one document, one undo history. */
export const VIEW_MODES = ["source", "live", "preview"] as const
export type ViewMode = (typeof VIEW_MODES)[number]

export const VIEW_MODE_LABELS: Record<ViewMode, string> = {
  source: msg("Source"),
  live: msg("Live"),
  preview: msg("Preview"),
}

/**
 * Markdown opens in Live to edit (F4); a window opened to read (F3, Enter)
 * switches to Preview at once, and Edit brings it back to Live (owner request).
 */
export const START_MODE: ViewMode = "live"

/** Ctrl+E: Source → Live → Preview → Source. */
export const nextMode = (mode: ViewMode): ViewMode =>
  VIEW_MODES[(VIEW_MODES.indexOf(mode) + 1) % VIEW_MODES.length]!
