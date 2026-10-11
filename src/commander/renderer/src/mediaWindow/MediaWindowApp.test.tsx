import type { ContentItem } from "@panelyth/contracts"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const step = vi.fn()
vi.mock("../bridge", () => ({ bridge: { mediaWindowStep: (d: number) => step(d) } }))
// The overlay itself is tested in media-ui; here only what the window gives it.
vi.mock("@panelyth/media-ui", () => ({
  MediaViewerOverlay: (props: { item: ContentItem; onStep: (d: -1 | 1) => void }) => (
    <div role="dialog" aria-label={props.item.name}>
      <button onClick={() => props.onStep(1)}>next</button>
    </div>
  ),
}))

const { MediaWindowApp } = await import("./MediaWindowApp")

const item = (id: number, name: string) => ({ id, kind: "image", name }) as ContentItem

describe("MediaWindowApp", () => {
  beforeEach(() => step.mockReset())

  it("shows the first item the opener gives and steps through the opener", async () => {
    step.mockResolvedValueOnce(item(1, "a.jpg")).mockResolvedValueOnce(item(2, "b.mp4"))
    render(<MediaWindowApp />)
    expect(await screen.findByRole("dialog", { name: "a.jpg" })).toBeInTheDocument()
    expect(step).toHaveBeenNthCalledWith(1, 0)
    fireEvent.click(screen.getByText("next"))
    expect(await screen.findByRole("dialog", { name: "b.mp4" })).toBeInTheDocument()
    expect(step).toHaveBeenNthCalledWith(2, 1)
  })

  it("keeps the current item at the end of the list", async () => {
    step.mockResolvedValueOnce(item(1, "a.jpg")).mockResolvedValueOnce(null)
    render(<MediaWindowApp />)
    await screen.findByRole("dialog", { name: "a.jpg" })
    fireEvent.click(screen.getByText("next"))
    await waitFor(() => expect(step).toHaveBeenCalledTimes(2))
    expect(screen.getByRole("dialog", { name: "a.jpg" })).toBeInTheDocument()
  })

  it("says so when the opener can't be reached", async () => {
    step.mockResolvedValueOnce(null)
    render(<MediaWindowApp />)
    expect(await screen.findByRole("alert")).toBeInTheDocument()
  })
})
