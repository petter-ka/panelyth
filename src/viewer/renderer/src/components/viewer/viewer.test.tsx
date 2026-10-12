import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AppShell } from "../../app/AppShell"
import {
  openFolder,
  resetFolderStore,
  startFolderMonitoring,
} from "../../features/folder/folderStore"
import { resetThumbs, startThumbMonitoring } from "../../features/previews/thumbStore"
import { resetLayoutStore } from "../../features/tiles/layoutStore"
import { useSelectionStore } from "../../features/tiles/selectionStore"
import { startSidecarMonitoring, useSidecarStore } from "../../features/system/sidecarStore"
import { resetViewerImages, startViewerImageMonitoring } from "../../features/viewer/viewerImages"
import { resetViewer, useViewerStore } from "../../features/viewer/viewerStore"
import { setPreference } from "../../features/settings/settingsStore"
import { installFakeBridge, makeItems } from "../../test/fakeBridge"
import { mockViewport } from "../../test/viewport"

const fitUrl = (id: number) => `panelyth-thumb://t/${String(id).padStart(64, "f")}.jpg`

let stop: (() => void)[] = []

/** 2 folders, then images; item ids are index + 1. */
async function setup(items = makeItems(20, 2)) {
  const bridge = installFakeBridge()
  bridge.backend.items = items
  stop = [
    startSidecarMonitoring(),
    startFolderMonitoring(),
    startThumbMonitoring(),
    startViewerImageMonitoring(),
  ]
  render(<AppShell />)
  await act(() => openFolder("/photos"))
  return bridge
}

const viewer = () => screen.getByTestId("viewer")
const imageViewer = () => screen.getByTestId("image-viewer")
const key = (el: HTMLElement, k: string) => act(async () => void fireEvent.keyDown(el, { key: k }))

function readyFit(bridge: Awaited<ReturnType<typeof setup>>, id: number, w = 2560, h = 1920) {
  act(() =>
    bridge.push("preview.ready", {
      items: [{ id, profile: "viewer-fit", url: fitUrl(id), width: w, height: h }],
    }),
  )
}

beforeEach(() => {
  mockViewport(1000, 800)
  localStorage.clear()
  resetLayoutStore()
  resetFolderStore()
  resetThumbs()
  resetViewer()
  resetViewerImages()
  useSidecarStore.setState({ status: null, info: null, pingMs: null, error: null })
})
afterEach(() => {
  stop.forEach((f) => f())
  vi.restoreAllMocks()
})

async function openOn(index: number) {
  const view = screen.getByTestId("tile-view")
  act(() => useSelectionStore.setState({ focusIndex: index, selectedId: index + 1 }))
  await key(view, "Enter")
}

describe("image viewer", () => {
  it("opens from an image tile with Enter, but not from a folder", async () => {
    await setup()
    await openOn(0) // folder
    expect(screen.queryByTestId("viewer")).not.toBeInTheDocument()
    await openOn(2) // IMG_2.jpg
    expect(viewer()).toHaveAttribute("data-entry-id", "3")
    expect(screen.getByTestId("viewer-name")).toHaveTextContent("IMG_2.jpg")
    expect(viewer()).toHaveTextContent("3 / 20")
  })

  it("opens with a double-click on an image tile", async () => {
    await setup()
    await act(async () => fireEvent.doubleClick(await screen.findByText("IMG_4.jpg")))
    expect(viewer()).toHaveAttribute("data-entry-id", "5")
  })

  it("requests the viewer-fit preview for the image and its neighbours", async () => {
    const bridge = await setup()
    await openOn(5)
    await waitFor(() =>
      expect(bridge.api.preview.ensure).toHaveBeenCalledWith(
        expect.objectContaining({
          lane: "viewer",
          profile: "viewer-fit",
          items: [
            { id: 6, priority: 0 },
            { id: 7, priority: 1 },
            { id: 5, priority: 1 },
          ],
        }),
      ),
    )
    expect(bridge.api.media.open).toHaveBeenCalledWith(6)
  })

  it("shows the preview layer once decoded, fitted to the window", async () => {
    const bridge = await setup()
    await openOn(5)
    readyFit(bridge, 6)
    await waitFor(() => expect(imageViewer()).toHaveAttribute("data-layer", "fit"))
    // 4000×3000 original (from media.open) in a 1000×800 view at 1× → 25 %.
    await waitFor(() => expect(screen.getByTestId("viewer-zoom")).toHaveTextContent("25%"))
    expect(imageViewer()).toHaveAttribute("data-mode", "fit")
  })

  it("loads the original only when zooming past the preview's resolution", async () => {
    const bridge = await setup()
    await openOn(5)
    readyFit(bridge, 6)
    await waitFor(() => expect(imageViewer()).toHaveAttribute("data-layer", "fit"))
    expect(screen.queryByTestId("viewer-original-layer")).not.toBeInTheDocument()
    await key(viewer(), "1") // 100 %: 4000 px needed, preview has 2560
    await waitFor(() => expect(imageViewer()).toHaveAttribute("data-layer", "original"))
    expect(screen.getByTestId("viewer-original-layer")).toHaveAttribute(
      "src",
      "panelyth-media://m/" + "6".padStart(32, "0"),
    )
    expect(screen.getByTestId("viewer-zoom")).toHaveTextContent("100%")
    await key(viewer(), "0")
    expect(screen.getByTestId("viewer-zoom")).toHaveTextContent("25%")
  })

  it("zooms with + and −, clamped to 800 %", async () => {
    const bridge = await setup()
    await openOn(5)
    readyFit(bridge, 6)
    await waitFor(() => expect(screen.getByTestId("viewer-zoom")).toHaveTextContent("25%"))
    await key(viewer(), "+")
    expect(screen.getByTestId("viewer-zoom")).toHaveTextContent("31%")
    await key(viewer(), "-")
    expect(screen.getByTestId("viewer-zoom")).toHaveTextContent("25%")
    for (let i = 0; i < 30; i++) await key(viewer(), "+")
    expect(screen.getByTestId("viewer-zoom")).toHaveTextContent("800%")
  })

  it("steps through images with ←/→, skipping folders and videos, and stops at the ends", async () => {
    const items = makeItems(8, 2)
    items[4] = { ...items[4]!, kind: "video", ext: "mp4", name: "clip.mp4" }
    await setup(items)
    await openOn(3)
    await key(viewer(), "ArrowRight")
    expect(viewer()).toHaveAttribute("data-index", "5") // 4 is a video
    await key(viewer(), "End")
    expect(viewer()).toHaveAttribute("data-index", "7")
    await key(viewer(), "ArrowRight") // last image: stays
    expect(viewer()).toHaveAttribute("data-index", "7")
    await key(viewer(), "Home")
    expect(viewer()).toHaveAttribute("data-index", "2") // first image after the 2 folders
    await key(viewer(), "ArrowLeft")
    expect(viewer()).toHaveAttribute("data-index", "2")
  })

  it("steps into pages the tile view has not loaded", async () => {
    const bridge = await setup(makeItems(1000))
    await openOn(255)
    await key(viewer(), "ArrowRight")
    await waitFor(() => expect(viewer()).toHaveAttribute("data-index", "256"))
    expect(bridge.api.query.page).toHaveBeenCalledWith(expect.objectContaining({ offset: 256 }))
  })

  it("Esc closes and selects the last image shown", async () => {
    await setup()
    await openOn(3)
    await key(viewer(), "ArrowRight")
    await key(viewer(), "Escape")
    expect(screen.queryByTestId("viewer")).not.toBeInTheDocument()
    expect(useSelectionStore.getState()).toMatchObject({ focusIndex: 4, selectedId: 5 })
    expect(useViewerStore.getState().open).toBe(false)
  })

  it("falls back to the original when the preview cannot be generated", async () => {
    const bridge = await setup()
    await openOn(5)
    act(() =>
      bridge.push("preview.ready", {
        items: [{ id: 6, profile: "viewer-fit", failed: "CACHE_ERROR" }],
      }),
    )
    await waitFor(() => expect(imageViewer()).toHaveAttribute("data-layer", "original"))
    expect(screen.queryByText("This image can't be displayed")).not.toBeInTheDocument()
  })

  it("a failed image shows a recoverable error; Try again forces regeneration", async () => {
    const bridge = await setup()
    // No original the browser can show (e.g. TIFF): the preview is the only source.
    bridge.api.media.open.mockResolvedValue({
      ok: true,
      r: { url: null, kind: "image", mime: "image/tiff", width: 4000, height: 3000 },
    } as never)
    await openOn(5)
    act(() =>
      bridge.push("preview.ready", {
        items: [{ id: 6, profile: "viewer-fit", failed: "CORRUPT_MEDIA" }],
      }),
    )
    expect(await screen.findByText("This image can't be displayed")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Try again" }))
    await waitFor(() =>
      expect(bridge.api.preview.ensure).toHaveBeenCalledWith(
        expect.objectContaining({ lane: "viewer", force: [6], items: [{ id: 6, priority: 0 }] }),
      ),
    )
    readyFit(bridge, 6)
    await waitFor(() => expect(imageViewer()).toHaveAttribute("data-layer", "fit"))
    // Navigation keeps working from an error state.
    await key(viewer(), "ArrowRight")
    expect(viewer()).toHaveAttribute("data-entry-id", "7")
  })

  it("wheel zooms around the cursor", async () => {
    const bridge = await setup()
    await openOn(5)
    readyFit(bridge, 6)
    await waitFor(() => expect(screen.getByTestId("viewer-zoom")).toHaveTextContent("25%"))
    act(() => {
      imageViewer().dispatchEvent(
        new WheelEvent("wheel", { deltaY: -400, clientX: 700, clientY: 300, cancelable: true }),
      )
    })
    expect(imageViewer()).toHaveAttribute("data-mode", "free")
    expect(Number(imageViewer().dataset.zoom)).toBeGreaterThan(0.25)
  })

  // Stage P04: a trackpad sends a stream of wheel events, and the picture
  // (with its wheel handler) is replaced at every step.
  it("a stream of wheel events steps through pictures by distance, not per event", async () => {
    setPreference("wheelMode", "previousNext")
    await setup()
    await openOn(5)
    expect(viewer()).toHaveAttribute("data-entry-id", "6")
    const now = vi.spyOn(performance, "now")
    const wheel = async (at: number, deltaY: number): Promise<void> => {
      now.mockReturnValue(at)
      await act(async () => {
        imageViewer().dispatchEvent(new WheelEvent("wheel", { deltaY, cancelable: true }))
      })
    }
    // 8 events in 112 ms, 240 px: one step now, the next when 140 ms passed.
    for (let i = 0; i < 8; i++) await wheel(10_000 + i * 16, 30)
    expect(viewer()).toHaveAttribute("data-entry-id", "7")
    await wheel(10_144, 30)
    expect(viewer()).toHaveAttribute("data-entry-id", "8")
    // A slow drag back: 40 events of 2 px (80 px) are one step, not five.
    for (let i = 0; i < 40; i++) await wheel(20_000 + i * 16, -2)
    expect(viewer()).toHaveAttribute("data-entry-id", "7")
  })
})
