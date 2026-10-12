import type { ContentItem } from "@panelyth/contracts"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const step = vi.fn()
const reveal = vi.fn(async () => undefined)
const settings: Record<string, unknown> = {}
vi.mock("../bridge", () => ({
  bridge: {
    mediaWindowStep: (d: number) => step(d),
    mediaWindowReveal: () => reveal(),
    libraryNow: async () => ({ settings }),
  },
}))
// The overlay itself is tested in media-ui; here only what the window gives it.
vi.mock("@panelyth/media-ui", () => ({
  MediaViewerOverlay: (props: {
    item: ContentItem
    onStep: (d: -1 | 1) => void
    wheelMode: string
    closeOnDoubleClick?: boolean
    onEdit?: () => void
    onShowInApp?: () => void
  }) => (
    <div
      role="dialog"
      aria-label={props.item.name}
      data-wheel={props.wheelMode}
      data-close={props.closeOnDoubleClick === true}
      data-edit={props.onEdit !== undefined}
    >
      <button onClick={() => props.onStep(1)}>next</button>
      {props.onShowInApp && <button onClick={props.onShowInApp}>show in app</button>}
    </div>
  ),
}))

const { MediaWindowApp, standsAlone } = await import("./MediaWindowApp")

const item = (id: number, name: string) => ({ id, kind: "image", name }) as ContentItem

describe("MediaWindowApp", () => {
  beforeEach(() => {
    step.mockReset()
    reveal.mockClear()
    window.location.hash = ""
  })

  it("opened for a file from the OS, it takes the picture into the viewer instead of closing", async () => {
    expect(standsAlone("#entry=3&theme=dark")).toBe(false)
    expect(standsAlone("#alone=1&lang=de")).toBe(true)
    window.location.hash = "#alone=1"
    step.mockResolvedValueOnce(item(1, "a.jpg"))
    render(<MediaWindowApp />)
    const dialog = await screen.findByRole("dialog", { name: "a.jpg" })
    // No app window behind it: a double-click does not close, and Edit has no editor to go to.
    expect(dialog).toHaveAttribute("data-close", "false")
    expect(dialog).toHaveAttribute("data-edit", "false")
    fireEvent.click(screen.getByText("show in app"))
    expect(reveal).toHaveBeenCalledTimes(1)
  })

  it("opened from an app, it offers no way into the app (it is in front of it)", async () => {
    step.mockResolvedValueOnce(item(1, "a.jpg"))
    render(<MediaWindowApp />)
    const dialog = await screen.findByRole("dialog", { name: "a.jpg" })
    expect(dialog).toHaveAttribute("data-edit", "true")
    expect(screen.queryByText("show in app")).toBeNull()
  })

  it("shows the first item the opener gives and steps through the opener", async () => {
    step.mockResolvedValueOnce(item(1, "a.jpg")).mockResolvedValueOnce(item(2, "b.mp4"))
    render(<MediaWindowApp />)
    expect(await screen.findByRole("dialog", { name: "a.jpg" })).toBeInTheDocument()
    expect(step).toHaveBeenNthCalledWith(1, 0)
    fireEvent.click(screen.getByText("next"))
    expect(await screen.findByRole("dialog", { name: "b.mp4" })).toBeInTheDocument()
    expect(step).toHaveBeenNthCalledWith(2, 1)
  })

  it("closes on double-click and follows the viewer's mouse wheel setting", async () => {
    settings["viewer"] = { wheelMode: "previousNext" }
    step.mockResolvedValueOnce(item(1, "a.jpg"))
    render(<MediaWindowApp />)
    const dialog = await screen.findByRole("dialog", { name: "a.jpg" })
    expect(dialog).toHaveAttribute("data-close", "true")
    await waitFor(() => expect(dialog).toHaveAttribute("data-wheel", "previousNext"))
    delete settings["viewer"]
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
