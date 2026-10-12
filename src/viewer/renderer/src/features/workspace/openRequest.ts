import type { OpenRequest } from "@panelyth/contracts"
import { bridge, isBridgeAvailable } from "../../bridge"
import { openFolderEntry, useFolderStore } from "../folder/folderStore"
import { selectEntry } from "./appSwitch"

// "Open with" (ADR-0033 amended): a picture or video opened from the OS shows
// in a media window of its own. When the user takes it into the app (a
// double-click there), main asks the viewer to open the file's folder with
// the file selected: with the `open.request` event when the viewer runs
// already, or as the answer to app.openRequest when it was started for this.

let settled: Promise<boolean> | null = null

/** The folder, then the entry in it: selected and scrolled to. */
async function show(request: OpenRequest): Promise<void> {
  await openFolderEntry(request.dirId)
  // The folder may be gone meanwhile; then its usual state shows and nothing is selected.
  if (useFolderStore.getState().folder?.dirId === request.dirId) await selectEntry(request.entryId)
}

/**
 * Asks main once what the app was started to show, and follows later
 * requests; returns the stop function.
 */
export function startOpenRequests(): () => void {
  if (!isBridgeAvailable()) {
    settled = Promise.resolve(false)
    return () => undefined
  }
  settled = bridge
    .takeOpenRequest()
    .then(async (request) => {
      if (!request) return false
      await show(request)
      return true
    })
    .catch(() => false)
  return bridge.on("open.request", (request) => void show(request).catch(() => undefined))
}

/** True when the app was started to show a file's folder (the startup folder is then not opened). */
export function openRequestSettled(): Promise<boolean> {
  return settled ?? Promise.resolve(false)
}

/** Tests. */
export function resetOpenRequests(): void {
  settled = null
}
