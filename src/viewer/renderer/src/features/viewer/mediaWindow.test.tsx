import { act, render, screen, waitFor } from "@testing-library/react"
import { useAppLoading } from "@panelyth/ui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ContentPane } from "../../components/ContentPane"
import { installFakeBridge, makeItems } from "../../test/fakeBridge"
import { mockViewport } from "../../test/viewport"
import { openFolder, resetFolderStore, startFolderMonitoring } from "../folder/folderStore"
import { resetJobsStore, startJobMonitoring } from "../jobs/jobsStore"
import { startSidecarMonitoring } from "../system/sidecarStore"
import { useSelectionStore } from "../tiles/selectionStore"
import { openFullscreenAt, startMediaWindowHost } from "./viewerStore"

// The full-screen media window asks this window for its files and hands it
// its file keys (copy, cut, paste, Delete); when it closes, the tile view
// selects the file it showed last.

let stop: (() => void)[] = []

/** Folder "folder 1" (id 1), then IMG_1.jpg … IMG_5.jpg (ids 2–6) at indexes 1–5. */
async function setup() {
  const bridge = installFakeBridge()
  bridge.backend.items = makeItems(6, 1)
  const openWindow = vi.fn(async () => ({ ok: true as const, r: { ok: true } }))
  const windowAnswer = vi.fn(async () => ({ ok: true as const, r: { ok: true } }))
  Object.assign(bridge.api.media, { openWindow, windowAnswer })
  stop = [
    startSidecarMonitoring(),
    startFolderMonitoring(),
    startJobMonitoring(),
    startMediaWindowHost(),
  ]
  render(<ContentPane />)
  await act(() => openFolder("/photos/Trip"))
  await screen.findByText("IMG_2.jpg")
  return { bridge, openWindow, windowAnswer }
}

/** Opens IMG_2.jpg (index 2, id 3); returns the window's key. */
async function openImg2(openWindow: ReturnType<typeof vi.fn>): Promise<number> {
  act(() => {
    openFullscreenAt(2)
  })
  await waitFor(() => expect(openWindow).toHaveBeenCalled())
  return (openWindow.mock.calls[0] as unknown as [number, number])[1]
}

beforeEach(() => {
  mockViewport(1000, 800)
  resetFolderStore()
  resetJobsStore()
})
afterEach(() => {
  stop.forEach((f) => f())
  vi.restoreAllMocks()
})

describe("the media window's file keys", () => {
  it("Delete trashes the shown file and answers with the next one", async () => {
    const { bridge, openWindow, windowAnswer } = await setup()
    const key = await openImg2(openWindow)
    await act(async () => {
      bridge.push("mediaWindow.command", { requestId: 5, key, command: "trash" })
    })
    await waitFor(() => expect(windowAnswer).toHaveBeenCalled())
    expect(bridge.backend.jobs.at(-1)).toMatchObject({
      kind: "trash",
      source: { selection: { ranges: [[2, 3]] } },
    })
    expect(windowAnswer).toHaveBeenLastCalledWith(5, expect.objectContaining({ id: 4 }), true)
  })

  it("paste with an empty clipboard does nothing and says so", async () => {
    const { bridge, openWindow, windowAnswer } = await setup()
    const key = await openImg2(openWindow)
    await act(async () => {
      bridge.push("mediaWindow.command", { requestId: 6, key, command: "paste" })
    })
    await waitFor(() =>
      expect(windowAnswer).toHaveBeenLastCalledWith(6, expect.objectContaining({ id: 3 }), false),
    )
    expect(bridge.api.clip.paste).not.toHaveBeenCalled()
  })
})

describe("closing the media window", () => {
  it("selects the file it showed last", async () => {
    const { bridge, openWindow, windowAnswer } = await setup()
    const key = await openImg2(openWindow)
    // The window asks one step at a time.
    for (const requestId of [1, 2]) {
      await act(async () => {
        bridge.push("mediaWindow.step", { requestId, key, direction: 1 })
      })
      await waitFor(() => expect(windowAnswer).toHaveBeenCalledTimes(requestId))
    }
    await waitFor(() =>
      expect(windowAnswer).toHaveBeenLastCalledWith(
        2,
        expect.objectContaining({ id: 5 }),
        undefined,
      ),
    )
    act(() => {
      bridge.push("mediaWindow.closed", { key })
    })
    await waitFor(() =>
      expect(useSelectionStore.getState()).toMatchObject({ focusIndex: 4, selectedId: 5 }),
    )
    expect(useSelectionStore.getState().revealToken).toBeGreaterThan(0)
  })
})

describe("Home and End in the media window", () => {
  it("answers with the folder's first and last picture, skipping the subfolder", async () => {
    const { bridge, openWindow, windowAnswer } = await setup()
    const key = await openImg2(openWindow)
    await act(async () => {
      bridge.push("mediaWindow.step", { requestId: 1, key, direction: "last" })
    })
    await waitFor(() =>
      expect(windowAnswer).toHaveBeenLastCalledWith(
        1,
        expect.objectContaining({ id: 6 }),
        undefined,
      ),
    )
    await act(async () => {
      bridge.push("mediaWindow.step", { requestId: 2, key, direction: "first" })
    })
    await waitFor(() =>
      expect(windowAnswer).toHaveBeenLastCalledWith(
        2,
        expect.objectContaining({ id: 2 }),
        undefined,
      ),
    )
    // The window's position follows: the next step goes on from the first picture.
    await act(async () => {
      bridge.push("mediaWindow.step", { requestId: 3, key, direction: 1 })
    })
    await waitFor(() =>
      expect(windowAnswer).toHaveBeenLastCalledWith(
        3,
        expect.objectContaining({ id: 3 }),
        undefined,
      ),
    )
  })
})

describe("opening the media window", () => {
  it("shows the loading screen while main reads the file (a drive spinning up)", async () => {
    const { openWindow } = await setup()
    let opened: () => void = () => undefined
    openWindow.mockImplementation(
      () => new Promise((resolve) => (opened = () => resolve({ ok: true, r: { ok: true } }))),
    )
    act(() => {
      openFullscreenAt(2)
    })
    await waitFor(() => expect(useAppLoading.getState().visible).toBe(true))
    expect(useAppLoading.getState().label).toBe("Opening…")
    await act(async () => opened())
    await waitFor(() => expect(useAppLoading.getState().visible).toBe(false))
  })
})
