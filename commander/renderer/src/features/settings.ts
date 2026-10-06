import { create } from "zustand"
import { bridge, isBridgeAvailable } from "../bridge"

// The commander's own settings (Stage C03, Settings → Panels), under
// commander.* in the shared library.db (ADR-0031). Theme and interface
// size are shared with the viewer and live under shared.*.

export const SETTINGS_KEY = "commander.settings"

/** Size column: bytes with separators (Total Commander's default) or KB/MB/GB. */
export type SizeFormat = "bytes" | "units"
/** Date column: the locale's short date and time, or ISO (2026-10-06 14:05). */
export type DateFormat = "locale" | "iso"
/** Where typed letters go: quick search, or quick search with Alt (plain letters free for the C10 command line). */
export type LettersMode = "quickSearch" | "altLetters"

export interface PanelSettings {
  sizeFormat: SizeFormat
  dateFormat: DateFormat
  /** Hidden and system entries shown in panels that have no stored state yet. */
  showHidden: boolean
  letters: LettersMode
}

export const DEFAULT_SETTINGS: PanelSettings = {
  sizeFormat: "bytes",
  dateFormat: "locale",
  showHidden: false,
  letters: "quickSearch",
}

interface SettingsState {
  settings: PanelSettings
  open: boolean
}

export const useSettingsStore = create<SettingsState>(() => ({
  settings: DEFAULT_SETTINGS,
  open: false,
}))

/** Validated; unknown values fall back to the defaults. */
export function readSettings(value: unknown): PanelSettings {
  const v = (value ?? {}) as Partial<Record<keyof PanelSettings, unknown>>
  return {
    sizeFormat: v.sizeFormat === "units" ? "units" : "bytes",
    dateFormat: v.dateFormat === "iso" ? "iso" : "locale",
    showHidden: v.showHidden === true,
    letters: v.letters === "altLetters" ? "altLetters" : "quickSearch",
  }
}

export function updateSettings(change: Partial<PanelSettings>): void {
  const settings = { ...useSettingsStore.getState().settings, ...change }
  useSettingsStore.setState({ settings })
  if (isBridgeAvailable())
    void bridge.setSetting(SETTINGS_KEY, { v: 1, ...settings }).catch(() => undefined)
}

export const setSettingsOpen = (open: boolean): void => useSettingsStore.setState({ open })

export async function loadSettings(): Promise<void> {
  if (!isBridgeAvailable()) return
  const { settings } = await bridge.library()
  useSettingsStore.setState({ settings: readSettings(settings[SETTINGS_KEY]) })
}

/** Tests. */
export function resetSettings(): void {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, open: false })
}
