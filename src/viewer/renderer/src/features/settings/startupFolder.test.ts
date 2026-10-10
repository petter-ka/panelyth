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

const home = { id: "home" as const, label: "Home", path: "/home/me" }
let stop: () => void = () => undefined

beforeEach(() => {
  resetFolderStore()
  openFolder.mockClear()
  useLibraryStore.setState({ loaded: false, places: [home], recent: [], settings: {} })
})
afterEach(() => stop())

describe("startup folder", () => {
  it("opens the startup folder once the library loads", () => {
    stop = startStartupFolder()
    expect(openFolder).not.toHaveBeenCalled()
    useLibraryStore.setState({ loaded: true })
    useLibraryStore.setState({ recent: [] })
    expect(openFolder).toHaveBeenCalledTimes(1)
    expect(openFolder).toHaveBeenCalledWith("/home/me")
  })

  it("never replaces a folder the user opened before the library loaded", () => {
    stop = startStartupFolder()
    useFolderStore.setState({ opening: true })
    useLibraryStore.setState({ loaded: true })
    expect(openFolder).not.toHaveBeenCalled()
  })
})
