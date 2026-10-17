import type { ContentItem } from "@panelyth/contracts"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

// What the overlay hands its picture and its player on a double-click.
vi.mock("./ImageViewer", () => ({
  ImageViewer: (props: { onDoubleClick?: () => void }) => (
    <div
      data-testid="image"
      data-dbl={props.onDoubleClick !== undefined}
      onDoubleClick={props.onDoubleClick}
    />
  ),
}))
vi.mock("./VideoPlayer", () => ({
  VideoPlayer: (props: { onDoubleClick?: () => void }) => (
    <div
      data-testid="video"
      data-dbl={props.onDoubleClick !== undefined}
      onDoubleClick={props.onDoubleClick}
    />
  ),
}))
vi.mock("./viewerImages", () => ({
  requestFit: vi.fn(async () => undefined),
  requestMedia: vi.fn(async () => undefined),
}))

const { MediaViewerOverlay } = await import("./MediaViewerOverlay")

const image = { id: 1, kind: "image", name: "a.jpg" } as ContentItem

describe("MediaViewerOverlay file keys", () => {
  it("hands copy, cut, paste, trash and delete to the app", () => {
    const onCommand = vi.fn()
    render(<MediaViewerOverlay item={image} onClose={vi.fn()} onCommand={onCommand} />)
    const surface = screen.getByTestId("media-viewer")
    fireEvent.keyDown(surface, { key: "c", ctrlKey: true })
    fireEvent.keyDown(surface, { key: "x", ctrlKey: true })
    fireEvent.keyDown(surface, { key: "v", metaKey: true })
    fireEvent.keyDown(surface, { key: "Delete" })
    fireEvent.keyDown(surface, { key: "Delete", shiftKey: true })
    expect(onCommand.mock.calls.map((c) => c[0])).toEqual([
      "copy",
      "cut",
      "paste",
      "trash",
      "delete",
    ])
  })

  it("keeps zoom and stepping keys, and does nothing without a handler", () => {
    const onStep = vi.fn()
    render(<MediaViewerOverlay item={image} onClose={vi.fn()} onStep={onStep} />)
    const surface = screen.getByTestId("media-viewer")
    fireEvent.keyDown(surface, { key: "Delete" })
    fireEvent.keyDown(surface, { key: "ArrowRight" })
    expect(onStep).toHaveBeenCalledWith(1)
  })
})
