import type { ContentItem } from "@panelyth/contracts"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const step = vi.fn()
const reveal = vi.fn(async () => undefined)
const command = vi.fn()
const settings: Record<string, unknown> = {}
vi.mock("../bridge", () => ({
  bridge: {
    mediaWindowStep: (d: number) => step(d),
    mediaWindowReveal: () => reveal(),
    mediaWindowCommand: (c: string) => command(c),
    libraryNow: async () => ({ settings }),
  },
}))
// The overlay itself is tested in media-ui; here only what the window gives it.
const prefs = { confirmDelete: true }
vi.mock("@panelyth/media-ui", () => ({
  useVideoPrefs: (pick: (s: typeof prefs) => unknown) => pick(prefs),
  MediaViewerOverlay: (props: {
    item: ContentItem
    onStep: (d: -1 | 1) => void
    onJump: (to: "first" | "last") => void
    wheelMode: string
    closeOnDoubleClick?: boolean
    onEdit?: () => void
    onShowInApp?: () => void
    onCommand?: (c: string) => void
  }) => (
    <div
      role="dialog"
      aria-label={props.item.name}
      data-wheel={props.wheelMode}
      data-close={props.closeOnDoubleClick === true}
      data-edit={props.onEdit !== undefined}
    >
      <button onClick={() => props.onStep(1)}>next</button>
      <button onClick={() => props.onJump("last")}>last</button>
      {props.onShowInApp && <button onClick={props.onShowInApp}>show in app</button>}
      {props.onCommand &&
        ["copy", "trash", "delete"].map((c) => (
          <button key={c} onClick={() => props.onCommand!(c)}>
            key {c}
          </button>
        ))}
    </div>
  ),
}))

const { MediaWindowApp, standsAlone } = await import("./MediaWindowApp")

const item = (id: number, name: string) => ({ id, kind: "image", name }) as ContentItem

describe("MediaWindowApp", () => {
  beforeEach(() => {
    step.mockReset()
    reveal.mockClear()
    command.mockReset()
    prefs.confirmDelete = true
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

  it("asks before the trash by default; Enter moves the file there", async () => {
    step.mockResolvedValueOnce(item(1, "a.jpg"))
    command.mockResolvedValueOnce({ item: item(2, "b.jpg"), done: true })
    render(<MediaWindowApp />)
    await screen.findByRole("dialog", { name: "a.jpg" })
    fireEvent.click(screen.getByText("key trash"))
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Move a.jpg to the trash?")
    expect(command).not.toHaveBeenCalled()
    const confirm = screen.getByRole("button", { name: "Move to trash" })
    expect(confirm).toHaveFocus()
    fireEvent.click(confirm)
    expect(await screen.findByRole("dialog", { name: "b.jpg" })).toBeInTheDocument()
    expect(command).toHaveBeenCalledWith("trash")
  })

  it("hands the file keys to the opener; after a delete it shows the file the opener names", async () => {
    // Settings → Appearance → Full screen: no question before the trash.
    prefs.confirmDelete = false
    step.mockResolvedValueOnce(item(1, "a.jpg"))
    command.mockResolvedValueOnce({ item: item(2, "b.jpg"), done: true })
    render(<MediaWindowApp />)
    await screen.findByRole("dialog", { name: "a.jpg" })
    fireEvent.click(screen.getByText("key trash"))
    expect(await screen.findByRole("dialog", { name: "b.jpg" })).toBeInTheDocument()
    expect(command).toHaveBeenCalledWith("trash")
    expect(screen.getByRole("status")).toHaveTextContent("Moved 1 item to the trash")
  })

  it("asks before deleting for good, and closes when nothing is left", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => undefined)
    step.mockResolvedValueOnce(item(1, "a.jpg"))
    command.mockResolvedValueOnce({ item: null, done: true })
    render(<MediaWindowApp />)
    await screen.findByRole("dialog", { name: "a.jpg" })
    fireEvent.click(screen.getByText("key delete"))
    const confirm = screen.getByRole("alertdialog")
    expect(confirm).toHaveTextContent("Delete a.jpg permanently?")
    // Esc keeps the file.
    fireEvent.keyDown(confirm, { key: "Escape" })
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(command).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText("key delete"))
    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }))
    await waitFor(() => expect(close).toHaveBeenCalled())
    expect(command).toHaveBeenCalledWith("delete")
    close.mockRestore()
  })

  it("says when the opener could not carry a key out, and keeps the file", async () => {
    step.mockResolvedValueOnce(item(1, "a.jpg"))
    command.mockResolvedValueOnce({ item: item(1, "a.jpg"), done: false })
    render(<MediaWindowApp />)
    await screen.findByRole("dialog", { name: "a.jpg" })
    fireEvent.click(screen.getByText("key copy"))
    expect(await screen.findByRole("status")).toHaveTextContent("The operation failed.")
    expect(screen.getByRole("dialog", { name: "a.jpg" })).toBeInTheDocument()
  })

  it("standing alone, it has no file keys (no app carries them out)", async () => {
    window.location.hash = "#alone=1"
    step.mockResolvedValueOnce(item(1, "a.jpg"))
    render(<MediaWindowApp />)
    await screen.findByRole("dialog", { name: "a.jpg" })
    expect(screen.queryByText("key trash")).toBeNull()
  })

  it("shows a loading chip until the first item comes (a drive spinning up)", async () => {
    let answer: (v: ContentItem) => void = () => undefined
    step.mockImplementation(() => new Promise<ContentItem>((resolve) => (answer = resolve)))
    render(<MediaWindowApp />)
    expect(screen.getByTestId("loading-indicator")).toBeTruthy()
    answer(item(1, "a.jpg"))
    await screen.findByRole("dialog", { name: "a.jpg" })
    expect(screen.queryByTestId("loading-indicator")).toBeNull()
  })

  it("asks the opener for the last item on End", async () => {
    step.mockImplementation(async (d: unknown) =>
      d === 0 ? item(1, "a.jpg") : d === "last" ? item(9, "z.jpg") : null,
    )
    render(<MediaWindowApp />)
    fireEvent.click(await screen.findByText("last"))
    await screen.findByRole("dialog", { name: "z.jpg" })
    expect(step).toHaveBeenLastCalledWith("last")
  })
})
