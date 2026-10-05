import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ContentPane } from "../../components/ContentPane"
import { installFakeBridge, makeItems } from "../../test/fakeBridge"
import { mockViewport } from "../../test/viewport"
import { openFolder, resetFolderStore, startFolderMonitoring } from "../folder/folderStore"
import { resetLayoutStore } from "../tiles/layoutStore"
import { startSidecarMonitoring, useSidecarStore } from "../system/sidecarStore"
import {
  getThumb,
  reportBroken,
  resetThumbs,
  setThumbProfile,
  startThumbMonitoring,
} from "./thumbStore"

const url = (id: number) => `fastview-thumb://t/${String(id).padStart(64, "0")}.jpg`
let stop: (() => void)[] = []

function setup(items = makeItems(5, 1)) {
  const bridge = installFakeBridge()
  bridge.backend.items = items
  stop = [startSidecarMonitoring(), startFolderMonitoring(), startThumbMonitoring()]
  render(<ContentPane />)
  return bridge
}

const box = (index: number) =>
  screen.getAllByTestId("tile")[index]!.querySelector<HTMLElement>("[data-thumb-box]")!

const ensureCalls = (bridge: ReturnType<typeof setup>) =>
  bridge.api.preview.ensure.mock.calls.map(
    (c) => c[0] as { lane: string; items: { id: number; priority: number }[]; force: number[] },
  )

beforeEach(() => {
  mockViewport(1000, 800)
  localStorage.clear()
  resetLayoutStore()
  resetFolderStore()
  resetThumbs()
  setThumbProfile("grid-sm")
  useSidecarStore.setState({ status: null, info: null, pingMs: null, error: null })
})
afterEach(() => {
  stop.forEach((f) => f())
  vi.restoreAllMocks()
})

describe("thumbnails on tiles", () => {
  it("requests missing thumbs in one batch and shows them as they arrive", async () => {
    const bridge = setup()
    await act(() => openFolder("/photos"))
    await waitFor(() => expect(bridge.api.preview.ensure).toHaveBeenCalledTimes(1))
    const [req] = ensureCalls(bridge)
    expect(req!.lane).toBe("tiles")
    expect(req!.items.map((i) => i.id)).toEqual([2, 3, 4, 5]) // the folder (id 1) is never requested

    act(() =>
      bridge.push("preview.ready", {
        items: [
          { id: 2, profile: "grid-sm", url: url(2), width: 192, height: 128 },
          { id: 3, profile: "grid-sm", failed: "CORRUPT_MEDIA" },
          { id: 4, profile: "grid-md", url: url(4), width: 384, height: 256 }, // other profile: ignored
        ],
      }),
    )
    expect(box(1).querySelector("img")).toHaveAttribute("src", url(2))
    expect(box(2).querySelector("img")).toBeNull()
    expect(box(2).querySelector("svg")).not.toBeNull() // "can't preview" symbol
    expect(getThumb(4)?.status).toBe("pending")
  })

  it("uses thumbs already attached to the page without asking for them", async () => {
    const items = makeItems(3).map((it) => ({
      ...it,
      thumb: { url: url(it.id), width: 192, height: 144 },
    }))
    const bridge = setup(items)
    await act(() => openFolder("/cached"))
    await new Promise((r) => setTimeout(r, 150))
    expect(bridge.api.preview.ensure).not.toHaveBeenCalled()
    expect([0, 1, 2].every((i) => box(i).querySelector("img"))).toBe(true)
  })

  it("regenerates a broken cache file once, then gives up", async () => {
    const bridge = setup(makeItems(2))
    await act(() => openFolder("/photos"))
    act(() =>
      bridge.push("preview.ready", {
        items: [{ id: 1, profile: "grid-sm", url: url(1), width: 1, height: 1 }],
      }),
    )
    await act(async () => reportBroken(1))
    // The view may request its range too; exactly one call must force id 1.
    const forced = ensureCalls(bridge).filter((c) => c.force.includes(1))
    expect(forced).toHaveLength(1)
    expect(forced[0]!.items).toEqual([{ id: 1, priority: 0 }])
    act(() => reportBroken(1))
    expect(getThumb(1)).toEqual({ status: "failed", code: "CACHE_ERROR" })
  })

  it("forgets the previous folder's thumbs when another folder opens", async () => {
    const bridge = setup(makeItems(2))
    await act(() => openFolder("/a"))
    act(() =>
      bridge.push("preview.ready", {
        items: [{ id: 1, profile: "grid-sm", url: url(1), width: 1, height: 1 }],
      }),
    )
    await act(() => openFolder("/b"))
    expect(getThumb(1)?.status).not.toBe("ready")
  })

  it("switches profile with tile size and drops thumbs of the old size", async () => {
    const bridge = setup(makeItems(3))
    await act(() => openFolder("/photos"))
    act(() =>
      bridge.push("preview.ready", {
        items: [{ id: 1, profile: "grid-sm", url: url(1), width: 1, height: 1 }],
      }),
    )
    act(() => setThumbProfile("grid-md"))
    expect(getThumb(1)).toBeUndefined()
  })
})

describe("modified files", () => {
  it("drops the old thumbnail when a file changes in place", async () => {
    const items = makeItems(2)
    const bridge = setup(items)
    await act(() => openFolder("/photos"))
    await waitFor(() => expect(bridge.api.preview.ensure).toHaveBeenCalled())
    act(() =>
      bridge.push("preview.ready", {
        items: [{ id: 1, profile: "grid-sm", url: url(1), width: 1, height: 1 }],
      }),
    )
    expect(getThumb(1)?.status).toBe("ready")
    bridge.backend.items = [
      { ...items[0]!, sizeBytes: 999, modifiedMs: 2_000_000_000_000 },
      items[1]!,
    ]
    bridge.backend.version = 2
    const before = bridge.api.preview.ensure.mock.calls.length
    await act(async () => bridge.push("query.invalidated", { queryId: 1, version: 2, total: 2 }))
    await waitFor(() => expect(bridge.api.preview.ensure.mock.calls.length).toBeGreaterThan(before))
    expect(
      ensureCalls(bridge)
        .at(-1)!
        .items.map((i) => i.id),
    ).toContain(1)
    expect(getThumb(1)?.status).toBe("pending")
  })
})
