import { applyLocale, currentLocale, isLocale } from "@panelyth/i18n"

// The editor window's look follows the shared appearance (ADR-0041): the theme
// and the interface size, in the classic or the terminal style (ADR-0047); the
// glass style's cards are the apps' layout, so the editor shows it classic. The
// values are mirrored into this origin's localStorage, so the next editor
// window paints in them before its bundle runs (ui/boot/boot.js).

const THEMES = ["light", "dark", "dark-purple", "dark-brown", "beige", "light-brown"]
const SIZES = ["small", "medium", "large", "xlarge"]

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable: the boot script falls back to dark
  }
}

const systemDark = (): boolean =>
  window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true

/** The theme as chosen ("system" included); the OS's changes matter only for "system". */
let preference = "dark"

/** Applies a theme name ("system" follows the OS); returns whether it is dark. */
export function applyTheme(
  theme: string | null,
  root: HTMLElement = document.documentElement,
): boolean {
  preference = theme === "system" || (theme && THEMES.includes(theme)) ? theme : "dark"
  const name = preference === "system" ? (systemDark() ? "dark" : "light") : preference
  const dark = name.startsWith("dark")
  root.classList.toggle("dark", dark)
  root.dataset.theme = name
  writeLocal("panelyth.theme", preference)
  return dark
}

/** Applies a design style: the terminal's, or the classic look for any other. */
export function applyStyle(
  style: string | null,
  root: HTMLElement = document.documentElement,
): void {
  const shown = style === "terminal" ? "terminal" : "classic"
  root.dataset.style = shown
  writeLocal("panelyth.style", shown)
}

export const isDarkTheme = (root: HTMLElement = document.documentElement): boolean =>
  root.classList.contains("dark")

/**
 * A shared.appearance value (settings.changed from main): the theme, the
 * interface size and the language. Returns whether the theme is dark now.
 */
export function applySharedAppearance(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return isDarkTheme()
  const { theme, style, interfaceSize, language } = value as Record<string, unknown>
  let dark = isDarkTheme()
  if (typeof theme === "string") dark = applyTheme(theme)
  if (typeof style === "string") applyStyle(style)
  if (typeof interfaceSize === "string" && SIZES.includes(interfaceSize)) {
    document.documentElement.dataset.interfaceSize = interfaceSize
    writeLocal("panelyth.interfaceSize", interfaceSize)
  }
  if (isLocale(language) && language !== currentLocale()) void applyLocale(language)
  return dark
}

/** While the theme is "system", follows the OS's light and dark; calls back with dark. */
export function followSystemTheme(onDark: (dark: boolean) => void): () => void {
  const query = window.matchMedia?.("(prefers-color-scheme: dark)")
  const onChange = (): void => {
    if (preference === "system") onDark(applyTheme("system"))
  }
  query?.addEventListener("change", onChange)
  return () => query?.removeEventListener("change", onChange)
}
