import type { ContentItem } from "@panelyth/contracts"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./ImageViewer", () => ({ ImageViewer: () => <div data-testid="image" /> }))
vi.mock("./viewerImages", () => ({
  requestFit: vi.fn(async () => undefined),
  requestMedia: vi.fn(async () => undefined),
}))

const { MediaViewerOverlay } = await import("./MediaViewerOverlay")
const { CONTROLS_IDLE_MS } = await import("./useIdle")
const { useVideoPrefs } = await import("./video")

const image = { id: 1, kind: "image", name: "a.jpg" } as ContentItem
const header = () => screen.getByRole("dialog").querySelector("header")!

describe("full-screen picture: the header hides while the mouse rests", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useVideoPrefs.setState({ autoHideImage: true })
  })
  afterEach(() => {
    vi.useRealTimers()
    useVideoPrefs.setState({ autoHideImage: true })
  })

  it("hides the header and the cursor after 3 s; a move or the wheel brings them back", () => {
    render(<MediaViewerOverlay item={image} onClose={vi.fn()} />)
    act(() => vi.advanceTimersByTime(CONTROLS_IDLE_MS - 100))
    expect(header()).not.toHaveAttribute("data-hidden")
    act(() => vi.advanceTimersByTime(200))
    expect(header()).toHaveAttribute("data-hidden", "true")
    expect(header()).toHaveClass("opacity-0")
    expect(screen.getByRole("dialog")).toHaveClass("cursor-none")

    act(() => void fireEvent.pointerMove(window))
    expect(header()).not.toHaveAttribute("data-hidden")
    act(() => vi.advanceTimersByTime(CONTROLS_IDLE_MS))
    expect(header()).toHaveAttribute("data-hidden", "true")
    // Zooming with the wheel is activity too.
    act(() => void fireEvent.wheel(window))
    expect(header()).not.toHaveAttribute("data-hidden")
  })

  it("stays while the pointer is on the header, and when Settings keeps it", () => {
    const { unmount } = render(<MediaViewerOverlay item={image} onClose={vi.fn()} />)
    fireEvent.pointerEnter(header())
    act(() => vi.advanceTimersByTime(CONTROLS_IDLE_MS * 2))
    expect(header()).not.toHaveAttribute("data-hidden")
    unmount()

    useVideoPrefs.setState({ autoHideImage: false })
    render(<MediaViewerOverlay item={image} onClose={vi.fn()} />)
    act(() => vi.advanceTimersByTime(CONTROLS_IDLE_MS * 3))
    expect(header()).not.toHaveAttribute("data-hidden")
    expect(screen.getByRole("dialog")).not.toHaveClass("cursor-none")
  })
})
