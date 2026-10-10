import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ContentPane } from "../../components/ContentPane"
import { installFakeBridge, makeItems } from "../../test/fakeBridge"
import { mockViewport } from "../../test/viewport"
import { openFolder, resetFolderStore, startFolderMonitoring } from "../folder/folderStore"
import { resetLayoutStore } from "../tiles/layoutStore"
import { startSidecarMonitoring, useSidecarStore } from "../system/sidecarStore"
import { resetCovers, startCoverMonitoring } from "./coverStore"
import { resetThumbs, setThumbProfile, startThumbMonitoring } from "./thumbStore"

const url = (n: number) => `panelyth-thumb://t/${String(n).padStart(64, "0")}.jpg`
let stop: (() => void)[] = []

// Two folders (ids 1, 2) followed by three images.
function setup() {
  const bridge = installFakeBridge()
  bridge.backend.items = makeItems(5, 2)
  stop = [
    startSidecarMonitoring(),
    startFolderMonitoring(),
    startThumbMonitoring(),
    startCoverMonitoring(),
  ]
  render(<ContentPane />)
  return bridge
}

const box = (index: number) =>
  screen.getAllByTestId("tile")[index]!.querySelector<HTMLElement>("[data-thumb-box]")!

const coverCalls = (bridge: ReturnType<typeof setup>) =>
  bridge.api.folder.covers.mock.calls.map(
    (c) => c[0] as { lane: string; profile: string; items: { id: number; priority: number }[] },
  )

beforeEach(() => {
  mockViewport(1000, 800)
  localStorage.clear()
  resetLayoutStore()
  resetFolderStore()
  resetThumbs()
  resetCovers()
  setThumbProfile("grid-sm")
  useSidecarStore.setState({ status: null, info: null, pingMs: null, error: null })
})
afterEach(() => {
  stop.forEach((f) => f())
  vi.restoreAllMocks()
})

describe("folder covers", () => {
  it("asks once for the folder tiles only, with the tile profile", async () => {
    const bridge = setup()
    await act(() => openFolder("/photos"))
    await waitFor(() => expect(bridge.api.folder.covers).toHaveBeenCalledTimes(1))
    const [req] = coverCalls(bridge)
    expect(req!.lane).toBe("covers")
    expect(req!.profile).toBe("grid-sm")
    expect(req!.items.map((i) => i.id)).toEqual([1, 2])
    // Without media the folder symbol stays.
    expect(screen.queryByTestId("folder-cover")).toBeNull()
  })

  it("shows ready covers as a mosaic and fills pending slots from events", async () => {
    const bridge = setup()
    bridge.api.folder.covers.mockImplementationOnce(async () => ({
      ok: true as const,
      r: {
        items: [
          {
            dirId: 1,
            slots: [{ url: url(1), width: 192, height: 128 }, { pending: true as const }],
          },
          { dirId: 2, slots: [{ pending: true as const }] },
        ],
      },
    }))
    await act(() => openFolder("/photos"))
    await waitFor(() => expect(box(0).querySelector("[data-testid=folder-cover]")).not.toBeNull())
    expect(box(0).querySelectorAll("img")).toHaveLength(1)
    expect(box(0).querySelector("[data-testid=folder-badge]")).not.toBeNull()
    // All pending: still the folder symbol.
    expect(box(1).querySelector("[data-testid=folder-cover]")).toBeNull()

    act(() =>
      bridge.push("folder.covers", {
        items: [
          { dirId: 1, slot: 1, profile: "grid-sm", url: url(2), width: 192, height: 128 },
          { dirId: 2, slot: 0, profile: "grid-sm", url: url(3), width: 192, height: 128 },
          // Another profile's result is ignored.
          { dirId: 2, slot: 0, profile: "grid-lg", url: url(4), width: 768, height: 512 },
        ],
      }),
    )
    expect(box(0).querySelectorAll("img")).toHaveLength(2)
    expect(box(1).querySelector("img")?.getAttribute("src")).toBe(url(3))
    expect(box(1).querySelector("[data-testid=folder-cover]")?.getAttribute("data-covers")).toBe(
      "1",
    )
  })

  it("does not ask again for folders it already knows", async () => {
    const bridge = setup()
    await act(() => openFolder("/photos"))
    await waitFor(() => expect(bridge.api.folder.covers).toHaveBeenCalledTimes(1))
    // Another settled range (images arriving) must not repeat the folders.
    act(() =>
      bridge.push("preview.ready", {
        items: [{ id: 3, profile: "grid-sm", url: url(9), width: 10, height: 10 }],
      }),
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(bridge.api.folder.covers).toHaveBeenCalledTimes(1)
  })
})
