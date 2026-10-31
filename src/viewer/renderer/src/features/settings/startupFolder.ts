import type { LibraryState, Place } from "@panelyth/contracts"
import { create } from "zustand"
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

/**
 * The first folder is still being decided (the library loading, a file from
 * the OS being asked about): the content shows its tile placeholder meanwhile,
 * not "No folder open" (docs/shared/APP-SWITCHING.md, "Loading screen").
 */
export const useStartupStore = create<{ pending: boolean }>(() => ({ pending: false }))

/** Never longer: a library that does not load leaves the empty state to say so. */
export const STARTUP_PENDING_MAX_MS = 10_000

/** Opens the configured folder once, after places, settings and recents load. */
export function startStartupFolder(): () => void {
  let started = false
  // A file opened from the OS decides the first folder; the configured one waits for the answer.
  let asked = false
  useStartupStore.setState({ pending: true })
  const settle = (): void => useStartupStore.setState({ pending: false })
  const cap = setTimeout(settle, STARTUP_PENDING_MAX_MS)
  // Once decided, an open under way (opening) takes over from the placeholder.
  const decided = (): void => {
    clearTimeout(cap)
    settle()
  }
  const start = (): void => {
    const library = useLibraryStore.getState()
    if (started || !asked || !library.loaded) return
    started = true
    // A folder the user opened before the library loaded wins.
    const { folder, opening } = useFolderStore.getState()
    if (!folder && !opening) {
      const path = startupFolderPath(library)
      if (path) void openFolder(path)
    }
    decided()
  }
  void openRequestSettled().then((shown) => {
    asked = true
    if (shown) {
      started = true
      decided()
    } else start()
  })
  const off = useLibraryStore.subscribe((s) => {
    if (s.loaded) start()
  })
  return () => {
    off()
    decided()
  }
}
