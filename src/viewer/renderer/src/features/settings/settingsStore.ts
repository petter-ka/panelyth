import { create } from "zustand"
import { bridge } from "../../bridge"
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

interface SettingsState {
  open: boolean
  preferences: ViewerPreferences
  openSettings(): void
  closeSettings(): void
  setPreference<K extends keyof Omit<ViewerPreferences, "v">>(
    key: K,
    value: ViewerPreferences[K],
  ): void
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  open: false,
  preferences: DEFAULT_VIEWER_PREFERENCES,
  openSettings: () => set({ open: true }),
  closeSettings: () => set({ open: false }),
  setPreference(key, value) {
    const preferences = { ...get().preferences, [key]: value, v: 1 } as ViewerPreferences
    set({ preferences })
    if (useLibraryStore.getState().loaded)
      void bridge.setSetting(VIEWER_SETTINGS_KEY, preferences).catch(() => undefined)
  },
}))

/** Applies saved settings after each successful library load (including restarts). */
export function startViewerSettingsPersistence(): () => void {
  const load = (settings: Record<string, unknown>): void =>
    useSettingsStore.setState({
      preferences: parseViewerPreferences(settings[VIEWER_SETTINGS_KEY]),
    })
  if (useLibraryStore.getState().loaded) load(useLibraryStore.getState().settings)
  return useLibraryStore.subscribe((s, prev) => {
    if (s.loaded && (!prev.loaded || s.settings !== prev.settings)) load(s.settings)
  })
}
