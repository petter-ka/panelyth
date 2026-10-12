import type { LibraryState, Place } from "@panelyth/contracts"
import { openFolder, useFolderStore } from "../folder/folderStore"
import { useLibraryStore } from "../library/libraryStore"
import { openRequestSettled } from "../workspace/openRequest"
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
  // A file opened from the OS decides the first folder; the configured one waits for the answer.
  let asked = false
  const start = (): void => {
    const library = useLibraryStore.getState()
    if (started || !asked || !library.loaded) return
    started = true
    // A folder the user opened before the library loaded wins.
    const { folder, opening } = useFolderStore.getState()
    if (folder || opening) return
    const path = startupFolderPath(library)
    if (path) void openFolder(path)
  }
  void openRequestSettled().then((shown) => {
    asked = true
    if (shown) started = true
    else start()
  })
  return useLibraryStore.subscribe((s) => {
    if (s.loaded) start()
  })
}
