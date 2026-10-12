import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetFolderStore, useFolderStore } from "../folder/folderStore"
import type * as FolderStore from "../folder/folderStore"
import { useLibraryStore } from "../library/libraryStore"
import { startStartupFolder } from "./startupFolder"

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
