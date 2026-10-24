import { nativeTheme } from "electron"

/**
 * The chrome color of each theme (src/shared/ui/src/styles.css): what main
 * paints before a page has (the window, the app views).
 */
const CHROME: Record<string, string> = {
  dark: "#242424",
  light: "#f7f7f7",
  "dark-purple": "#2a2233",
  "dark-brown": "#30251e",
  beige: "#f6f1e7",
  "light-brown": "#f2e4d0",
}

/** The terminal style draws each theme as a console of its own (ADR-0047). */
const TERMINAL_CHROME: Record<string, string> = {
  dark: "#07100b",
  light: "#f3f2ee",
  "dark-purple": "#060c13",
  "dark-brown": "#110c05",
  beige: "#efe4cb",
  "light-brown": "#e7d5b6",
}

export interface ThemeColors {
  chrome: string
}

/** The theme a `shared.appearance` value names, as stored ("system" included); null when it names none. */
export function appearanceTheme(appearance: unknown): string | null {
  const theme = (appearance as { theme?: unknown } | null | undefined)?.theme
  return typeof theme === "string" ? theme : null
}

/** The design style a `shared.appearance` value names; null when it names none. */
export function appearanceStyle(appearance: unknown): string | null {
  const style = (appearance as { style?: unknown } | null | undefined)?.style
  return typeof style === "string" ? style : null
}

/**
 * The colors of a stored theme in a style; "system" follows the OS, an
 * unknown theme is dark, and every style but the terminal paints the
 * palette's own chrome.
 */
export function themeColorsOf(
  theme: string | null | undefined,
  style?: string | null,
): ThemeColors {
  const resolved =
    theme === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : (theme ?? "dark")
  const key = resolved in CHROME ? resolved : "dark"
  return { chrome: (style === "terminal" ? TERMINAL_CHROME : CHROME)[key]! }
}

/** The view background for a `shared.appearance` value; dark when unknown. */
export function chromeColorOf(appearance: unknown): string {
  return themeColorsOf(appearanceTheme(appearance), appearanceStyle(appearance)).chrome
}
