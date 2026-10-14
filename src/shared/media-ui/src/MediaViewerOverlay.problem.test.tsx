import type { ContentItem } from "@panelyth/contracts"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

// The real player, with a video the backend can't play.
vi.mock("./viewerImages", () => ({
  requestFit: vi.fn(async () => undefined),
  requestMedia: vi.fn(async () => undefined),
  retry: vi.fn(),
  useViewerImage: () => ({
    fit: null,
    original: null,
    media: { status: "failed", code: "UNSUPPORTED_MEDIA" },
  }),
}))
vi.mock("./resume", () => ({
  readResume: vi.fn(async () => undefined),
  recordResume: vi.fn(),
  flushResume: vi.fn(async () => undefined),
  usablePoint: () => null,
}))

const { MediaViewerOverlay } = await import("./MediaViewerOverlay")

const video = { id: 1, kind: "video", name: "a.mkv" } as ContentItem

describe("MediaViewerOverlay over a video that can't be played", () => {
  beforeEach(() => {
    vi.spyOn(performance, "now").mockReturnValue(1000)
    // jsdom has no full screen; the overlay asks for it on open.
    HTMLElement.prototype.requestFullscreen = vi.fn(async () => undefined)
  })

  it("steps with the wheel and closes on a double-click, like a playable video", () => {
    const onStep = vi.fn()
    const onClose = vi.fn()
    render(
      <MediaViewerOverlay
        item={video}
        onClose={onClose}
        onStep={onStep}
        wheelMode="previousNext"
        closeOnDoubleClick
      />,
    )
    const problem = screen.getByTestId("video-problem")
    expect(screen.getByTestId("video-player")).toHaveAttribute("data-problem", "unsupported")
    fireEvent.wheel(problem, { deltaY: 100 })
    expect(onStep).toHaveBeenCalledWith(1)
    fireEvent.doubleClick(problem)
    expect(onClose).toHaveBeenCalledTimes(1)
    // A double-click on Open with default app is not a close.
    fireEvent.doubleClick(screen.getByRole("button", { name: "Open with default app" }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("the exit full screen button works", () => {
    const onClose = vi.fn()
    render(<MediaViewerOverlay item={video} onClose={onClose} />)
    const exit = screen.getByRole("button", { name: "Exit full screen" })
    expect(exit).toBeEnabled()
    fireEvent.click(exit)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
