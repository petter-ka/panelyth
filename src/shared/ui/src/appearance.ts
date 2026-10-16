import { applyLocale, currentLocale, isLocale, msg, type Locale } from "@panelyth/i18n"
import { create } from "zustand"

/**
 * Style, theme and interface size, shared by both apps (ADR-0031,
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

/** The theme choices of Settings → Appearance, by group; "system" is a checkbox above them. */
export const THEME_GROUPS: readonly {
  label: string
  themes: readonly { value: ThemePreference; label: string }[]
}[] = [
  {
    label: msg("Dark themes"),
    themes: THEME_OPTIONS.filter((o) =>
      (["dark", "dark-purple", "dark-brown"] as ThemePreference[]).includes(o.value),
    ),
  },
  {
    label: msg("Light themes"),
    themes: THEME_OPTIONS.filter((o) =>
      (["light", "beige", "light-brown"] as ThemePreference[]).includes(o.value),
    ),
  },
]

/** Dark is the designed default: media reads best on a dark neutral surround. */
export const DEFAULT_THEME: ThemePreference = "dark"
const ORDER: readonly ThemePreference[] = ["dark", "light", "system"]

/**
 * The design style (ADR-0041): the classic flat surfaces, or liquid glass.
 * Independent of the palette: every theme works in both.
 */
export type DesignStyle = "glass" | "classic"

export const STYLE_OPTIONS: readonly { value: DesignStyle; label: string }[] = [
  { value: "classic", label: msg("Classic") },
  { value: "glass", label: msg("Liquid glass") },
]

/** A fresh profile opens in the classic style; liquid glass is one click away. */
export const DEFAULT_STYLE: DesignStyle = "classic"

export type IconSet = "default" | "fluent" | "material"

export const ICON_SET_OPTIONS: readonly { value: IconSet; label: string }[] = [
  { value: "default", label: msg("Default") },
  { value: "fluent", label: msg("Fluent System Icons") },
  { value: "material", label: msg("Material Symbols") },
]

export const DEFAULT_ICON_SET: IconSet = "default"

export type InterfaceSize = "small" | "medium" | "large" | "xlarge"

export const INTERFACE_SIZE_SCALE: Record<InterfaceSize, number> = {
  small: 0.875,
  medium: 1,
  large: 1.125,
  xlarge: 1.25,
}

const DEFAULT_INTERFACE_SIZE: InterfaceSize = "medium"

/** The library setting both apps read and write. */
export const SHARED_APPEARANCE_KEY = "shared.appearance"

export interface SharedAppearance {
  /** The design style; classic until chosen. */
  style: DesignStyle
  theme: ThemePreference
  interfaceSize: InterfaceSize
  /** The icon library of the chrome icons; the built-in set until chosen. */
  iconSet: IconSet
  /** The interface language (ADR-0034); English until chosen. */
  language: Locale
}

const THEME_KEY = "panelyth.theme"
const SIZE_KEY = "panelyth.interfaceSize"
const ICON_SET_KEY = "panelyth.iconSet"
const STYLE_KEY = "panelyth.style"

const isTheme = (v: unknown): v is ThemePreference => THEME_OPTIONS.some((o) => o.value === v)
const isInterfaceSize = (v: unknown): v is InterfaceSize =>
  typeof v === "string" && v in INTERFACE_SIZE_SCALE

const isIconSet = (v: unknown): v is IconSet => ICON_SET_OPTIONS.some((o) => o.value === v)

const isStyle = (v: unknown): v is DesignStyle => STYLE_OPTIONS.some((o) => o.value === v)

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

/** Leaving "system": the plain theme the system shows now, so nothing changes on screen. */
export const themeOfSystem = (): ThemePreference => (systemDark() ? "dark" : "light")

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

function applyStyle(style: DesignStyle): void {
  document.documentElement.dataset.style = style
}

function applyInterfaceSize(size: InterfaceSize): void {
  document.documentElement.dataset.interfaceSize = size
}

let save: ((value: SharedAppearance) => void) | null = null

function current(): SharedAppearance {
  return {
    style: useStyleStore.getState().style,
    theme: useThemeStore.getState().preference,
    interfaceSize: useInterfaceSizeStore.getState().size,
    iconSet: useIconSetStore.getState().iconSet,
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

interface StyleState {
  style: DesignStyle
  setStyle(style: DesignStyle): void
}

export const useStyleStore = create<StyleState>((set) => ({
  style: DEFAULT_STYLE,
  setStyle(style) {
    writeLocal(STYLE_KEY, style)
    applyStyle(style)
    set({ style })
    save?.(current())
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

interface IconSetState {
  iconSet: IconSet
  setIconSet(iconSet: IconSet): void
}

export const useIconSetStore = create<IconSetState>((set) => ({
  iconSet: DEFAULT_ICON_SET,
  setIconSet(iconSet) {
    writeLocal(ICON_SET_KEY, iconSet)
    set({ iconSet })
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

/** Apply the stored style and size before React renders, so layout spacing starts consistently. */
export function initInterfaceSize(): void {
  const style = readLocal(STYLE_KEY, isStyle, DEFAULT_STYLE)
  useStyleStore.setState({ style })
  applyStyle(style)
  const size = readLocal(SIZE_KEY, isInterfaceSize, DEFAULT_INTERFACE_SIZE)
  useInterfaceSizeStore.setState({ size })
  applyInterfaceSize(size)
  useIconSetStore.setState({ iconSet: readLocal(ICON_SET_KEY, isIconSet, DEFAULT_ICON_SET) })
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
  const { style, theme, interfaceSize, iconSet, language } = value as Partial<
    Record<keyof SharedAppearance, unknown>
  >
  let applied = false
  if (isStyle(style)) {
    writeLocal(STYLE_KEY, style)
    applyStyle(style)
    useStyleStore.setState({ style })
    applied = true
  }
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
  if (isIconSet(iconSet)) {
    writeLocal(ICON_SET_KEY, iconSet)
    useIconSetStore.setState({ iconSet })
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
