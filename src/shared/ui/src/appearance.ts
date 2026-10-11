import { applyLocale, currentLocale, isLocale, msg, type Locale } from "@panelyth/i18n"
import { create } from "zustand"

/**
 * Theme and interface size, shared by both apps (ADR-0031,
 * docs/shared/DESIGN-SYSTEM.md). Each app view keeps a localStorage mirror so
 * the values apply before the first paint, before the sidecar (and
 * library.db) is reachable. The app connects `save` to the shared library
 * setting and feeds changes from the other app back through
 * `applySharedAppearance`.
 */

export type ThemePreference =
  "system" | "light" | "dark" | "dark-purple" | "dark-brown" | "beige" | "light-brown"

export const THEME_OPTIONS: readonly { value: ThemePreference; label: string }[] = [
  { value: "system", label: msg("System") },
  { value: "light", label: msg("Light") },
  { value: "dark", label: msg("Dark") },
  { value: "dark-purple", label: msg("Dark purple") },
  { value: "dark-brown", label: msg("Dark brown") },
  { value: "beige", label: msg("Beige") },
  { value: "light-brown", label: msg("Light brown") },
]

/** Dark is the designed default: media reads best on a dark neutral surround. */
export const DEFAULT_THEME: ThemePreference = "dark"
const ORDER: readonly ThemePreference[] = ["dark", "light", "system"]

export type InterfaceSize = "small" | "medium" | "large"

export const INTERFACE_SIZE_SCALE: Record<InterfaceSize, number> = {
  small: 0.875,
  medium: 1,
  large: 1.125,
}

const DEFAULT_INTERFACE_SIZE: InterfaceSize = "medium"

/** The library setting both apps read and write. */
export const SHARED_APPEARANCE_KEY = "shared.appearance"

export interface SharedAppearance {
  theme: ThemePreference
  interfaceSize: InterfaceSize
  /** The interface language (ADR-0034); English until chosen. */
  language: Locale
}

const THEME_KEY = "panelyth.theme"
const SIZE_KEY = "panelyth.interfaceSize"

const isTheme = (v: unknown): v is ThemePreference => THEME_OPTIONS.some((o) => o.value === v)
const isInterfaceSize = (v: unknown): v is InterfaceSize =>
  v === "small" || v === "medium" || v === "large"

function readLocal<T>(key: string, valid: (v: unknown) => v is T, fallback: T): T {
  try {
    const value = localStorage.getItem(key)
    return valid(value) ? value : fallback
  } catch {
    return fallback
  }
}

function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable; the value lasts for this session only
  }
}

const systemDark = (): boolean =>
  window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false

function applyTheme(preference: ThemePreference): void {
  const systemTheme = preference === "system" ? systemDark() : null
  const dark =
    preference === "dark" ||
    preference === "dark-purple" ||
    preference === "dark-brown" ||
    (preference === "system" && systemTheme === true)
  const theme = preference === "system" ? (systemTheme ? "dark" : "light") : preference
  const root = document.documentElement
  root.classList.toggle("dark", dark)
  root.dataset.theme = theme
}

function applyInterfaceSize(size: InterfaceSize): void {
  document.documentElement.dataset.interfaceSize = size
}

let save: ((value: SharedAppearance) => void) | null = null

function current(): SharedAppearance {
  return {
    theme: useThemeStore.getState().preference,
    interfaceSize: useInterfaceSizeStore.getState().size,
    language: currentLocale(),
  }
}

/** The Settings → Appearance language picker: applies the language, then shares it. */
export async function setLanguage(language: Locale): Promise<void> {
  await applyLocale(language)
  save?.(current())
}

interface ThemeState {
  preference: ThemePreference
  setPreference(preference: ThemePreference): void
  cycle(): void
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  preference: DEFAULT_THEME,
  setPreference(preference) {
    writeLocal(THEME_KEY, preference)
    applyTheme(preference)
    set({ preference })
    save?.(current())
  },
  cycle() {
    const next = ORDER[(ORDER.indexOf(get().preference) + 1) % ORDER.length] ?? DEFAULT_THEME
    get().setPreference(next)
  },
}))

interface InterfaceSizeState {
  size: InterfaceSize
  setSize(size: InterfaceSize): void
}

export const useInterfaceSizeStore = create<InterfaceSizeState>((set) => ({
  size: DEFAULT_INTERFACE_SIZE,
  setSize(size) {
    writeLocal(SIZE_KEY, size)
    applyInterfaceSize(size)
    set({ size })
    save?.(current())
  },
}))

/** Applies the stored theme and follows OS changes while on "system". */
export function initTheme(): () => void {
  const preference = readLocal(THEME_KEY, isTheme, DEFAULT_THEME)
  useThemeStore.setState({ preference })
  applyTheme(preference)
  const query = window.matchMedia?.("(prefers-color-scheme: dark)")
  const onChange = (): void => {
    if (useThemeStore.getState().preference === "system") applyTheme("system")
  }
  query?.addEventListener("change", onChange)
  return () => query?.removeEventListener("change", onChange)
}

/** Apply the stored size before React renders, so layout spacing starts consistently. */
export function initInterfaceSize(): void {
  const size = readLocal(SIZE_KEY, isInterfaceSize, DEFAULT_INTERFACE_SIZE)
  useInterfaceSizeStore.setState({ size })
  applyInterfaceSize(size)
}

/** Where the app persists shared changes (library.setSetting of SHARED_APPEARANCE_KEY). */
export function connectSharedAppearance(persist: ((value: SharedAppearance) => void) | null): void {
  save = persist
}

/**
 * Applies a shared value from library.db or from the other app, without
 * saving it again. Returns false when the value has nothing usable.
 */
export function applySharedAppearance(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const { theme, interfaceSize, language } = value as Partial<
    Record<keyof SharedAppearance, unknown>
  >
  let applied = false
  if (isTheme(theme)) {
    writeLocal(THEME_KEY, theme)
    applyTheme(theme)
    useThemeStore.setState({ preference: theme })
    applied = true
  }
  if (isInterfaceSize(interfaceSize)) {
    writeLocal(SIZE_KEY, interfaceSize)
    applyInterfaceSize(interfaceSize)
    useInterfaceSizeStore.setState({ size: interfaceSize })
    applied = true
  }
  if (isLocale(language)) {
    if (language !== currentLocale()) void applyLocale(language)
    applied = true
  }
  return applied
}

/** The current values, for migrating a first start into the shared setting. */
export function currentAppearance(): SharedAppearance {
  return current()
}

/** How an app reaches the shared setting (its bridge to library.db and main's events). */
export interface AppearanceSyncPort {
  /** library.db settings once the sidecar is reachable; null when unavailable. */
  loadSettings(): Promise<Record<string, unknown> | null>
  saveSetting(key: string, value: SharedAppearance): void
  /** settings.changed events from main (a change made in the other app). */
  onSettingChanged(listener: (key: string, value: unknown) => void): () => void
}

/**
 * Keeps theme and interface size in step with the other app: applies the
 * shared value on start (or migrates this app's local values into it the
 * first time), saves changes, and applies the other app's changes live.
 */
export function startSharedAppearanceSync(port: AppearanceSyncPort): () => void {
  connectSharedAppearance((value) => port.saveSetting(SHARED_APPEARANCE_KEY, value))
  const off = port.onSettingChanged((key, value) => {
    if (key === SHARED_APPEARANCE_KEY) applySharedAppearance(value)
  })
  void port
    .loadSettings()
    .then((settings) => {
      if (!settings) return
      if (!applySharedAppearance(settings[SHARED_APPEARANCE_KEY])) {
        port.saveSetting(SHARED_APPEARANCE_KEY, current())
      }
    })
    .catch(() => undefined)
  return () => {
    off()
    connectSharedAppearance(null)
  }
}
