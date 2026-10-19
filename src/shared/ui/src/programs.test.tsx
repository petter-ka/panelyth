import type { ExternalProgram, ProgramEdit } from "@panelyth/contracts"
import { PanelythError, startProgramsSync, usePrograms } from "@panelyth/renderer-core"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProgramsSettings, programRefusal, TooltipProvider } from "./index"

const gimp: ExternalProgram = { id: "gimp", name: "GIMP", path: "/usr/bin/gimp", target: "files" }
const code: ExternalProgram = { id: "code", name: "Code", path: "/usr/bin/code", target: "both" }

function setup(programs: ExternalProgram[] = [gimp, code]) {
  let listener: ((key: string, value: unknown) => void) | null = null
  let stored = programs
  const update = vi.fn(async (edits: ProgramEdit[]) => {
    stored = edits.map((e) => ({ ...stored.find((p) => p.id === e.id)!, ...e }))
    return { programs: stored }
  })
  const add = vi.fn(async () => {
    stored = [
      ...stored,
      { id: "new", name: "darktable", path: "/usr/bin/darktable", target: "both" },
    ]
    return { programs: stored, added: "new" }
  })
  const stop = startProgramsSync({
    loadSettings: async () => ({ "shared.programs": { v: 1, programs } }),
    onSettingChanged: (l) => {
      listener = l
      return () => (listener = null)
    },
    add,
    update,
  })
  return { add, update, stop, emit: (key: string, value: unknown) => listener?.(key, value) }
}

const renderTab = (app: "viewer" | "commander" = "commander") =>
  render(
    <TooltipProvider>
      <ProgramsSettings app={app} />
    </TooltipProvider>,
  )

describe("Settings → Open with (ADR-0044)", () => {
  let stop: (() => void) | null = null
  beforeEach(() => usePrograms.setState({ programs: [] }))
  afterEach(() => stop?.())

  it("lists the stored programs with their paths and follows changes from the other app", async () => {
    const s = setup()
    stop = s.stop
    renderTab()
    const rows = await screen.findAllByTestId("program-row")
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByRole("textbox", { name: "Program name" })).toHaveValue("GIMP")
    expect(within(rows[0]!).getByText("/usr/bin/gimp")).toBeInTheDocument()
    expect(within(rows[0]!).getByRole("combobox")).toHaveValue("files")

    act(() => s.emit("shared.programs", { v: 1, programs: [code] }))
    expect(screen.getAllByTestId("program-row")).toHaveLength(1)
    // Malformed values are left out.
    act(() => s.emit("shared.programs", { v: 1, programs: [{ id: "x", name: "sh", path: "sh" }] }))
    expect(screen.getByText("No programs yet.")).toBeInTheDocument()
  })

  it("adds through main's dialog and changes names, targets, the order and removals", async () => {
    const s = setup()
    stop = s.stop
    renderTab()
    await screen.findAllByTestId("program-row")

    fireEvent.click(screen.getByTestId("add-program"))
    await waitFor(() => expect(screen.getAllByTestId("program-row")).toHaveLength(3))
    expect(s.add).toHaveBeenCalledTimes(1)

    const name = screen.getAllByRole("textbox", { name: "Program name" })[0]!
    fireEvent.change(name, { target: { value: "  GIMP 3 " } })
    fireEvent.keyDown(name, { key: "Enter" })
    await waitFor(() =>
      expect(s.update).toHaveBeenLastCalledWith([
        { id: "gimp", name: "GIMP 3", target: "files" },
        { id: "code", name: "Code", target: "both" },
        { id: "new", name: "darktable", target: "both" },
      ]),
    )

    fireEvent.change(screen.getByRole("combobox", { name: "Show for Code" }), {
      target: { value: "folders" },
    })
    await waitFor(() =>
      expect(s.update.mock.lastCall?.[0][1]).toEqual({
        id: "code",
        name: "Code",
        target: "folders",
      }),
    )

    fireEvent.click(screen.getAllByRole("button", { name: "Move down" })[0]!)
    await waitFor(() =>
      expect(s.update.mock.lastCall?.[0].map((p: ProgramEdit) => p.id)).toEqual([
        "code",
        "gimp",
        "new",
      ]),
    )
    fireEvent.click(screen.getByRole("button", { name: "Remove darktable" }))
    await waitFor(() => expect(screen.getAllByTestId("program-row")).toHaveLength(2))
    expect(s.update.mock.lastCall?.[0].map((p: ProgramEdit) => p.id)).toEqual(["code", "gimp"])
  })

  it("keeps a name when the field is emptied", async () => {
    const s = setup([gimp])
    stop = s.stop
    renderTab()
    const name = await screen.findByRole("textbox", { name: "Program name" })
    fireEvent.change(name, { target: { value: "  " } })
    fireEvent.blur(name)
    expect(name).toHaveValue("GIMP")
    expect(s.update).not.toHaveBeenCalled()
  })

  it("saves a name as it is typed, and at once on Esc or when Settings closes", async () => {
    const s = setup([gimp])
    stop = s.stop
    const view = renderTab()
    const name = await screen.findByRole("textbox", { name: "Program name" })
    // A pause in typing saves it, with no Enter and no blur.
    fireEvent.change(name, { target: { value: "TOTALCMD" } })
    fireEvent.change(name, { target: { value: "totalCommander" } })
    await waitFor(() =>
      expect(s.update).toHaveBeenCalledWith([
        { id: "gimp", name: "totalCommander", target: "files" },
      ]),
    )
    expect(s.update).toHaveBeenCalledTimes(1)
    expect(name).toHaveValue("totalCommander")
    // Esc closes Settings: what was typed is saved first.
    fireEvent.change(name, { target: { value: "Total Commander" } })
    fireEvent.keyDown(name, { key: "Escape" })
    expect(s.update).toHaveBeenLastCalledWith([
      { id: "gimp", name: "Total Commander", target: "files" },
    ])
    // The window closes before the field is left: the page goes away.
    fireEvent.change(name, { target: { value: "TC" } })
    act(() => window.dispatchEvent(new Event("pagehide")))
    expect(s.update).toHaveBeenLastCalledWith([{ id: "gimp", name: "TC", target: "files" }])
    fireEvent.change(name, { target: { value: "TC 11" } })
    view.unmount()
    expect(s.update).toHaveBeenLastCalledWith([{ id: "gimp", name: "TC 11", target: "files" }])
  })

  it("says why main refused, and shows the list as it was", async () => {
    const s = setup([gimp])
    stop = s.stop
    s.add.mockRejectedValueOnce(
      new PanelythError("PERMISSION_DENIED", "choose a program (.exe)", false, {
        reason: "program",
      }),
    )
    s.update.mockRejectedValueOnce(new Error("disk full"))
    renderTab()
    await screen.findByTestId("program-row")
    fireEvent.click(screen.getByTestId("add-program"))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This file can't be started as a program.",
    )
    fireEvent.click(screen.getByRole("button", { name: "Remove GIMP" }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("disk full"))
    expect(screen.getAllByTestId("program-row")).toHaveLength(1)
  })

  it("explains the viewer's limits", async () => {
    stop = setup([]).stop
    renderTab("viewer")
    expect(await screen.findByText(/a folder, a picture or a video/)).toBeInTheDocument()
  })
})

describe("programRefusal", () => {
  const refusal = (reason: string) => new PanelythError("PERMISSION_DENIED", "x", false, { reason })

  it("names the program and what to do", () => {
    expect(programRefusal(refusal("missing"), "GIMP")).toBe(
      "GIMP was not found. Add it again in Settings → Open with.",
    )
    expect(programRefusal(refusal("kind"), "GIMP")).toBe("GIMP doesn't open this kind of item.")
    expect(programRefusal(refusal("full"))).toBe("You can add up to 20 programs.")
    expect(programRefusal(new PanelythError("NOT_FOUND", "gone"))).toBe(
      "This program is no longer in Settings.",
    )
    expect(programRefusal(new Error("spawn EACCES"), "GIMP")).toBe("spawn EACCES")
  })
})
