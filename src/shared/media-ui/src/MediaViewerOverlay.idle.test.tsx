import type { ContentItem } from "@panelyth/contracts"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The real player on a playable video.
vi.mock("./viewerImages", () => ({
  requestFit: vi.fn(async () => undefined),
  requestMedia: vi.fn(async () => undefined),
  retry: vi.fn(),
  useViewerImage: () => ({
    fit: null,
    original: null,
    media: {
      status: "ready",
      media: {
        url: "panelyth-media://m/1",
        kind: "video",
        mime: "video/mp4",
        width: 1920,
        height: 1080,
        durationMs: 60_000,
        videoCodec: "h264",
        audioCodec: "aac",
      },
    },
  }),
}))
vi.mock("./resume", () => ({
  readResume: vi.fn(async () => undefined),
  recordResume: vi.fn(),
  flushResume: vi.fn(async () => undefined),
  usablePoint: () => null,
}))

const { MediaViewerOverlay } = await import("./MediaViewerOverlay")
const { CONTROLS_IDLE_MS } = await import("./useIdle")
const { useVideoPrefs } = await import("./video")

const video = { id: 1, kind: "video", name: "a.mp4" } as ContentItem
const player = () => screen.getByTestId("video-player")
const header = () => screen.getByRole("dialog").querySelector("header")!

describe("full-screen video: the controls hide while the mouse rests", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    HTMLElement.prototype.requestFullscreen = vi.fn(async () => undefined)
    // jsdom plays nothing: play and pause only announce themselves.
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      this.dispatchEvent(new Event("play"))
      return Promise.resolve()
    })
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      this.dispatchEvent(new Event("pause"))
    })
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("hides the header, the controls and the cursor after 3 s; a move brings them back", async () => {
    render(<MediaViewerOverlay item={video} onClose={vi.fn()} />)
    await act(async () => undefined) // the token plays the video
    expect(player()).toHaveAttribute("data-state", "playing")
    expect(player()).toHaveAttribute("data-controls", "shown")

    act(() => vi.advanceTimersByTime(CONTROLS_IDLE_MS - 100))
    expect(player()).toHaveAttribute("data-controls", "shown")
    act(() => vi.advanceTimersByTime(200))
    expect(player()).toHaveAttribute("data-controls", "hidden")
    expect(player()).toHaveClass("cursor-none")
    expect(header()).toHaveAttribute("data-hidden", "true")
    expect(screen.getByRole("toolbar", { name: "Playback controls" })).toHaveClass("opacity-0")

    act(() => void fireEvent.pointerMove(window))
    expect(player()).toHaveAttribute("data-controls", "shown")
    expect(header()).not.toHaveAttribute("data-hidden")
  })

  it("never hides when Settings → Video player keeps the controls", async () => {
    useVideoPrefs.setState({ autoHide: false })
    try {
      render(<MediaViewerOverlay item={video} onClose={vi.fn()} />)
      await act(async () => undefined)
      expect(player()).toHaveAttribute("data-state", "playing")
      act(() => vi.advanceTimersByTime(CONTROLS_IDLE_MS * 3))
      expect(player()).toHaveAttribute("data-controls", "shown")
      expect(header()).not.toHaveAttribute("data-hidden")
    } finally {
      useVideoPrefs.setState({ autoHide: true })
    }
  })

  it("stays while the pointer is on the controls, and hides while paused too", async () => {
    render(<MediaViewerOverlay item={video} onClose={vi.fn()} />)
    await act(async () => undefined)
    const controls = screen.getByRole("toolbar", { name: "Playback controls" })
    fireEvent.pointerEnter(controls)
    act(() => vi.advanceTimersByTime(CONTROLS_IDLE_MS * 2))
    expect(player()).toHaveAttribute("data-controls", "shown")
    fireEvent.pointerLeave(controls)

    // jsdom reports every video as paused, so the pause is announced directly.
    act(() => void fireEvent.pause(screen.getByTestId("video-element")))
    expect(player()).toHaveAttribute("data-state", "paused")
    // A paused frame is looked at too (owner request): the bars still go after 3 s.
    act(() => void fireEvent.pointerMove(window))
    expect(player()).toHaveAttribute("data-controls", "shown")
    act(() => vi.advanceTimersByTime(CONTROLS_IDLE_MS + 100))
    expect(player()).toHaveAttribute("data-controls", "hidden")
    expect(header()).toHaveAttribute("data-hidden", "true")
    act(() => void fireEvent.pointerMove(window))
    expect(player()).toHaveAttribute("data-controls", "shown")
  })
})
