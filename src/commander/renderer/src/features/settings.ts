import { CONFLICT_POLICIES, type ConflictPolicy } from "@panelyth/contracts"
import { TILE_SIZE_ORDER, type TileSize } from "@panelyth/media-ui"
import { createSettingsStore } from "@panelyth/renderer-core"
import { openSettingsWindowOr } from "@panelyth/ui"
import { bridge, isBridgeAvailable } from "../bridge"

// The commander's own settings (Stage C03, Settings → Panels), under
// commander.* in the shared library.db (ADR-0031). Theme and interface
// size are shared with the viewer and live under shared.*.

export const SETTINGS_KEY = "commander.settings"
/** v3: hidden entries shown by default (older stored values are not a choice). */
export const SETTINGS_VERSION = 3
export const MAX_EDITOR_CHARS = 1024

/** Size column: readable units by default, or exact bytes with separators. */
export type SizeFormat = "bytes" | "units"
/** Configured date format for Quick View and Commander lists in `configured` mode. */
export type DateFormat = "locale" | "iso"
/** Where typed letters go: quick search, or the command line (quick search then starts with Alt; Stage C10). */
export type LettersMode = "quickSearch" | "altLetters"
/** "Run programs with Enter" (ADR-0027, Stage C05): ask first (default), always, never. */
export type RunPrograms = "ask" | "always" | "never"
/** How Enter / double-click opens images and videos. */
export type MediaOpen = "viewer" | "system"
/** How Enter, double-click and F3 open PDFs and text files (ADR-0033). */
export type DocumentOpen = "window" | "system"
/** The right mouse button: marks (hold for the menu; classic Total Commander), or opens the menu at once. */
export type RightButton = "mark" | "menu"

/** The tab bar (Stage C10.5): always there with its "+" button, or only once a panel has several tabs. */
export type TabBarMode = "always" | "multiple"

/** Date tolerance of compares: exact, or the 2 s of FAT file systems. */
export type CompareTolerance = 0 | 2000

export interface PanelSettings {
  sizeFormat: SizeFormat
  dateFormat: DateFormat
  /** Hidden entries (dot-names, the hidden attribute) shown in the panels; Ctrl+H switches one panel. */
  showHidden: boolean
  /**
   * System entries too, with the hidden ones (off by default; an entry that is
   * hidden and system is a system one, as Windows marks its own files).
   */
  showSystem: boolean
  letters: LettersMode
  mediaOpen: MediaOpen
  documentOpen: DocumentOpen
  rightButton: RightButton
  runPrograms: RunPrograms
  /** F4's editor: an absolute program path; "" = the system's text editor. Main reads it from library.db. */
  editor: string
  /**
   * How dates are compared (Stage C08: Shift+F2 and Synchronize directories):
   * the tolerance in ms (0 = exact, 2000 for FAT drives), whether a
   * difference of exactly one hour counts as the same (daylight saving
   * time), and whether dates are ignored.
   */
  compareToleranceMs: CompareTolerance
  compareDst: boolean
  compareIgnoreDates: boolean
  /** Stage C10: the bars around the panels. */
  showToolbar: boolean
  showCommandLine: boolean
  showFunctionKeys: boolean
  /** The tile size of the Thumbnails view (Ctrl+Shift+F1). */
  thumbSize: TileSize
  /** Operations: what the copy and move dialogs start with. */
  copyConflict: ConflictPolicy
  copyVerify: boolean
  /** Confirmations: F8 asks before moving to the trash; a drop shows the copy dialog first. */
  confirmTrash: boolean
  confirmDrop: boolean
  /** Stage C10.5: when the tab bar shows. */
  tabBar: TabBarMode
  /** The folder tree opens a folder in the panel once its cursor rests on it (off: Enter or a click opens). */
  treeFollowCursor: boolean
}

export const DEFAULT_SETTINGS: PanelSettings = {
  sizeFormat: "units",
  dateFormat: "locale",
  showHidden: true,
  showSystem: false,
  letters: "quickSearch",
  mediaOpen: "viewer",
  documentOpen: "window",
  rightButton: "mark",
  runPrograms: "ask",
  editor: "",
  compareToleranceMs: 2000,
  compareDst: false,
  compareIgnoreDates: false,
  showToolbar: true,
  showCommandLine: true,
  showFunctionKeys: true,
  thumbSize: "small",
  copyConflict: "ask",
  copyVerify: false,
  confirmTrash: true,
  confirmDrop: true,
  tabBar: "always",
  treeFollowCursor: false,
}

const policies: ReadonlySet<unknown> = new Set(CONFLICT_POLICIES)
const tileSizes: ReadonlySet<unknown> = new Set(TILE_SIZE_ORDER)

/** Validated; unknown values fall back to the defaults. */
export function readSettings(value: unknown): PanelSettings {
  const v = (value ?? {}) as Partial<Record<keyof PanelSettings, unknown>> & { v?: unknown }
  const oldDefaultUsesBytes = v.v === 1
  // Before v3 hidden entries were off by default, and every save stored that.
  const hiddenChosen = v.v === SETTINGS_VERSION
  return {
    sizeFormat: v.sizeFormat === "bytes" && !oldDefaultUsesBytes ? "bytes" : "units",
    dateFormat: v.dateFormat === "iso" ? "iso" : "locale",
    showHidden: hiddenChosen ? v.showHidden !== false : true,
    showSystem: v.showSystem === true,
    letters: v.letters === "altLetters" ? "altLetters" : "quickSearch",
    mediaOpen: v.mediaOpen === "system" ? "system" : "viewer",
    documentOpen: v.documentOpen === "system" ? "system" : "window",
    rightButton: v.rightButton === "menu" ? "menu" : "mark",
    runPrograms: v.runPrograms === "always" || v.runPrograms === "never" ? v.runPrograms : "ask",
    editor: typeof v.editor === "string" ? v.editor.slice(0, MAX_EDITOR_CHARS) : "",
    compareToleranceMs: v.compareToleranceMs === 0 ? 0 : 2000,
    compareDst: v.compareDst === true,
    compareIgnoreDates: v.compareIgnoreDates === true,
    showToolbar: v.showToolbar !== false,
    showCommandLine: v.showCommandLine !== false,
    showFunctionKeys: v.showFunctionKeys !== false,
    thumbSize: tileSizes.has(v.thumbSize) ? (v.thumbSize as TileSize) : "small",
    copyConflict: policies.has(v.copyConflict) ? (v.copyConflict as ConflictPolicy) : "ask",
    copyVerify: v.copyVerify === true,
    confirmTrash: v.confirmTrash !== false,
    confirmDrop: v.confirmDrop !== false,
    tabBar: v.tabBar === "multiple" ? "multiple" : "always",
    treeFollowCursor: v.treeFollowCursor === true,
  }
}

// Built by the factory both apps use (src/shared/renderer-core).
const store = createSettingsStore<PanelSettings>({
  defaults: DEFAULT_SETTINGS,
  read: readSettings,
  save(settings) {
    if (isBridgeAvailable())
      void bridge
        .setSetting(SETTINGS_KEY, { v: SETTINGS_VERSION, ...settings })
        .catch(() => undefined)
  },
})

export const useSettingsStore = store.useStore
export const updateSettings = store.update
export const setSettingsOpen = store.setOpen
/** A stored value applied without saving it again (the settings window's, ADR-0039). */
export const applyStoredSettings = store.load

/**
 * Settings opens in its native window (ADR-0039), on a tab the native menu
 * asked for; the in-page dialog when the window cannot open.
 */
export function openSettings(): void {
  const openDialog = (): void => store.setOpen(true)
  if (!isBridgeAvailable()) return openDialog()
  openSettingsWindowOr(bridge.openSettingsWindow, openDialog, () =>
    windowClosed.forEach((listener) => listener()),
  )
}

const windowClosed = new Set<() => void>()

/** The settings window closed; AppShell gives the active panel the keys again, as after the dialog. */
export function onSettingsWindowClosed(listener: () => void): () => void {
  windowClosed.add(listener)
  return () => windowClosed.delete(listener)
}
/** Tests. */
export const resetSettings = store.reset

export async function loadSettings(): Promise<void> {
  if (!isBridgeAvailable()) return
  const { settings } = await bridge.library()
  store.load(settings[SETTINGS_KEY])
}
