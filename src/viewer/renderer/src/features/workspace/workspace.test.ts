import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeBridge } from "../../test/fakeBridge"
import { resetFolderStore, setSort, useFolderStore } from "../folder/folderStore"
import { resetLibraryStore, useLibraryStore } from "../library/libraryStore"
import { resetLayoutStore, useLayoutStore } from "../tiles/layoutStore"
import { parseWorkspace, readMirror } from "./mirror"
import { setPanes, setPreviewPlace, startWorkspacePersistence, usePaneStore } from "./workspace"

let stop: () => void = () => {}

beforeEach(() => {
  vi.useFakeTimers()
  resetLibraryStore()
  resetLayoutStore()
  resetFolderStore()
  usePaneStore.setState({ panes: null, previewPlace: "left", applyToken: 0 })
})
afterEach(() => {
  stop()
  vi.useRealTimers()
})

describe("workspace persistence", () => {
  it("validates persisted data and falls back to defaults", () => {
    expect(parseWorkspace(null)).toBeNull()
    expect(parseWorkspace({ v: 2 })).toBeNull()
    expect(
      parseWorkspace({
        v: 1,
        tileSize: "huge",
        sort: [
          { field: "colorLabel", direction: "asc" },
          { field: "size", direction: "desc" },
        ],
        panes: { sidebar: 20, content: "x", preview: -5 },
        previewPlace: "top",
      }),
    ).toEqual({
      v: 1,
      tileSize: "medium",
      sort: [{ field: "size", direction: "desc" }],
      panes: { sidebar: 20 },
      previewPlace: "left",
      at: 0,
    })
    expect(parseWorkspace({ v: 1, previewPlace: "right" })?.previewPlace).toBe("right")
  })

  it("migrates the Stage 03 tile size key", () => {
    localStorage.setItem("panelyth.tileSize", "large")
    expect(readMirror().tileSize).toBe("large")
  })

  it("applies library.db over the mirror, then saves changes debounced to both", async () => {
    const bridge = installFakeBridge()
    stop = startWorkspacePersistence()
    // Nothing is written before library.db's copy was applied.
    useLayoutStore.getState().setTileSize("small")
    await vi.advanceTimersByTimeAsync(1000)
    expect(bridge.api.library.setSetting).not.toHaveBeenCalled()

    useLibraryStore.setState({
      loaded: true,
      settings: {
        workspace: {
          v: 1,
          tileSize: "large",
          sort: [{ field: "modified", direction: "desc" }],
          panes: { sidebar: 25, content: 50, preview: 25 },
          at: Date.now() + 60_000, // saved later than the mirror's change above
        },
      },
    })
    expect(useLayoutStore.getState().tileSize).toBe("large")
    expect(useFolderStore.getState().sort).toEqual([{ field: "modified", direction: "desc" }])
    expect(usePaneStore.getState()).toMatchObject({ panes: { sidebar: 25 }, applyToken: 1 })
    expect(readMirror().tileSize).toBe("large")

    setPanes({ sidebar: 30, content: 45, preview: 25 })
    setSort("size", "asc")
    useLayoutStore.getState().setTileSize("medium")
    setPreviewPlace("right")
    await vi.advanceTimersByTimeAsync(299)
    expect(bridge.api.library.setSetting).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(bridge.api.library.setSetting).toHaveBeenCalledTimes(1)
    expect(bridge.api.library.setSetting).toHaveBeenCalledWith("workspace", {
      v: 1,
      panes: { sidebar: 30, content: 45, preview: 25 },
      previewPlace: "right",
      tileSize: "medium",
      sort: [{ field: "size", direction: "asc" }],
      at: expect.any(Number),
    })
    expect(readMirror()).toMatchObject({ tileSize: "medium", panes: { sidebar: 30 } })
  })

  it("writes the mirror at once, so a change right before quitting survives", async () => {
    installFakeBridge()
    stop = startWorkspacePersistence()
    useLibraryStore.setState({ loaded: true, settings: {} })
    useLayoutStore.getState().setTileSize("large")
    expect(readMirror().tileSize).toBe("large") // no debounce for the mirror
    stop()
    stop = () => {}
    // Next start: library.db holds an older copy; the newer mirror wins and is pushed.
    const bridge = installFakeBridge()
    resetLayoutStore()
    stop = startWorkspacePersistence()
    useLibraryStore.setState({
      loaded: false,
    })
    useLibraryStore.setState({
      loaded: true,
      settings: { workspace: { v: 1, tileSize: "small", sort: [], panes: null, at: 1 } },
    })
    expect(useLayoutStore.getState().tileSize).toBe("large")
    await vi.advanceTimersByTimeAsync(300)
    expect(bridge.api.library.setSetting).toHaveBeenCalledWith(
      "workspace",
      expect.objectContaining({ tileSize: "large" }),
    )
  })

  it("stores the mirror's workspace on first run (library.db has none)", async () => {
    const bridge = installFakeBridge()
    stop = startWorkspacePersistence()
    useLayoutStore.getState().setTileSize("small")
    useLibraryStore.setState({ loaded: true, settings: {} })
    await vi.advanceTimersByTimeAsync(300)
    expect(bridge.api.library.setSetting).toHaveBeenCalledWith(
      "workspace",
      expect.objectContaining({ tileSize: "small" }),
    )
  })
})
