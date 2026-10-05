import type { JobSnapshot } from "@fastview/contracts"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useGlobalShortcuts } from "../../app/shortcuts"
import { ContentPane } from "../../components/ContentPane"
import { JobDialogs } from "../../components/jobs/JobDialogs"
import { Notice } from "../../components/Notice"
import { installFakeBridge, makeItems } from "../../test/fakeBridge"
import { mockViewport } from "../../test/viewport"
import { openFolder, resetFolderStore, startFolderMonitoring } from "../folder/folderStore"
import { startSidecarMonitoring, useSidecarStore } from "../system/sidecarStore"
import { selectAll } from "../tiles/selectionStore"
import { resetJobsStore, startJobMonitoring } from "./jobsStore"
import { applyPattern, parsePattern } from "./pattern"

let stop: (() => void)[] = []

function Harness() {
  useGlobalShortcuts()
  return (
    <>
      <ContentPane />
      <JobDialogs />
      <Notice />
    </>
  )
}

async function setup(items = makeItems(6, 1)) {
  const bridge = installFakeBridge()
  bridge.backend.items = items
  stop = [startSidecarMonitoring(), startFolderMonitoring(), startJobMonitoring()]
  render(<Harness />)
  await act(() => openFolder("/photos/Trip"))
  await screen.findByText("IMG_2.jpg")
  return bridge
}

const tile = (name: string) => screen.getByRole("gridcell", { name })

function snap(p: Partial<JobSnapshot>): JobSnapshot {
  return {
    jobId: 1,
    kind: "copy",
    state: "running",
    total: 10,
    done: 0,
    failed: 0,
    skipped: 0,
    bytesTotal: 0,
    bytesDone: 0,
    current: "",
    destination: "Trip",
    error: "",
    startedMs: 1,
    finishedMs: 0,
    ...p,
  }
}

beforeEach(() => {
  mockViewport(1000, 800)
  resetFolderStore()
  resetJobsStore()
  useSidecarStore.setState({ status: null, info: null, pingMs: null, error: null })
})
afterEach(() => {
  stop.forEach((f) => f())
  vi.restoreAllMocks()
})

describe("rename pattern preview", () => {
  // Same cases as TestPattern in shared/sidecar/internal/jobs.
  it.each([
    ["Holiday {n:000}", "IMG_1.JPG", false, 7, "Holiday 007.JPG"],
    ["{name}-{n}", "a.b.png", false, 12, "a.b-12.png"],
    ["{n:00} {name}", "Album", true, 3, "03 Album"],
    ["x{n:0}", "a.jpg", false, 1234, "x1234.jpg"],
  ])("%s on %s", (pattern, name, isDir, n, want) => {
    const parts = parsePattern(pattern)
    expect(parts).not.toBeNull()
    expect(applyPattern(parts!, name, isDir, n)).toBe(want)
  })

  it.each(["", "plain", "{ext}", "{n", "{n:0a}", "{n:}"])("rejects %j", (bad) => {
    expect(parsePattern(bad)).toBeNull()
  })
})

describe("clipboard and delete", () => {
  it("copies and pastes with descriptors, never id lists", async () => {
    const bridge = await setup()
    await userEvent.click(tile("IMG_2.jpg"))
    await userEvent.keyboard("{Control>}c{/Control}")
    await waitFor(() => expect(bridge.api.clip.set).toHaveBeenCalledTimes(1))
    const [sel, mode] = bridge.api.clip.set.mock.calls[0]!
    expect(mode).toBe("copy")
    expect(sel).toEqual({ queryId: 1, version: 1, ranges: [[2, 3]], include: [], exclude: [] })

    await userEvent.keyboard("{Control>}v{/Control}")
    await waitFor(() =>
      expect(bridge.api.clip.paste).toHaveBeenCalledWith("/photos/Trip", "keepBoth"),
    )
    const panel = await screen.findByTestId("jobs-panel")
    expect(within(panel).getByText("Copying 1 item to Trip")).toBeInTheDocument()
  })

  it("Ctrl+C on one picture also puts the picture on the OS clipboard", async () => {
    const bridge = await setup()
    await userEvent.click(tile("IMG_2.jpg"))
    await userEvent.keyboard("{Control>}c{/Control}")
    await waitFor(() => expect(bridge.api.clipboard.copyImage).toHaveBeenCalledWith(3))
    expect(bridge.api.clip.set).toHaveBeenCalledTimes(1) // Ctrl+V in FastView still works
    expect(await screen.findByTestId("notice")).toHaveTextContent("Picture copied to the clipboard")

    bridge.api.clipboard.copyImage.mockResolvedValueOnce({
      ok: false,
      e: { code: "CORRUPT_MEDIA", message: "image cannot be read" },
    } as never)
    await userEvent.keyboard("{Control>}c{/Control}")
    await waitFor(() =>
      expect(screen.getByTestId("notice")).toHaveTextContent(
        "Couldn't copy the picture: image cannot be read",
      ),
    )
    expect(screen.getByTestId("notice")).toHaveAttribute("data-tone", "error")
  })

  it("Ctrl+C on several items copies files only, and says so", async () => {
    const user = userEvent.setup()
    const bridge = await setup()
    await user.click(tile("IMG_2.jpg"))
    await user.keyboard("{Shift>}")
    await user.click(tile("IMG_4.jpg"))
    await user.keyboard("{/Shift}{Control>}c{/Control}")
    await waitFor(() => expect(bridge.api.clip.set).toHaveBeenCalledTimes(1))
    expect(bridge.api.clipboard.copyImage).not.toHaveBeenCalled()
    expect(await screen.findByTestId("notice")).toHaveTextContent("3 items copied.")
  })

  it("Delete moves to trash at once; Shift+Delete asks first", async () => {
    const bridge = await setup()
    act(() => selectAll(6))
    await userEvent.keyboard("{Delete}")
    await waitFor(() => expect(bridge.backend.jobs).toHaveLength(1))
    expect(bridge.backend.jobs[0]).toEqual({
      kind: "trash",
      source: { selection: { queryId: 1, version: 1, ranges: [[0, 6]], include: [], exclude: [] } },
    })

    await userEvent.keyboard("{Shift>}{Delete}{/Shift}")
    const dialog = await screen.findByRole("dialog", { name: "Delete permanently?" })
    expect(bridge.backend.jobs).toHaveLength(1) // nothing deleted before confirming
    await userEvent.click(within(dialog).getByTestId("confirm-delete"))
    await waitFor(() => expect(bridge.backend.jobs).toHaveLength(2))
    expect(bridge.backend.jobs[1]!.kind).toBe("delete")
  })

  it("ignores file shortcuts while typing", async () => {
    const bridge = await setup()
    await userEvent.click(tile("IMG_2.jpg"))
    await userEvent.click(screen.getByRole("searchbox"))
    await userEvent.keyboard("{Delete}{Control>}c{/Control}")
    expect(bridge.api.jobs.start).not.toHaveBeenCalled()
    expect(bridge.api.clip.set).not.toHaveBeenCalled()
  })
})

describe("progress panel", () => {
  it("follows job.progress, cancels and shows failed items", async () => {
    const bridge = await setup()
    bridge.push("job.progress", snap({ done: 3, current: "IMG_3.jpg" }))
    const row = await screen.findByTestId("job")
    expect(row).toHaveTextContent("Copying 10 items to Trip")
    expect(row).toHaveTextContent("3 of 10")
    await userEvent.click(within(row).getByRole("button", { name: "Cancel" }))
    expect(bridge.api.jobs.cancel).toHaveBeenCalledWith(1)

    // A late running snapshot must not undo the final state.
    act(() => {
      bridge.push("job.progress", snap({ state: "completed", done: 9, failed: 1, finishedMs: 2 }))
      bridge.push("job.progress", snap({ done: 5 }))
    })
    expect(screen.getByTestId("job")).toHaveAttribute("data-state", "completed")
    await userEvent.click(screen.getByRole("button", { name: "Details" }))
    const errors = await screen.findByTestId("job-errors")
    expect(errors).toHaveTextContent("IMG_1.jpg")
    expect(errors).toHaveTextContent("The item is open.")
  })

  it("can be dismissed once finished", async () => {
    const bridge = await setup()
    bridge.push("job.progress", snap({ state: "completed", done: 10, finishedMs: 2 }))
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }))
    expect(screen.queryByTestId("jobs-panel")).not.toBeInTheDocument()
  })
})

describe("rename", () => {
  it("F2 on one item renames it and shows Go's validation error", async () => {
    const bridge = await setup()
    await userEvent.click(tile("IMG_2.jpg"))
    await userEvent.keyboard("{F2}")
    const input = await screen.findByTestId("rename-input")
    expect(input).toHaveValue("IMG_2.jpg")
    await userEvent.clear(input)
    await userEvent.type(input, "a/b.jpg{Enter}")
    expect(await screen.findByRole("alert")).toHaveTextContent("can't contain")
    await userEvent.clear(input)
    await userEvent.type(input, "Beach.jpg{Enter}")
    await waitFor(() => expect(bridge.api.entry.rename).toHaveBeenLastCalledWith(3, "Beach.jpg"))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })

  it("F2 on several items previews the pattern and starts one job", async () => {
    const bridge = await setup()
    await userEvent.click(tile("IMG_2.jpg"))
    fireEvent.mouseDown(tile("IMG_4.jpg"), { shiftKey: true })
    await userEvent.keyboard("{F2}")
    const preview = await screen.findByTestId("rename-preview")
    expect(preview).toHaveTextContent("IMG_2 001.jpg")
    expect(preview).toHaveTextContent("IMG_4 003.jpg")
    const pattern = screen.getByTestId("pattern-input")
    await userEvent.clear(pattern)
    await userEvent.type(pattern, "plain")
    expect(screen.getByRole("button", { name: "Rename 3" })).toBeDisabled()
    await userEvent.clear(pattern)
    // userEvent treats { as a key descriptor; {{ types a literal brace.
    await userEvent.type(pattern, "Trip {{n}")
    await userEvent.click(screen.getByRole("button", { name: "Rename 3" }))
    await waitFor(() => expect(bridge.backend.jobs).toHaveLength(1))
    expect(bridge.backend.jobs[0]).toMatchObject({ kind: "rename", pattern: "Trip {n}", start: 1 })
  })
})

describe("user metadata", () => {
  it("shows favorite and rating badges on tiles", async () => {
    const items = makeItems(4)
    items[1] = { ...items[1]!, favorite: true, rating: 4 }
    await setup(items)
    const badges = screen.getAllByTestId("user-badge")
    expect(badges).toHaveLength(1)
    expect(badges[0]).toHaveAccessibleName("Favorite, 4 stars")
  })

  it("filters by favorites with a new session", async () => {
    const bridge = await setup()
    await userEvent.click(screen.getByRole("button", { name: "Favorites" }))
    await waitFor(() =>
      expect(bridge.api.query.open).toHaveBeenLastCalledWith(
        expect.objectContaining({ favorite: true, minRating: 0, tags: [] }),
      ),
    )
  })

  it("the batch bar acts on two or more selected items", async () => {
    const bridge = await setup()
    await userEvent.click(tile("IMG_2.jpg"))
    expect(screen.queryByTestId("batch-bar")).not.toBeInTheDocument()
    fireEvent.mouseDown(tile("IMG_3.jpg"), { ctrlKey: true })
    const bar = await screen.findByTestId("batch-bar")
    expect(bar).toHaveTextContent("2 selected")
    fireEvent.click(within(bar).getByRole("button", { name: "Favorite" }))
    await waitFor(() => expect(bridge.backend.jobs).toHaveLength(1))
    expect(bridge.backend.jobs[0]).toMatchObject({
      kind: "favorite",
      favorite: true,
      source: { selection: { ranges: [[2, 3]], include: [4] } },
    })
  })
})
