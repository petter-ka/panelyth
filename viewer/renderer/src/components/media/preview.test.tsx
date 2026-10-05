import type { ContentItem } from "@fastview/contracts"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AppShell } from "../../app/AppShell"
import {
  openFolder,
  resetFolderStore,
  startFolderMonitoring,
} from "../../features/folder/folderStore"
import {
  codecName,
  formatTime,
  problemFromCode,
  problemFromMediaError,
  unsupportedDetail,
  useVideoPrefs,
} from "../../features/media/video"
import {
  resetPreview,
  SETTLE_MS,
  startPreviewTracking,
  usePreviewStore,
} from "../../features/preview/previewStore"
import {
  getThumbProfile,
  resetThumbs,
  startThumbMonitoring,
} from "../../features/previews/thumbStore"
import { resetLayoutStore } from "../../features/tiles/layoutStore"
import { getItem } from "../../features/tiles/pageStore"
import { focusAndSelect, selectAll } from "../../features/tiles/selectionStore"
import { startSidecarMonitoring, useSidecarStore } from "../../features/system/sidecarStore"
import { resetViewerImages, startViewerImageMonitoring } from "../../features/viewer/viewerImages"
import { resetViewer, useViewerStore } from "../../features/viewer/viewerStore"
import { installFakeBridge, makeItems } from "../../test/fakeBridge"
import { mockViewport } from "../../test/viewport"

const tokenUrl = (id: number) => `fastview-media://m/${String(id).padStart(32, "0")}`
const fitUrl = (id: number) => `fastview-thumb://t/${String(id).padStart(64, "f")}.jpg`

/** Folder, images, then videos: ids are index + 1. */
function mixedItems(): ContentItem[] {
  const items = makeItems(6, 1)
  for (const i of [4, 5]) {
    items[i] = { ...items[i]!, kind: "video", ext: "mp4", name: `clip_${i}.mp4` }
  }
  return items
}

const videoInfo = (id: number, over: Record<string, unknown> = {}) => ({
  ok: true,
  r: {
    url: tokenUrl(id),
    kind: "video",
    mime: "video/mp4",
    width: 1920,
    height: 1080,
    durationMs: 42_000,
    videoCodec: "h264",
    audioCodec: "aac",
    ...over,
  },
})

let stop: (() => void)[] = []
let play: ReturnType<typeof vi.fn>
let pause: ReturnType<typeof vi.fn>
let load: ReturnType<typeof vi.fn>

async function setup(items = mixedItems()) {
  const bridge = installFakeBridge()
  bridge.backend.items = items
  bridge.api.media.open.mockImplementation(async (id: number) => {
    const item = items[id - 1]!
    if (item.kind === "video") return videoInfo(id) as never
    return {
      ok: true,
      r: {
        url: tokenUrl(id),
        kind: "image",
        mime: "image/jpeg",
        width: 4000,
        height: 3000,
        durationMs: 0,
        videoCodec: "",
        audioCodec: "",
      },
    } as never
  })
  stop = [
    startSidecarMonitoring(),
    startFolderMonitoring(),
    startThumbMonitoring(),
    startViewerImageMonitoring(),
    startPreviewTracking(),
  ]
  render(<AppShell />)
  await act(() => openFolder("/media"))
  return bridge
}

/** Selects index (a plain click) and waits for the pane to settle on it. */
async function select(index: number) {
  act(() => focusAndSelect(index, index + 1))
  await waitFor(() => expect(pane()).toHaveAttribute("data-entry-id", String(index + 1)))
}

const pane = () => screen.getByTestId("preview-pane")
const player = () => screen.getByTestId("video-player")
const videoEl = () => screen.getByTestId("video-element") as HTMLVideoElement

beforeEach(() => {
  mockViewport(1400, 900)
  resetLayoutStore()
  resetFolderStore()
  resetThumbs()
  resetViewer()
  resetViewerImages()
  resetPreview()
  useVideoPrefs.setState({ volume: 1, muted: false })
  useSidecarStore.setState({ status: null, info: null, pingMs: null, error: null })
  // jsdom implements no media playback.
  const paused = new WeakMap<HTMLMediaElement, boolean>()
  play = vi.fn(function (this: HTMLMediaElement) {
    paused.set(this, false)
    this.dispatchEvent(new Event("play"))
    return Promise.resolve()
  })
  pause = vi.fn(function (this: HTMLMediaElement) {
    paused.set(this, true)
    this.dispatchEvent(new Event("pause"))
  })
  vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    return paused.get(this) ?? true
  })
  load = vi.fn()
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play as never)
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause as never)
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(load as never)
})
afterEach(() => {
  stop.forEach((f) => f())
  cleanup() // unmount players while play/pause/load are still stubbed
  vi.restoreAllMocks()
})

describe("video helpers", () => {
  it("formats times with hours only when needed", () => {
    expect(formatTime(0)).toBe("0:00")
    expect(formatTime(65.9)).toBe("1:05")
    expect(formatTime(3723)).toBe("1:02:03")
    expect(formatTime(NaN)).toBe("0:00")
    expect(formatTime(Infinity)).toBe("0:00")
  })

  it("names codecs and explains unsupported formats", () => {
    expect(codecName("hevc")).toBe("H.265 (HEVC)")
    expect(codecName("xyz")).toBe("XYZ")
    expect(unsupportedDetail("hevc", "aac")).toBe(
      "H.265 (HEVC) video isn't supported by the built-in player.",
    )
    expect(unsupportedDetail("", "ac3")).toContain("Dolby Digital (AC-3) audio")
    expect(unsupportedDetail("", "")).toContain("This format")
  })

  it("classifies failures", () => {
    expect(problemFromCode("NOT_FOUND")).toBe("missing")
    expect(problemFromCode("PERMISSION_DENIED")).toBe("missing")
    expect(problemFromCode("CORRUPT_MEDIA")).toBe("damaged")
    expect(problemFromCode("UNSUPPORTED_MEDIA")).toBe("unsupported")
    expect(problemFromMediaError(2)).toBe("missing")
    expect(problemFromMediaError(3)).toBe("unsupported")
    expect(problemFromMediaError(4)).toBe("unsupported")
  })
})

describe("preview pane", () => {
  it("shows the selected image with fit and zoom on the pane lane", async () => {
    const bridge = await setup()
    await select(2)
    expect(pane()).toHaveAttribute("data-entry-id", "3")
    expect(within(pane()).getByTestId("image-viewer")).toBeInTheDocument()
    expect(bridge.api.media.open).toHaveBeenCalledWith(3)
    expect(bridge.api.preview.ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: "pane",
        profile: "viewer-fit",
        items: [{ id: 3, priority: 0 }],
      }),
    )
    act(() =>
      bridge.push("preview.ready", {
        items: [{ id: 3, profile: "viewer-fit", url: fitUrl(3), width: 2560, height: 1920 }],
      }),
    )
    // 4000×3000 in a 1400×900 box at 1× → 30 %.
    await waitFor(() => expect(screen.getByTestId("pane-zoom")).toHaveTextContent("30%"))
    fireEvent.click(within(pane()).getByRole("button", { name: "1:1" }))
    expect(screen.getByTestId("pane-zoom")).toHaveTextContent("100%")
    fireEvent.click(within(pane()).getByRole("button", { name: "Zoom out" }))
    expect(screen.getByTestId("pane-zoom")).toHaveTextContent("80%")
    fireEvent.click(within(pane()).getByRole("button", { name: "Fit" }))
    expect(screen.getByTestId("pane-zoom")).toHaveTextContent("30%")
    expect(screen.getByTestId("preview-details")).toHaveTextContent("4000 × 3000")
  })

  it("waits for the selection to settle before loading anything", async () => {
    const bridge = await setup(makeItems(40))
    await waitFor(() => expect(getItem(21)).toBeDefined())
    resetPreview() // forget the selection resets made while opening the folder
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    try {
      act(() => focusAndSelect(0, 1)) // first change after a quiet period: immediate
      expect(bridge.api.media.open).toHaveBeenCalledTimes(1)
      // A held arrow key: 20 changes 30 ms apart.
      for (let i = 1; i <= 20; i++) {
        act(() => focusAndSelect(i, i + 1))
        act(() => void vi.advanceTimersByTime(30))
      }
      expect(bridge.api.media.open).toHaveBeenCalledTimes(1)
      act(() => void vi.advanceTimersByTime(SETTLE_MS))
      expect(bridge.api.media.open).toHaveBeenCalledTimes(2)
      expect(bridge.api.media.open).toHaveBeenLastCalledWith(21)
      expect(pane()).toHaveAttribute("data-entry-id", "21")
    } finally {
      vi.useRealTimers()
    }
  })

  it("summarizes a multi-selection and empties when nothing is selected", async () => {
    await setup()
    await select(2)
    act(() => selectAll(6))
    await waitFor(() => expect(pane()).toHaveTextContent("6 items selected"))
    expect(within(pane()).queryByTestId("image-viewer")).not.toBeInTheDocument()
    act(() => resetPreview())
    expect(pane()).toHaveTextContent("Nothing selected")
  })
})

describe("video player", () => {
  it("plays the original through a token URL with the cached poster", async () => {
    const bridge = await setup()
    await select(4)
    await waitFor(() => expect(player()).toHaveAttribute("data-state", "ready"))
    expect(videoEl()).toHaveAttribute("src", tokenUrl(5))
    expect(videoEl()).toHaveAttribute("preload", "metadata")
    // Duration is known from the probe before any metadata loads.
    expect(screen.getByTestId("video-time")).toHaveTextContent("0:00 / 0:42")
    expect(screen.getByTestId("preview-details")).toHaveTextContent("1920 × 1080 · 0:42")
    act(() =>
      bridge.push("preview.ready", {
        items: [{ id: 5, profile: "viewer-fit", url: fitUrl(5), width: 1920, height: 1080 }],
      }),
    )
    await waitFor(() => expect(videoEl()).toHaveAttribute("poster", fitUrl(5)))

    fireEvent.click(within(player()).getByRole("button", { name: "Play" }))
    expect(play).toHaveBeenCalled()
    expect(player()).toHaveAttribute("data-state", "playing")
    fireEvent.click(within(player()).getByRole("button", { name: "Pause" }))
    expect(player()).toHaveAttribute("data-state", "paused")
  })

  it("seeks, follows time updates and steps with the keyboard", async () => {
    await setup()
    await select(4)
    await waitFor(() => expect(player()).toHaveAttribute("data-state", "ready"))
    fireEvent.change(screen.getByTestId("video-seek"), { target: { value: "30" } })
    expect(videoEl().currentTime).toBe(30)
    expect(screen.getByTestId("video-time")).toHaveTextContent("0:30 / 0:42")
    fireEvent.keyDown(player(), { key: "ArrowLeft" })
    expect(videoEl().currentTime).toBe(25)
    fireEvent.keyDown(player(), { key: "End" })
    expect(videoEl().currentTime).toBe(42)
    videoEl().currentTime = 12
    fireEvent.timeUpdate(videoEl())
    expect(screen.getByTestId("video-time")).toHaveTextContent("0:12 / 0:42")
    fireEvent.keyDown(player(), { key: " " })
    expect(play).toHaveBeenCalled()
  })

  it("keeps volume and mute from one video to the next", async () => {
    await setup()
    await select(4)
    await waitFor(() => expect(player()).toHaveAttribute("data-state", "ready"))
    fireEvent.change(screen.getByTestId("video-volume"), { target: { value: "0.4" } })
    expect(videoEl().volume).toBeCloseTo(0.4)
    fireEvent.click(within(player()).getByRole("button", { name: "Mute" }))
    expect(videoEl().muted).toBe(true)
    await select(5)
    await waitFor(() => expect(videoEl()).toHaveAttribute("src", tokenUrl(6)))
    expect(videoEl().muted).toBe(true)
    expect(videoEl().volume).toBeCloseTo(0.4)
    fireEvent.keyDown(player(), { key: "m" })
    expect(videoEl().muted).toBe(false)
  })

  it("stops and releases the video when the selection moves on", async () => {
    await setup()
    await select(4)
    await waitFor(() => expect(player()).toHaveAttribute("data-state", "ready"))
    fireEvent.click(within(player()).getByRole("button", { name: "Play" }))
    const el = videoEl()
    await select(2)
    expect(screen.queryByTestId("video-player")).not.toBeInTheDocument()
    expect(pause).toHaveBeenCalled()
    expect(load).toHaveBeenCalled() // src removed, decoder released
    expect(el.hasAttribute("src")).toBe(false)
  })

  it("stops when the focused image viewer opens over the pane", async () => {
    const items = mixedItems()
    await setup(items)
    await select(4)
    await waitFor(() => expect(player()).toHaveAttribute("data-state", "ready"))
    fireEvent.click(within(player()).getByRole("button", { name: "Play" }))
    act(() => useViewerStore.setState({ open: true, index: 2, item: items[2]! }))
    expect(screen.queryByTestId("video-player")).not.toBeInTheDocument()
    expect(pause).toHaveBeenCalled()
    act(() => useViewerStore.setState({ open: false }))
    expect(player()).toBeInTheDocument()
  })

  it("Enter on a video tile selects it and starts playback in the pane", async () => {
    await setup()
    const view = screen.getByTestId("tile-view")
    act(() => focusAndSelect(5, 6))
    await act(async () => void fireEvent.keyDown(view, { key: "Enter" }))
    await waitFor(() => expect(play).toHaveBeenCalled())
    expect(pane()).toHaveAttribute("data-entry-id", "6")
    expect(screen.queryByTestId("viewer")).not.toBeInTheDocument()
    expect(usePreviewStore.getState().play).toMatchObject({ id: 6 })
  })

  it("double-click on a video tile plays it full screen; Enter plays in the pane", async () => {
    await setup()
    const requestFullscreen = vi.fn(function (this: HTMLElement) {
      return Promise.resolve()
    })
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    })
    try {
      const tile = await screen.findByText("clip_5.mp4")
      await act(async () => void fireEvent.doubleClick(tile))
      await waitFor(() => expect(play).toHaveBeenCalled())
      expect(requestFullscreen).toHaveBeenCalledTimes(1)
      expect(requestFullscreen.mock.contexts[0]).toBe(player())
      expect(player()).toHaveAttribute("data-state", "playing")
      expect(usePreviewStore.getState().play).toMatchObject({ id: 6, fullscreen: true })

      // Enter keeps playback in the pane.
      act(() => focusAndSelect(4, 5))
      await act(
        async () => void fireEvent.keyDown(screen.getByTestId("tile-view"), { key: "Enter" }),
      )
      await waitFor(() => expect(pane()).toHaveAttribute("data-entry-id", "5"))
      expect(usePreviewStore.getState().play).toMatchObject({ id: 5, fullscreen: false })
      expect(requestFullscreen).toHaveBeenCalledTimes(1)
    } finally {
      delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen
    }
  })

  it("an unsupported codec shows why, with Open with default app", async () => {
    const bridge = await setup()
    bridge.api.media.open.mockResolvedValueOnce(videoInfo(5, { videoCodec: "hevc" }) as never)
    await select(4)
    await waitFor(() => expect(player()).toHaveAttribute("data-state", "ready"))
    Object.defineProperty(videoEl(), "error", { value: { code: 4 } })
    fireEvent.error(videoEl())
    expect(player()).toHaveAttribute("data-problem", "unsupported")
    expect(player()).toHaveTextContent("This video can't be played here")
    expect(player()).toHaveTextContent("H.265 (HEVC) video isn't supported")
    fireEvent.click(screen.getByRole("button", { name: "Open with default app" }))
    expect(bridge.api.shell.open).toHaveBeenCalledWith(5)
    expect(within(player()).getByRole("button", { name: "Play" })).toBeDisabled()
  })

  it("audio that plays without a picture is reported as unsupported video", async () => {
    await setup()
    await select(4)
    await waitFor(() => expect(player()).toHaveAttribute("data-state", "ready"))
    Object.defineProperty(videoEl(), "videoWidth", { value: 0 })
    fireEvent.loadedMetadata(videoEl())
    expect(player()).toHaveAttribute("data-problem", "unsupported")
    expect(pause).toHaveBeenCalled()
  })

  it("a damaged file and a moved file say so; Try again re-resolves", async () => {
    const bridge = await setup()
    bridge.api.media.open.mockResolvedValueOnce({
      ok: false,
      e: { code: "CORRUPT_MEDIA", message: "video cannot be read", retryable: false },
    } as never)
    await select(4)
    await waitFor(() => expect(player()).toHaveAttribute("data-problem", "damaged"))
    expect(player()).toHaveTextContent("This video is damaged")

    await select(5)
    await waitFor(() => expect(player()).toHaveAttribute("data-state", "ready"))
    Object.defineProperty(videoEl(), "error", { value: { code: 2 } })
    fireEvent.error(videoEl())
    expect(player()).toHaveAttribute("data-problem", "missing")
    const calls = bridge.api.media.open.mock.calls.length
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    await waitFor(() => expect(bridge.api.media.open.mock.calls.length).toBe(calls + 1))
    await waitFor(() => expect(player()).toHaveAttribute("data-state", "ready"))
    expect(bridge.api.preview.ensure).toHaveBeenLastCalledWith(
      expect.objectContaining({ lane: "pane", force: [6] }),
    )
  })
})

describe("video tiles", () => {
  it("show the poster with a play badge once ready, the video symbol before", async () => {
    const bridge = await setup()
    const tile = () => screen.getAllByTestId("tile").find((t) => t.dataset.index === "4")!
    await waitFor(() => expect(tile()).toHaveAttribute("data-kind", "video"))
    expect(within(tile()).queryByRole("img")).not.toBeInTheDocument()
    const profile = getThumbProfile()
    act(() =>
      bridge.push("preview.ready", {
        items: [{ id: 5, profile, url: fitUrl(5), width: 384, height: 216 }],
      }),
    )
    await waitFor(() => expect(within(tile()).getByTestId("video-badge")).toBeInTheDocument())
    expect(tile().querySelector("img")).toHaveAttribute("src", fitUrl(5))
  })
})
