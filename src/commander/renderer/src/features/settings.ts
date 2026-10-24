import { CONFLICT_POLICIES, type ConflictPolicy } from "@panelyth/contracts"
import { TILE_SIZE_ORDER, type TileSize } from "@panelyth/media-ui"
import { createSettingsStore } from "@panelyth/renderer-core"
import { openSettingsWindowOr, requestSettingsTab } from "@panelyth/ui"
import { bridge, isBridgeAvailable } from "../bridge"

// The commander's own settings (Stage C03, Settings → Panels), under
// commander.* in the shared library.db (ADR-0031). Theme and interface
// size are shared with the viewer and live under shared.*.

export const SETTINGS_KEY = "commander.settings"
/**
 * v3: hidden entries shown by default (older stored values are not a choice).
 * v4: dates have a relative choice, the default ("locale" stored before was the
 * default written with every save, not a choice).
 * v5: relative dates are a setting of their own (`relativeDates`), so they go
 * with either format; `dateFormat` is the format itself.
 */
export const SETTINGS_VERSION = 5

/** The stored settings' version; 0 for none or a malformed one. */
export const settingsVersion = (value: unknown): number => {
  const v = (value as { v?: unknown } | null | undefined)?.v
  return typeof v === "number" && Number.isInteger(v) ? v : 0
}
export const MAX_EDITOR_CHARS = 1024

/**
 * The folder beside a document that pasted and dropped pictures go to (Stage
 * C10.7): one plain name; "" = "assets". The sidecar checks it again.
 */
export function readAssetsFolder(v: unknown): string {
  if (typeof v !== "string") return ""
  const name = v.trim()
  const plain =
    name.length <= 64 &&
    !/[\\/:*?"<>|]/.test(name) &&
    ![...name].some((c) => c.charCodeAt(0) < 32) &&
    name !== "." &&
    name !== ".." &&
    !/[. ]$/.test(name)
  return plain ? name : ""
}

/** Size column: readable units by default, or exact bytes with separators. */
export type SizeFormat = "bytes" | "units"
/** Dates: as the system shows them, or ISO (2026-10-06 14:05). */
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
  /**
   * The lists' Date column says "today at 14:05" for the last week, and the
   * format above for older dates (on by default). Quick View and the
   * dialogs show full dates.
   */
  relativeDates: boolean
  /** Folders stay in name order whatever the panel's sort; files follow it (on by default). */
  sortFoldersByName: boolean
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
  /** F4's editor: an absolute program path; "" = Panelyth's own editor (ADR-0046). Main reads it from library.db. */
  editor: string
  /** Stage C10.7: the folder beside a document for its pictures; "" = "assets". Main reads it from library.db. */
  assetsFolder: string
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
  /** A file operation started here shows its progress in a dialog over the panels (off: in the queue strip only). */
  progressDialog: boolean
  /** Confirmations: F8 asks before moving to the trash; a drop shows the copy dialog first. */
  confirmTrash: boolean
  confirmDrop: boolean
  /** Stage C10.5: when the tab bar shows. */
  tabBar: TabBarMode
  /** The folder tree opens a folder in the panel once its cursor rests on it (off: Enter or a click opens). */
  treeFollowCursor: boolean
  /** Git (ADR-0043): a repository's folders show its status, a badge and the Git bar. */
  showGit: boolean
}

export const DEFAULT_SETTINGS: PanelSettings = {
  sizeFormat: "units",
  dateFormat: "locale",
  relativeDates: true,
  sortFoldersByName: true,
  showHidden: true,
  showSystem: false,
  letters: "quickSearch",
  mediaOpen: "viewer",
  documentOpen: "window",
  rightButton: "mark",
  runPrograms: "ask",
  editor: "",
  assetsFolder: "",
  compareToleranceMs: 2000,
  compareDst: false,
  compareIgnoreDates: false,
  showToolbar: true,
  showCommandLine: true,
  showFunctionKeys: true,
  thumbSize: "small",
  copyConflict: "ask",
  copyVerify: false,
  progressDialog: true,
  confirmTrash: true,
  confirmDrop: true,
  tabBar: "always",
  treeFollowCursor: false,
  showGit: true,
}

const policies: ReadonlySet<unknown> = new Set(CONFLICT_POLICIES)
const tileSizes: ReadonlySet<unknown> = new Set(TILE_SIZE_ORDER)

/** Validated; unknown values fall back to the defaults. */
export function readSettings(value: unknown): PanelSettings {
  const v = (value ?? {}) as Partial<Record<keyof PanelSettings, unknown>> & { v?: unknown }
  const oldDefaultUsesBytes = v.v === 1
  const version = settingsVersion(value)
  // Before v3 hidden entries were off by default, and every save stored that.
  const hiddenChosen = version >= 3
  // Before v4 "locale" was the default every save stored; ISO was always a choice.
  const dateChosen = version >= 4
  // Before v5 the format held the relative choice: "relative", "locale" or "iso".
  const relativeDates =
    version >= 5
      ? v.relativeDates !== false
      : !(v.dateFormat === "iso" || (v.dateFormat === "locale" && dateChosen))
  return {
    sizeFormat: v.sizeFormat === "bytes" && !oldDefaultUsesBytes ? "bytes" : "units",
    dateFormat: v.dateFormat === "iso" ? "iso" : "locale",
    relativeDates,
    sortFoldersByName: v.sortFoldersByName !== false,
    showHidden: hiddenChosen ? v.showHidden !== false : true,
    showSystem: v.showSystem === true,
    letters: v.letters === "altLetters" ? "altLetters" : "quickSearch",
    mediaOpen: v.mediaOpen === "system" ? "system" : "viewer",
    documentOpen: v.documentOpen === "system" ? "system" : "window",
    rightButton: v.rightButton === "menu" ? "menu" : "mark",
    runPrograms: v.runPrograms === "always" || v.runPrograms === "never" ? v.runPrograms : "ask",
    editor: typeof v.editor === "string" ? v.editor.slice(0, MAX_EDITOR_CHARS) : "",
    assetsFolder: readAssetsFolder(v.assetsFolder),
    compareToleranceMs: v.compareToleranceMs === 0 ? 0 : 2000,
    compareDst: v.compareDst === true,
    compareIgnoreDates: v.compareIgnoreDates === true,
    showToolbar: v.showToolbar !== false,
    showCommandLine: v.showCommandLine !== false,
    showFunctionKeys: v.showFunctionKeys !== false,
    thumbSize: tileSizes.has(v.thumbSize) ? (v.thumbSize as TileSize) : "small",
    copyConflict: policies.has(v.copyConflict) ? (v.copyConflict as ConflictPolicy) : "ask",
    copyVerify: v.copyVerify === true,
    progressDialog: v.progressDialog !== false,
    confirmTrash: v.confirmTrash !== false,
    confirmDrop: v.confirmDrop !== false,
    tabBar: v.tabBar === "multiple" ? "multiple" : "always",
    treeFollowCursor: v.treeFollowCursor === true,
    showGit: v.showGit !== false,
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
export function openSettings(options: { section?: string } = {}): void {
  const { section } = options
  const openDialog = (): void => {
    // The dialog shows the commander's tab at that section.
    if (section) {
      requestSettingsTab("commander")
      requestedSection = section
    }
    store.setOpen(true)
  }
  if (!isBridgeAvailable()) return openDialog()
  openSettingsWindowOr(
    (tab) => bridge.openSettingsWindow(section ? "commander" : tab, section),
    openDialog,
    () => windowClosed.forEach((listener) => listener()),
  )
}

/** A section of the commander's tab asked for (the toolbar's "Customize…"); taken once. */
let requestedSection: string | null = null

export function requestSettingsSection(section: string | null): void {
  requestedSection = section
}

export function takeSettingsSection(): string | null {
  const section = requestedSection
  requestedSection = null
  return section
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
