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
const video = { id: 2, kind: "video", name: "b.mp4" } as ContentItem

describe("MediaViewerOverlay standing alone (a file opened from the OS)", () => {
  it("takes the picture into the app with a button or a double-click, and does not close", () => {
    const onShowInApp = vi.fn()
    const onClose = vi.fn()
    render(<MediaViewerOverlay item={image} onClose={onClose} onShowInApp={onShowInApp} />)
    fireEvent.click(screen.getByRole("button", { name: "Open in Panelyth" }))
    expect(onShowInApp).toHaveBeenCalledTimes(1)
    fireEvent.doubleClick(screen.getByTestId("image"))
    expect(onShowInApp).toHaveBeenCalledTimes(2)
    expect(onClose).not.toHaveBeenCalled()
  })

  it("does the same on a video", () => {
    const onShowInApp = vi.fn()
    render(<MediaViewerOverlay item={video} onClose={vi.fn()} onShowInApp={onShowInApp} />)
    fireEvent.doubleClick(screen.getByTestId("video"))
    expect(onShowInApp).toHaveBeenCalledTimes(1)
  })

  it("opened from an app, a double-click closes as before and there is no such button", () => {
    const onClose = vi.fn()
    const { unmount } = render(
      <MediaViewerOverlay item={image} onClose={onClose} closeOnDoubleClick />,
    )
    expect(screen.queryByRole("button", { name: "Open in Panelyth" })).toBeNull()
    fireEvent.doubleClick(screen.getByTestId("image"))
    expect(onClose).toHaveBeenCalledTimes(1)
    unmount()
    // Neither: a double-click belongs to the picture (zoom).
    render(<MediaViewerOverlay item={image} onClose={onClose} />)
    expect(screen.getByTestId("image")).toHaveAttribute("data-dbl", "false")
  })
})
