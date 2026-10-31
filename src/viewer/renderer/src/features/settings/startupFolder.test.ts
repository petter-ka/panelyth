import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetFolderStore, useFolderStore } from "../folder/folderStore"
import type * as FolderStore from "../folder/folderStore"
import { useLibraryStore } from "../library/libraryStore"
import { STARTUP_PENDING_MAX_MS, startStartupFolder, useStartupStore } from "./startupFolder"

const openFolder = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock("../folder/folderStore", async (importOriginal) => ({
  ...(await importOriginal<typeof FolderStore>()),
  openFolder,
}))
// Whether the app was started to show a file's folder ("Open with").
const openRequest = vi.hoisted(() => ({ shown: false }))
vi.mock("../workspace/openRequest", () => ({
  openRequestSettled: async () => openRequest.shown,
}))

const home = { id: "home" as const, label: "Home", path: "/home/me" }
let stop: () => void = () => undefined
/** The answer about a file from the OS has arrived. */
const answered = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  resetFolderStore()
  openFolder.mockClear()
  openRequest.shown = false
  useLibraryStore.setState({ loaded: false, places: [home], recent: [], settings: {} })
})
afterEach(() => stop())

describe("startup folder", () => {
  it("opens the startup folder once the library loads", async () => {
    stop = startStartupFolder()
    await answered()
    expect(openFolder).not.toHaveBeenCalled()
    useLibraryStore.setState({ loaded: true })
    useLibraryStore.setState({ recent: [] })
    expect(openFolder).toHaveBeenCalledTimes(1)
    expect(openFolder).toHaveBeenCalledWith("/home/me")
  })

  it("opens it too when the library loaded before the answer about a file from the OS", async () => {
    stop = startStartupFolder()
    useLibraryStore.setState({ loaded: true })
    // Not yet: a file opened from the OS would decide the first folder.
    expect(openFolder).not.toHaveBeenCalled()
    await answered()
    expect(openFolder).toHaveBeenCalledTimes(1)
    expect(openFolder).toHaveBeenCalledWith("/home/me")
  })

  it("never replaces a folder the user opened before the library loaded", async () => {
    stop = startStartupFolder()
    await answered()
    useFolderStore.setState({ opening: true })
    useLibraryStore.setState({ loaded: true })
    expect(openFolder).not.toHaveBeenCalled()
  })

  it("stays out of the way when the app was started for a file's folder", async () => {
    openRequest.shown = true
    stop = startStartupFolder()
    useLibraryStore.setState({ loaded: true })
    await answered()
    useLibraryStore.setState({ recent: [] })
    expect(openFolder).not.toHaveBeenCalled()
  })
})

// The content shows tiles to come, not "No folder open", until the first folder is decided.
describe("the first folder still being decided", () => {
  it("is pending from the start until the folder is chosen", async () => {
    stop = startStartupFolder()
    expect(useStartupStore.getState().pending).toBe(true)
    await answered()
    expect(useStartupStore.getState().pending).toBe(true)
    useLibraryStore.setState({ loaded: true })
    expect(openFolder).toHaveBeenCalledWith("/home/me")
    expect(useStartupStore.getState().pending).toBe(false)
  })

  it("is decided by a file from the OS, and by an app with no folder to open", async () => {
    openRequest.shown = true
    stop = startStartupFolder()
    await answered()
    expect(useStartupStore.getState().pending).toBe(false)
    stop()
    openRequest.shown = false
    useLibraryStore.setState({ loaded: false, places: [], recent: [], settings: {} })
    stop = startStartupFolder()
    await answered()
    useLibraryStore.setState({ loaded: true })
    expect(openFolder).not.toHaveBeenCalled()
    expect(useStartupStore.getState().pending).toBe(false)
  })

  it("gives up after a while when the library never loads", async () => {
    vi.useFakeTimers()
    try {
      stop = startStartupFolder()
      expect(useStartupStore.getState().pending).toBe(true)
      vi.advanceTimersByTime(STARTUP_PENDING_MAX_MS)
      expect(useStartupStore.getState().pending).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
