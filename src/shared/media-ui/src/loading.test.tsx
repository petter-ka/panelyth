import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Stepping through pictures and videos: a loading chip while there is nothing
// to show yet, never a blank canvas.

const state: { fit: unknown; media: unknown } = { fit: null, media: null }
vi.mock("./viewerImages", () => ({
  requestFit: vi.fn(async () => undefined),
  requestMedia: vi.fn(async () => undefined),
  requestOriginal: vi.fn(async () => undefined),
  retry: vi.fn(),
  useViewerImage: () => ({ fit: state.fit, original: null, media: state.media }),
}))
vi.mock("./resume", () => ({
  readResume: vi.fn(async () => undefined),
  recordResume: vi.fn(),
  flushResume: vi.fn(async () => undefined),
  usablePoint: () => null,
}))

const { ImageViewer } = await import("./ImageViewer")
const { VideoPlayer } = await import("./VideoPlayer")

const thumb = { url: "thumb://1", width: 32, height: 24 }
const indicator = () => screen.queryByTestId("loading-indicator")

describe("ImageViewer while the picture loads", () => {
  beforeEach(() => {
    state.fit = null
    state.media = null
  })

  it("shows the loading chip in the middle when it has nothing to show", () => {
    render(<ImageViewer entryId={1} placeholder={null} />)
    expect(screen.getByTestId("image-viewer")).toHaveAttribute("data-layer", "none")
    expect(indicator()).toHaveTextContent("Loading…")
    expect(indicator()!.parentElement!.className).toMatch(/inset-0/)
    // At once: stepping quickly remounts the view, so a delayed chip would never show.
    expect(indicator()!.className).not.toMatch(/pending-fade/)
    expect(indicator()!.className).toMatch(/loading-now/)
  })

  it("keeps the thumbnail in view with a ring in the corner, and drops it when sharp", () => {
    const { rerender } = render(<ImageViewer entryId={1} placeholder={thumb as never} />)
    expect(screen.getByTestId("image-viewer")).toHaveAttribute("data-layer", "placeholder")
    expect(indicator()!.parentElement!.className).toMatch(/bottom-3/)
    expect(indicator()!.className).toMatch(/pending-fade/)
    state.fit = {
      status: "ready",
      decoded: true,
      thumb: { url: "fit://1", width: 1600, height: 1200 },
    }
    rerender(<ImageViewer entryId={1} placeholder={thumb as never} />)
    expect(screen.getByTestId("image-viewer")).toHaveAttribute("data-layer", "fit")
    expect(indicator()).toBeNull()
  })

  it("shows no chip over a picture that can't be displayed", () => {
    state.fit = { status: "failed", code: "DECODE_FAILED" }
    state.media = { status: "failed", code: "DECODE_FAILED" }
    render(<ImageViewer entryId={1} placeholder={null} />)
    expect(screen.getByText("This image can't be displayed")).toBeInTheDocument()
    expect(indicator()).toBeNull()
  })
})

describe("VideoPlayer while the video loads", () => {
  beforeEach(() => {
    state.fit = null
    state.media = null
  })

  it("shows the chip while the file is prepared, after Play until the first frame, and while stalled", () => {
    const { rerender } = render(
      <VideoPlayer entryId={2} name="a.mp4" placeholder={null} playToken={null} />,
    )
    expect(indicator()).toHaveTextContent("Loading…")

    state.media = {
      status: "ready",
      media: { url: "media://2", width: 1920, height: 1080, durationMs: 5000, videoCodec: "h264" },
    }
    rerender(<VideoPlayer entryId={2} name="a.mp4" placeholder={null} playToken={null} />)
    // Ready to play: the Play button, no chip.
    expect(indicator()).toBeNull()

    const video = screen.getByTestId("video-element")
    act(() => void fireEvent.play(video))
    expect(indicator()).not.toBeNull()
    act(() => void fireEvent.playing(video))
    expect(indicator()).toBeNull()
    act(() => void fireEvent.waiting(video))
    expect(indicator()).not.toBeNull()
    act(() => void fireEvent.canPlay(video))
    expect(indicator()).toBeNull()
  })
})
