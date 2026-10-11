import { create } from "zustand"
import { bridge, isBridgeAvailable } from "../bridge"

// The commander's own settings (Stage C03, Settings → Panels), under
// commander.* in the shared library.db (ADR-0031). Theme and interface
// size are shared with the viewer and live under shared.*.

export const SETTINGS_KEY = "commander.settings"
export const MAX_EDITOR_CHARS = 1024

/** Size column: readable units by default, or exact bytes with separators. */
export type SizeFormat = "bytes" | "units"
/** Configured date format for Quick View and Commander lists in `configured` mode. */
export type DateFormat = "locale" | "iso"
/** Where typed letters go: quick search, or quick search with Alt (plain letters free for the C10 command line). */
export type LettersMode = "quickSearch" | "altLetters"
/** "Run programs with Enter" (ADR-0027, Stage C05): ask first (default), always, never. */
export type RunPrograms = "ask" | "always" | "never"
/** How Enter / double-click opens images and videos. */
export type MediaOpen = "viewer" | "system"
/** How Enter, double-click and F3 open PDFs and text files (ADR-0033). */
export type DocumentOpen = "window" | "system"
/** The right mouse button: marks (hold for the menu; classic Total Commander), or opens the menu at once. */
export type RightButton = "mark" | "menu"

export interface PanelSettings {
  sizeFormat: SizeFormat
  dateFormat: DateFormat
  /** Hidden and system entries shown in panels that have no stored state yet. */
  showHidden: boolean
  letters: LettersMode
  mediaOpen: MediaOpen
  documentOpen: DocumentOpen
  rightButton: RightButton
  runPrograms: RunPrograms
  /** F4's editor: an absolute program path; "" = the system's text editor. Main reads it from library.db. */
  editor: string
}

export const DEFAULT_SETTINGS: PanelSettings = {
  sizeFormat: "units",
  dateFormat: "locale",
  showHidden: false,
  letters: "quickSearch",
  mediaOpen: "viewer",
  documentOpen: "window",
  rightButton: "mark",
  runPrograms: "ask",
  editor: "",
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
  const v = (value ?? {}) as Partial<Record<keyof PanelSettings, unknown>> & { v?: unknown }
  const oldDefaultUsesBytes = v.v === 1
  return {
    sizeFormat: v.sizeFormat === "bytes" && !oldDefaultUsesBytes ? "bytes" : "units",
    dateFormat: v.dateFormat === "iso" ? "iso" : "locale",
    showHidden: v.showHidden === true,
    letters: v.letters === "altLetters" ? "altLetters" : "quickSearch",
    mediaOpen: v.mediaOpen === "system" ? "system" : "viewer",
    documentOpen: v.documentOpen === "system" ? "system" : "window",
    rightButton: v.rightButton === "menu" ? "menu" : "mark",
    runPrograms: v.runPrograms === "always" || v.runPrograms === "never" ? v.runPrograms : "ask",
    editor: typeof v.editor === "string" ? v.editor.slice(0, MAX_EDITOR_CHARS) : "",
  }
}

export function updateSettings(change: Partial<PanelSettings>): void {
  const settings = { ...useSettingsStore.getState().settings, ...change }
  useSettingsStore.setState({ settings })
  if (isBridgeAvailable())
    void bridge.setSetting(SETTINGS_KEY, { v: 2, ...settings }).catch(() => undefined)
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
