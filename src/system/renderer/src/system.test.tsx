import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "./App"
import { glyphOf } from "./components/SearchCard"
import { resetSearch, searchMask, startSearchEvents, useSearchStore } from "./features/search"
import {
  loadBetween,
  resetSystem,
  sampleLoad,
  SAMPLE_MS,
  startSystem,
  useSystemStore,
} from "./features/system"
import { mockViewport } from "./test/viewport"
import { installFakeSystemApi, item, removeFakeSystemApi, type FakeSystem } from "./test/fakeApi"

let fake: FakeSystem
const stops: Array<() => void> = []

beforeEach(() => {
  fake = installFakeSystemApi()
  resetSystem()
  resetSearch()
})

afterEach(() => {
  stops.splice(0).forEach((stop) => stop())
  removeFakeSystemApi()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const start = (): void => {
  stops.push(startSystem(), startSearchEvents())
}

describe("load between two samples", () => {
  it("is busy time over all time, per processor and together", () => {
    const point = loadBetween(
      {
        at: 0,
        cores: [
          { busyMs: 0, totalMs: 0 },
          { busyMs: 100, totalMs: 1000 },
        ],
        freeMemoryBytes: 4,
        totalMemoryBytes: 16,
      },
      {
        at: 1000,
        cores: [
          { busyMs: 500, totalMs: 1000 },
          { busyMs: 200, totalMs: 2000 },
        ],
        freeMemoryBytes: 4,
        totalMemoryBytes: 16,
      },
    )
    expect(point.cores).toEqual([0.5, 0.1])
    expect(point.cpu).toBeCloseTo(0.3)
    expect(point.memory).toBe(0.75)
    expect(point.usedBytes).toBe(12)
  })

  it("reads a processor without time or without a previous sample as idle", () => {
    const point = loadBetween(
      { at: 0, cores: [{ busyMs: 5, totalMs: 10 }], freeMemoryBytes: 0, totalMemoryBytes: 0 },
      {
        at: 1,
        cores: [
          { busyMs: 5, totalMs: 10 },
          { busyMs: 9, totalMs: 9 },
        ],
        freeMemoryBytes: 0,
        totalMemoryBytes: 0,
      },
    )
    expect(point.cores).toEqual([0, 0])
    expect(point.memory).toBe(0)
  })
})

describe("the search mask", () => {
  it("matches typed text anywhere in a name, its words in order", () => {
    expect(searchMask("holiday")).toBe("*holiday*")
    expect(searchMask("  my  file ")).toBe("*my*file*")
  })

  it("keeps a mask typed on purpose", () => {
    expect(searchMask("*.jpg")).toBe("*.jpg")
    expect(searchMask("a?c")).toBe("a?c")
    expect(searchMask("   ")).toBe("")
  })
})

describe("the result icons", () => {
  it("follow the kind, then the extension", () => {
    expect(glyphOf({ ...item(1, "a", ""), kind: "dir" })).toBe("folder")
    expect(glyphOf(item(1, "a.zip", ""))).toBe("archive")
    expect(glyphOf(item(1, "a.pdf", ""))).toBe("pdf")
    expect(glyphOf(item(1, "a.bin", ""))).toBe("other")
  })
})

describe("the dashboard", () => {
  it("shows the computer, its graphics and its volumes", async () => {
    start()
    render(<App />)
    expect(await screen.findByTestId("hostname")).toHaveTextContent("STUDIO-PC")
    expect(screen.getByTestId("os")).toHaveTextContent("Windows 11 · x64")
    expect(screen.getByTestId("gpu-card")).toHaveTextContent("GeForce RTX 5080")
    expect(screen.getByTestId("gpu-card")).toHaveTextContent("In use")
    await waitFor(() => expect(screen.getAllByTestId("volume")).toHaveLength(3))
    const [c, , e] = screen.getAllByTestId("volume")
    expect(within(c!).getByRole("meter")).toHaveAttribute("aria-valuenow", "90")
    expect(e!).toHaveTextContent("Not ready")
    expect(screen.getByRole("meter", { name: "Storage in use, all volumes" })).toHaveAttribute(
      "aria-valuenow",
      "95",
    )
    expect(screen.getByTestId("cpu-card")).toHaveTextContent("Logical processors: 4")
  })

  it("shows the load of the last second once two samples are in", async () => {
    render(<App />)
    await act(async () => {
      await sampleLoad()
      await sampleLoad()
    })
    // Cores at 50, 25, 100 and 0%: 44% together.
    expect(screen.getByRole("meter", { name: "Processor load" })).toHaveAttribute(
      "aria-valuenow",
      "44",
    )
    expect(screen.getByRole("meter", { name: "Memory in use" })).toHaveAttribute(
      "aria-valuenow",
      "75",
    )
    expect(screen.getByTestId("memory-card")).toHaveTextContent("48 GB of 64 GB in use, 16 GB free")
  })

  it("samples only while System is on screen", async () => {
    vi.useFakeTimers()
    start()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAMPLE_MS * 3)
    })
    const sampled = fake.raw.system.load.mock.calls.length
    expect(sampled).toBeGreaterThanOrEqual(3)
    act(() => fake.emit("app.visibility", { app: "system", visible: false }))
    expect(useSystemStore.getState().sample).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAMPLE_MS * 5)
    })
    expect(fake.raw.system.load.mock.calls.length).toBe(sampled)
    // A drive plugged in while hidden is not read until System is shown.
    const volumesRead = fake.raw.fs.volumes.mock.calls.length
    act(() => fake.emit("volumes.changed", {} as never))
    expect(fake.raw.fs.volumes.mock.calls.length).toBe(volumesRead)
    // Another app's visibility is not System's.
    act(() => fake.emit("app.visibility", { app: "commander", visible: true }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAMPLE_MS * 2)
    })
    expect(fake.raw.system.load.mock.calls.length).toBe(sampled)
    act(() => fake.emit("app.visibility", { app: "system", visible: true }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAMPLE_MS * 2)
    })
    expect(fake.raw.system.load.mock.calls.length).toBeGreaterThan(sampled)
  })
})

describe("searching the volumes", () => {
  const progress = (state: "running" | "completed", dirs: number) => ({
    findId: 7,
    state,
    dirs,
    entries: dirs * 10,
    searched: 0,
    bytes: 0,
    errors: 0,
    current: "D:\\Photos",
    matches: fake.total,
    truncated: false,
    firstMatchMs: 5,
    elapsedMs: 20,
  })

  it("searches the volumes that answer, by plain text", async () => {
    const user = userEvent.setup()
    start()
    render(<App />)
    const chips = await screen.findAllByRole("button", { pressed: true })
    expect(chips.map((c) => c.textContent)).toEqual(["C:\\System", "D:\\Photos"])
    await user.type(screen.getByTestId("search-text"), "holiday{Enter}")
    expect(fake.raw.find.start).toHaveBeenCalledWith(
      expect.objectContaining({ roots: ["C:\\", "D:\\"], mask: "*holiday*", depth: -1 }),
    )
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument()
  })

  it("leaves out a volume whose chip is turned off", async () => {
    const user = userEvent.setup()
    start()
    render(<App />)
    await user.click(await screen.findByRole("button", { name: /C:\\/ }))
    expect(screen.getByRole("button", { name: /C:\\/ })).toHaveAttribute("aria-pressed", "false")
    await user.type(screen.getByTestId("search-text"), "x")
    await user.click(screen.getByRole("button", { name: "Search" }))
    expect(fake.raw.find.start).toHaveBeenCalledWith(expect.objectContaining({ roots: ["D:\\"] }))
  })

  it("lists results as they arrive and opens one in the commander", async () => {
    mockViewport(800, 600)
    const user = userEvent.setup()
    start()
    render(<App />)
    await screen.findAllByRole("button", { pressed: true })
    await user.type(screen.getByTestId("search-text"), "holiday{Enter}")
    await waitFor(() => expect(useSearchStore.getState().queryId).toBe(70))

    const version = fake.found([
      item(101, "holiday-01.jpg", "D:\\Photos\\2024"),
      item(102, "holiday-02.jpg", "D:\\Photos\\2024"),
      item(103, "holiday.zip", "C:\\Backup"),
    ])
    act(() => {
      fake.emit("query.invalidated", { queryId: 70, version, total: 3 })
      fake.emit("find.progress", progress("running", 12))
    })
    const list = await screen.findByTestId("search-results")
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(3))
    expect(within(list).getByText("holiday.zip")).toBeInTheDocument()
    expect(within(list).getByText("C:\\Backup")).toBeInTheDocument()

    act(() => fake.emit("find.progress", progress("completed", 40)))
    expect(screen.getByTestId("search-status")).toHaveTextContent("Found: 3")
    expect(screen.getByTestId("search-status")).toHaveTextContent("Folders searched: 40")
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument()

    await user.dblClick(within(list).getByText("holiday-02.jpg"))
    await waitFor(() => expect(fake.raw.app.switch).toHaveBeenCalledWith("commander"))
    expect(fake.raw.dir.openContaining).toHaveBeenCalledWith(102)
    expect(fake.raw.context.publish).toHaveBeenCalledWith(42, 102)
  })

  it("moves through the results with the keyboard and opens with Enter", async () => {
    mockViewport(800, 600)
    const user = userEvent.setup()
    start()
    render(<App />)
    await screen.findAllByRole("button", { pressed: true })
    await user.type(screen.getByTestId("search-text"), "holiday{Enter}")
    await waitFor(() => expect(useSearchStore.getState().queryId).toBe(70))
    const version = fake.found([item(201, "a.txt", "C:\\"), item(202, "b.txt", "C:\\")])
    act(() => fake.emit("query.invalidated", { queryId: 70, version, total: 2 }))
    const list = await screen.findByTestId("search-results")
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(2))
    list.focus()
    await user.keyboard("{ArrowDown}{Enter}")
    await waitFor(() => expect(fake.raw.dir.openContaining).toHaveBeenCalledWith(202))
  })

  it("stops a running search", async () => {
    const user = userEvent.setup()
    start()
    render(<App />)
    await screen.findAllByRole("button", { pressed: true })
    await user.type(screen.getByTestId("search-text"), "holiday{Enter}")
    await waitFor(() => expect(useSearchStore.getState().findId).toBe(7))
    await user.click(screen.getByRole("button", { name: "Stop" }))
    expect(fake.raw.find.cancel).toHaveBeenCalledWith(7)
    expect(screen.getByTestId("search-status")).toHaveTextContent("Stopped")
  })
})
