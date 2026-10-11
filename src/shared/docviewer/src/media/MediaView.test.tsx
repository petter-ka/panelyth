import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { MediaView } from "./MediaView"

const src = `panelyth-media://m/${"b".repeat(32)}`

describe("MediaView", () => {
  it("fills the window with the image, no header, and closes on double-click", () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined)
    render(<MediaView kind="image" name="a.jpg" src={src} />)
    const img = screen.getByRole("img", { name: "a.jpg" })
    expect(img).toHaveAttribute("src", src)
    expect(screen.queryByRole("banner")).toBeNull()
    fireEvent.doubleClick(img)
    expect(close).toHaveBeenCalled()
  })

  it("plays a video with its own controls", () => {
    const { container } = render(<MediaView kind="video" name="c.mp4" src={src} />)
    const video = container.querySelector("video")
    expect(video).toHaveAttribute("src", src)
    expect(video).toHaveAttribute("controls")
  })

  it("says so when the file can't be shown", () => {
    render(<MediaView kind="image" name="a.jpg" src={src} />)
    fireEvent.error(screen.getByRole("img", { name: "a.jpg" }))
    expect(screen.getByRole("alert")).toHaveTextContent("a.jpg")
  })
})
