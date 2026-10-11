import type { ContentItem } from "@panelyth/contracts"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./ImageViewer", () => ({ ImageViewer: () => <div data-testid="image" /> }))
vi.mock("./VideoPlayer", () => ({
  VideoPlayer: () => (
    <div data-testid="video">
      <input type="range" aria-label="Volume" />
    </div>
  ),
}))
vi.mock("./viewerImages", () => ({
  requestFit: vi.fn(async () => undefined),
  requestMedia: vi.fn(async () => undefined),
}))

const { MediaViewerOverlay } = await import("./MediaViewerOverlay")

const video = { id: 1, kind: "video", name: "a.mp4" } as ContentItem

describe("MediaViewerOverlay wheel over a video", () => {
  const onStep = vi.fn()
  beforeEach(() => {
    onStep.mockReset()
    vi.spyOn(performance, "now").mockReturnValue(1000)
  })

  it("steps with the wheel when the setting is previous / next", () => {
    render(
      <MediaViewerOverlay
        item={video}
        onClose={vi.fn()}
        onStep={onStep}
        wheelMode="previousNext"
      />,
    )
    fireEvent.wheel(screen.getByTestId("video"), { deltaY: 100 })
    expect(onStep).toHaveBeenCalledWith(1)
    vi.spyOn(performance, "now").mockReturnValue(2000)
    fireEvent.wheel(screen.getByTestId("video"), { deltaY: -100 })
    expect(onStep).toHaveBeenLastCalledWith(-1)
  })

  it("treats a burst as one step, and leaves Ctrl+wheel and sliders alone", () => {
    render(
      <MediaViewerOverlay
        item={video}
        onClose={vi.fn()}
        onStep={onStep}
        wheelMode="previousNext"
      />,
    )
    const target = screen.getByTestId("video")
    fireEvent.wheel(target, { deltaY: 100 })
    fireEvent.wheel(target, { deltaY: 100 })
    expect(onStep).toHaveBeenCalledTimes(1)
    vi.spyOn(performance, "now").mockReturnValue(5000)
    fireEvent.wheel(target, { deltaY: 100, ctrlKey: true })
    fireEvent.wheel(screen.getByLabelText("Volume"), { deltaY: 100 })
    expect(onStep).toHaveBeenCalledTimes(1)
  })

  it("does nothing when the wheel is set to zoom", () => {
    render(<MediaViewerOverlay item={video} onClose={vi.fn()} onStep={onStep} wheelMode="zoom" />)
    fireEvent.wheel(screen.getByTestId("video"), { deltaY: 100 })
    expect(onStep).not.toHaveBeenCalled()
  })
})
