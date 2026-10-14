import { createSettingsStore } from "@panelyth/renderer-core"
import { openSettingsWindowOr } from "@panelyth/ui"
import { bridge, isBridgeAvailable } from "../../bridge"
import { useLibraryStore } from "../library/libraryStore"

export const VIEWER_SETTINGS_KEY = "viewer"

export type StartupFolderMode = "lastUsed" | "specified" | "systemDefault"
export type WheelMode = "zoom" | "previousNext"

export interface ViewerPreferences {
  v: 1
  startupFolder: StartupFolderMode
  specifiedFolder: string | null
  confirmOnEscapeExit: boolean
  confirmOverwrite: boolean
  remindSaveChanges: boolean
  wheelMode: WheelMode
  /** The name line under image and video tiles; folders always show theirs. */
  showFileNames: boolean
}

export const DEFAULT_VIEWER_PREFERENCES: ViewerPreferences = {
  v: 1,
  startupFolder: "lastUsed",
  specifiedFolder: null,
  confirmOnEscapeExit: true,
  confirmOverwrite: true,
  remindSaveChanges: true,
  wheelMode: "zoom",
  showFileNames: true,
}

const modes: readonly StartupFolderMode[] = ["lastUsed", "specified", "systemDefault"]

export function parseViewerPreferences(value: unknown): ViewerPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return DEFAULT_VIEWER_PREFERENCES
  const v = value as Record<string, unknown>
  return {
    v: 1,
    startupFolder: modes.includes(v.startupFolder as StartupFolderMode)
      ? (v.startupFolder as StartupFolderMode)
      : DEFAULT_VIEWER_PREFERENCES.startupFolder,
    specifiedFolder:
      typeof v.specifiedFolder === "string" && v.specifiedFolder.length > 0
        ? v.specifiedFolder
        : null,
    confirmOnEscapeExit:
      typeof v.confirmOnEscapeExit === "boolean"
        ? v.confirmOnEscapeExit
        : DEFAULT_VIEWER_PREFERENCES.confirmOnEscapeExit,
    confirmOverwrite:
      typeof v.confirmOverwrite === "boolean"
        ? v.confirmOverwrite
        : DEFAULT_VIEWER_PREFERENCES.confirmOverwrite,
    remindSaveChanges:
      typeof v.remindSaveChanges === "boolean"
        ? v.remindSaveChanges
        : DEFAULT_VIEWER_PREFERENCES.remindSaveChanges,
    wheelMode: v.wheelMode === "previousNext" ? "previousNext" : "zoom",
    showFileNames: v.showFileNames !== false,
  }
}

// Built by the factory both apps use (src/shared/renderer-core).
const store = createSettingsStore<ViewerPreferences>({
  defaults: DEFAULT_VIEWER_PREFERENCES,
  read: parseViewerPreferences,
  // Never before the library loaded: the defaults would replace what is stored.
  save(preferences) {
    if (useLibraryStore.getState().loaded)
      void bridge.setSetting(VIEWER_SETTINGS_KEY, preferences).catch(() => undefined)
  },
})

export const useSettingsStore = store.useStore

/**
 * Settings opens in its native window (ADR-0039), on a tab the native menu
 * asked for; the in-page dialog when the window cannot open.
 */
export function openSettings(): void {
  const openDialog = (): void => store.setOpen(true)
  if (!isBridgeAvailable()) return openDialog()
  openSettingsWindowOr(bridge.openSettingsWindow, openDialog, () => {
    // The keys go back to the tiles, unless something else took the focus meanwhile.
    const at = document.activeElement
    if (at === document.body || at?.closest('[data-testid="app-settings"]')) {
      document.querySelector<HTMLElement>('[data-testid="tile-view"]')?.focus()
    }
  })
}
export const closeSettings = (): void => store.setOpen(false)

export function setPreference<K extends keyof Omit<ViewerPreferences, "v">>(
  key: K,
  value: ViewerPreferences[K],
): void {
  store.update({ [key]: value } as Partial<ViewerPreferences>)
}

/**
 * Applies saved settings after each successful library load (including
 * restarts), and a change made in the settings window at once (ADR-0039).
 */
export function startViewerSettingsPersistence(): () => void {
  const load = (settings: Record<string, unknown>): void =>
    store.load(settings[VIEWER_SETTINGS_KEY])
  if (useLibraryStore.getState().loaded) load(useLibraryStore.getState().settings)
  const offLibrary = useLibraryStore.subscribe((s, prev) => {
    if (s.loaded && (!prev.loaded || s.settings !== prev.settings)) load(s.settings)
  })
  const offWindow = isBridgeAvailable()
    ? bridge.on("settings.changed", ({ key, value }) => {
        if (key === VIEWER_SETTINGS_KEY) store.load(value)
      })
    : () => undefined
  return () => {
    offLibrary()
    offWindow()
  }
}
