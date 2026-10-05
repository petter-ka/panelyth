import type { LibraryState, Place } from "@fastview/contracts"
import { openFolder } from "../folder/folderStore"
import { useLibraryStore } from "../library/libraryStore"
import { parseViewerPreferences, VIEWER_SETTINGS_KEY } from "./settingsStore"

/** Resolves the startup choice without guessing or constructing a platform path. */
export function startupFolderPath(
  library: Pick<LibraryState, "recent" | "settings"> & { places: Place[] },
): string | null {
  const preferences = parseViewerPreferences(library.settings[VIEWER_SETTINGS_KEY])
  const home = library.places.find((place) => place.id === "home")?.path ?? library.places[0]?.path
  if (preferences.startupFolder === "specified") return preferences.specifiedFolder ?? home ?? null
  if (preferences.startupFolder === "lastUsed") return library.recent[0]?.path ?? home ?? null
  return home ?? null
}

/** Opens the configured folder once, after places, settings and recents load. */
export function startStartupFolder(): () => void {
  let started = false
  const start = (): void => {
    const library = useLibraryStore.getState()
    if (started || !library.loaded) return
    started = true
    const path = startupFolderPath(library)
    if (path) void openFolder(path)
  }
  start()
  return useLibraryStore.subscribe((s) => {
    if (s.loaded) start()
  })
}
