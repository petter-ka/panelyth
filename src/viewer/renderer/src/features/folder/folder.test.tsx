import type { IndexProgress } from "@panelyth/contracts"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ContentPane } from "../../components/ContentPane"
import { crumbsOf, installFakeBridge, makeItems } from "../../test/fakeBridge"
import { mockViewport } from "../../test/viewport"
import { startSidecarMonitoring, useSidecarStore } from "../system/sidecarStore"
import { openFolder, resetFolderStore, startFolderMonitoring, useFolderStore } from "./folderStore"

const progress = (p: Partial<IndexProgress> = {}): IndexProgress => ({
  scanId: 1,
  dirId: 1,
  recursive: false,
  state: "running",
  dirsListed: 0,
  dirsPending: 1,
  entries: 0,
  skipped: 0,
  errors: 0,
  elapsedMs: 10,
  ...p,
})

let stop: (() => void)[] = []

function setup() {
  const bridge = installFakeBridge()
  stop = [startSidecarMonitoring(), startFolderMonitoring()]
  render(<ContentPane />)
  return bridge
}

beforeEach(() => {
  mockViewport(1000, 800)
  resetFolderStore()
  useSidecarStore.setState({ status: null, info: null, pingMs: null, error: null })
})
afterEach(() => {
  stop.forEach((f) => f())
  vi.restoreAllMocks()
})

describe("opening a folder", () => {
  it("opens through the native dialog and shows the items as tiles", async () => {
    const bridge = setup()
    bridge.backend.items = makeItems(3, 1)
    await userEvent.click(
      await screen.findByRole("button", { name: "Open folder…", hidden: false }),
    )
    expect(await screen.findByText("IMG_1.jpg")).toBeInTheDocument()
    expect(screen.getByTestId("folder-name")).toHaveTextContent("Trip")
    expect(bridge.api.dir.open).toHaveBeenCalledWith({ path: "/photos/Trip", recursive: false })
    expect(bridge.api.query.open).toHaveBeenCalledWith({
      dirId: 1,
      recursive: false,
      sort: [{ field: "name", direction: "asc" }],
      kinds: [],
      search: "",
      exts: [],
      favorite: false,
      minRating: 0,
      tags: [],
    })
    const tiles = screen.getAllByTestId("tile")
    expect(tiles).toHaveLength(3)
    expect(tiles[0]).toHaveAttribute("data-kind", "dir")
    expect(screen.queryByRole("table")).not.toBeInTheDocument()
  })

  it("does nothing when the dialog is cancelled", async () => {
    const bridge = setup()
    bridge.api.dialog.openFolder.mockResolvedValueOnce({ ok: true, r: { path: null } })
    await userEvent.click(await screen.findByRole("button", { name: "Open folder…" }))
    expect(bridge.api.dir.open).not.toHaveBeenCalled()
    expect(screen.getByText("No folder open")).toBeInTheDocument()
  })

  it("never mounts more tiles than fit the view, whatever the folder size", async () => {
    const bridge = setup()
    bridge.backend.items = makeItems(100_000)
    await act(() => openFolder("/huge"))
    const mounted = screen.getAllByTestId("tile").length
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThanOrEqual(40)
    expect(bridge.api.query.page).toHaveBeenCalledWith({
      queryId: 1,
      offset: 0,
      limit: 256,
      thumbProfile: "grid-sm",
    })
  })

  it("shows a plain-language error when the folder cannot be opened", async () => {
    const bridge = setup()
    bridge.api.dir.open.mockResolvedValueOnce({
      ok: false,
      e: { code: "PERMISSION_DENIED", message: "denied", retryable: false },
    } as never)
    await act(() => openFolder("/root-only"))
    expect(screen.getByText("Couldn't open the folder")).toBeInTheDocument()
    expect(
      screen.getByText("Panelyth doesn't have permission to open this folder."),
    ).toBeInTheDocument()
  })
})

describe("live indexing", () => {
  it("reports progress, refetches on invalidation and ignores stale versions", async () => {
    const bridge = setup()
    await act(() => openFolder("/photos"))
    act(() => bridge.push("index.progress", progress({ entries: 0 })))
    expect(screen.getByTestId("folder-summary")).toHaveTextContent("Indexing… 0 items so far")

    bridge.backend.items = makeItems(250)
    bridge.backend.version = 2
    act(() => bridge.push("query.invalidated", { queryId: 1, version: 2, total: 250 }))
    await screen.findByText("IMG_0.jpg")
    expect(screen.getByTestId("folder-summary")).toHaveTextContent("250 items so far")
    const pagesBefore = bridge.api.query.page.mock.calls.length

    act(() => bridge.push("query.invalidated", { queryId: 1, version: 1, total: 3 }))
    act(() => bridge.push("query.invalidated", { queryId: 99, version: 9, total: 3 }))
    expect(bridge.api.query.page).toHaveBeenCalledTimes(pagesBefore)

    act(() =>
      bridge.push("index.progress", progress({ state: "completed", skipped: 12, errors: 1 })),
    )
    expect(screen.getByTestId("folder-summary")).toHaveTextContent(
      "250 items. 12 other files not shown. 1 folder couldn't be read",
    )
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument()
  })

  it("ignores progress from other scans and can stop the current one", async () => {
    const bridge = setup()
    await act(() => openFolder("/photos"))
    act(() => bridge.push("index.progress", progress({ scanId: 99, state: "completed" })))
    expect(screen.getByTestId("folder-summary")).toHaveTextContent("Indexing…")
    await userEvent.click(screen.getByRole("button", { name: "Stop" }))
    expect(bridge.api.dir.cancelScan).toHaveBeenCalledWith(1)
    act(() => bridge.push("index.progress", progress({ state: "cancelled" })))
    expect(screen.getByTestId("folder-summary")).toHaveTextContent("Indexing stopped")
  })

  it("keeps a completion event that arrives before dir.open resolves", async () => {
    const bridge = setup()
    bridge.api.dir.open.mockImplementationOnce(async (p) => {
      bridge.push("index.progress", progress({ state: "completed" }))
      return {
        ok: true,
        r: {
          dirId: 1,
          path: p.path,
          name: "x",
          scanId: 1,
          recursive: false,
          listedBefore: false,
          lastListedAt: null,
          crumbs: crumbsOf(p.path),
        },
      }
    })
    await act(() => openFolder("/fast"))
    expect(useFolderStore.getState().progress?.state).toBe("completed")
  })

  it("reopens an expired query session", async () => {
    const bridge = setup()
    bridge.backend.items = makeItems(5)
    await act(() => openFolder("/photos"))
    bridge.api.query.page.mockResolvedValueOnce({
      ok: false,
      e: { code: "NOT_FOUND", message: "expired", retryable: false },
    } as never)
    bridge.backend.version = 2
    await act(async () => bridge.push("query.invalidated", { queryId: 1, version: 2, total: 5 }))
    await waitFor(() => expect(bridge.api.query.open).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(useFolderStore.getState().query?.queryId).toBe(2))
  })
})

describe("while the commander is shown (hidden app rules, Stage P01)", () => {
  const hide = (bridge: ReturnType<typeof setup>, visible = false) =>
    act(() => bridge.push("app.visibility", { app: "viewer", visible }))

  it("makes no page request for a changed folder until the viewer is shown, then one catch-up", async () => {
    const bridge = setup()
    bridge.backend.items = makeItems(3)
    await act(() => openFolder("/photos"))
    await screen.findByText("IMG_0.jpg")
    const pagesBefore = bridge.api.query.page.mock.calls.length
    const facetsBefore = bridge.api.query.facets.mock.calls.length

    const versions: number[] = []
    const off = useFolderStore.subscribe((state, prev) => {
      if (state.query && state.query.version !== prev.query?.version)
        versions.push(state.query.version)
    })
    stop.push(off)

    hide(bridge)
    bridge.backend.items = makeItems(250)
    bridge.backend.version = 3
    act(() => bridge.push("query.invalidated", { queryId: 1, version: 2, total: 120 }))
    act(() => bridge.push("query.invalidated", { queryId: 1, version: 3, total: 250 }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(bridge.api.query.page).toHaveBeenCalledTimes(pagesBefore)
    expect(bridge.api.query.facets).toHaveBeenCalledTimes(facetsBefore)
    expect(useFolderStore.getState().query).toMatchObject({ version: 1, total: 3 })

    // Shown again: the newest version only, never the one in between.
    hide(bridge, true)
    expect(useFolderStore.getState().query).toMatchObject({ version: 3, total: 250 })
    await waitFor(() => expect(screen.getByTestId("folder-summary")).toHaveTextContent("250 items"))
    expect(bridge.api.query.page.mock.calls.length).toBeGreaterThan(pagesBefore)
    expect(versions).toEqual([3])
  })

  it("ignores the other app's visibility and a change of a folder it no longer shows", async () => {
    const bridge = setup()
    bridge.backend.items = makeItems(3)
    await act(() => openFolder("/photos"))
    await screen.findByText("IMG_0.jpg")
    const pagesBefore = bridge.api.query.page.mock.calls.length

    // The commander's own visibility says nothing about the viewer.
    act(() => bridge.push("app.visibility", { app: "commander", visible: false }))
    bridge.backend.version = 2
    act(() => bridge.push("query.invalidated", { queryId: 1, version: 2, total: 3 }))
    await waitFor(() => expect(useFolderStore.getState().query?.version).toBe(2))
    const pagesShown = bridge.api.query.page.mock.calls.length
    expect(pagesShown).toBeGreaterThan(pagesBefore)

    hide(bridge)
    act(() => bridge.push("query.invalidated", { queryId: 99, version: 9, total: 1 }))
    hide(bridge, true)
    expect(useFolderStore.getState().query).toMatchObject({ queryId: 1, version: 2 })
    expect(bridge.api.query.page).toHaveBeenCalledTimes(pagesShown)
  })

  it("shown again with nothing changed asks for nothing", async () => {
    const bridge = setup()
    bridge.backend.items = makeItems(3)
    await act(() => openFolder("/photos"))
    await screen.findByText("IMG_0.jpg")
    const pagesBefore = bridge.api.query.page.mock.calls.length
    hide(bridge)
    hide(bridge, true)
    expect(bridge.api.query.page).toHaveBeenCalledTimes(pagesBefore)
  })
})

describe("sorting and subfolders", () => {
  it("reopens the query with the new sort and closes the old session", async () => {
    const bridge = setup()
    await act(() => openFolder("/photos"))
    await userEvent.click(screen.getByRole("button", { name: "Sort" }))
    await userEvent.click(
      within(await screen.findByRole("group", { name: "Sort by" })).getByRole("menuitemradio", {
        name: "Date modified",
      }),
    )
    await userEvent.click(screen.getByRole("button", { name: "Sort" }))
    await userEvent.click(await screen.findByRole("menuitemradio", { name: "Newest first" }))
    await waitFor(() =>
      expect(bridge.api.query.open).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: [{ field: "modified", direction: "desc" }] }),
      ),
    )
    expect(bridge.api.query.close).toHaveBeenCalledWith(1)
  })

  it("re-opens the folder recursively when subfolders are included", async () => {
    const bridge = setup()
    await act(() => openFolder("/photos"))
    await userEvent.click(screen.getByLabelText("Include subfolders"))
    await waitFor(() =>
      expect(bridge.api.dir.open).toHaveBeenLastCalledWith({ path: "/photos", recursive: true }),
    )
    await waitFor(() =>
      expect(bridge.api.query.open).toHaveBeenLastCalledWith(
        expect.objectContaining({ recursive: true }),
      ),
    )
  })

  it("discards results from a folder opened before the latest one", async () => {
    const bridge = setup()
    let release!: () => void
    bridge.api.dir.open.mockImplementationOnce(
      (p) =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true,
              r: {
                dirId: 7,
                path: p.path,
                name: "slow",
                scanId: 7,
                recursive: false,
                listedBefore: false,
                lastListedAt: null,
                crumbs: crumbsOf(p.path),
              },
            })
        }),
    )
    const slow = openFolder("/slow")
    await act(() => openFolder("/fast"))
    release()
    await act(() => slow)
    expect(useFolderStore.getState().folder?.path).toBe("/fast")
  })
})
