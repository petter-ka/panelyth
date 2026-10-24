import type { BrowserWindow, Rectangle } from "electron"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_SIZE,
  initialBounds,
  parseWindowState,
  WindowStateFile,
  type WindowStateFileDeps,
} from "../src/main/windowState"

// The main window opens at the size and place of the previous run.

const primary: Rectangle = { x: 0, y: 0, width: 1920, height: 1040 }
const right: Rectangle = { x: 1920, y: 0, width: 2560, height: 1400 }
const saved = { x: 100, y: 80, width: 1600, height: 950, maximized: false }

describe("parseWindowState", () => {
  it("reads what was written and nothing else", () => {
    expect(parseWindowState(JSON.stringify({ v: 1, ...saved }))).toEqual(saved)
    expect(parseWindowState(JSON.stringify({ v: 1, ...saved, maximized: true }))?.maximized).toBe(
      true,
    )
    expect(parseWindowState("")).toBeNull()
    expect(parseWindowState("null")).toBeNull()
    expect(parseWindowState(JSON.stringify({ v: 2, ...saved }))).toBeNull()
    expect(parseWindowState(JSON.stringify({ v: 1, ...saved, width: "1600" }))).toBeNull()
    expect(parseWindowState(JSON.stringify({ v: 1, ...saved, height: 0 }))).toBeNull()
    expect(parseWindowState(JSON.stringify({ v: 1, ...saved, x: 1.5 }))).toBeNull()
  })
})

describe("initialBounds", () => {
  it("is the default size, centered, without a saved state", () => {
    expect(initialBounds(null, [primary])).toEqual({ ...DEFAULT_SIZE, maximized: false })
  })

  it("is the saved size and place while that place is on a display", () => {
    expect(initialBounds(saved, [primary, right])).toEqual(saved)
    const onRight = { ...saved, x: 2200, y: 100, maximized: true }
    expect(initialBounds(onRight, [primary, right])).toEqual(onRight)
  })

  it("centers the saved size when its display is gone", () => {
    const onRight = { ...saved, x: 2200, y: 100, maximized: true }
    expect(initialBounds(onRight, [primary])).toEqual({
      width: 1600,
      height: 950,
      maximized: true,
    })
    // The title bar above the display's top cannot be reached either.
    expect(initialBounds({ ...saved, y: -500 }, [primary])).not.toHaveProperty("x")
  })

  it("shrinks to a smaller display and keeps the window inside it", () => {
    const big = { x: 2000, y: 50, width: 2400, height: 1350, maximized: false }
    expect(initialBounds(big, [primary, { ...right, width: 1600, height: 900 }])).toEqual({
      x: 1920,
      y: 0,
      width: 1600,
      height: 900,
      maximized: false,
    })
    // Gone with its display: no larger than the one that is left.
    expect(initialBounds(big, [primary])).toEqual({ width: 1920, height: 1040, maximized: false })
  })

  it("is never below the minimum size", () => {
    expect(initialBounds({ ...saved, width: 200, height: 100 }, [primary])).toMatchObject({
      width: 720,
      height: 480,
    })
  })
})

type Listener = () => void

function fakeWindow(bounds: Rectangle) {
  const listeners = new Map<string, Listener[]>()
  const state = { bounds, maximized: false, minimized: false, fullScreen: false, destroyed: false }
  const win = {
    on: (event: string, fn: Listener) =>
      listeners.set(event, [...(listeners.get(event) ?? []), fn]),
    isDestroyed: () => state.destroyed,
    isMinimized: () => state.minimized,
    isMaximized: () => state.maximized,
    isFullScreen: () => state.fullScreen,
    getNormalBounds: () => state.bounds,
  }
  const emit = (event: string) => listeners.get(event)?.forEach((fn) => fn())
  return { win: win as unknown as BrowserWindow, state, emit }
}

function fakeFile(text: string | null) {
  const writes: string[] = []
  const deps: WindowStateFileDeps = {
    read: async () => {
      if (text === null) throw new Error("ENOENT")
      return text
    },
    write: vi.fn(async (_path: string, t: string) => {
      writes.push(t)
    }),
    log: vi.fn(),
  }
  return { deps, writes }
}

describe("WindowStateFile", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("loads the previous run's state; a missing file is none", async () => {
    const present = new WindowStateFile("w.json", fakeFile(JSON.stringify({ v: 1, ...saved })).deps)
    await present.ready()
    expect(present.current).toEqual(saved)
    const missing = new WindowStateFile("w.json", fakeFile(null).deps)
    await missing.ready()
    expect(missing.current).toBeNull()
  })

  it("saves once a resize rests, and at once when the window closes", async () => {
    vi.useFakeTimers()
    const { deps, writes } = fakeFile(null)
    const file = new WindowStateFile("w.json", deps)
    await file.ready()
    const { win, state, emit } = fakeWindow({ x: 10, y: 20, width: 1200, height: 800 })
    file.track(win)

    for (let i = 0; i < 20; i++) emit("resize")
    vi.advanceTimersByTime(999)
    expect(writes).toEqual([])
    vi.advanceTimersByTime(1)
    await file.flush()
    expect(writes).toEqual([
      JSON.stringify({ v: 1, x: 10, y: 20, width: 1200, height: 800, maximized: false }),
    ])

    state.maximized = true
    emit("maximize")
    emit("close")
    await file.flush()
    expect(JSON.parse(writes[1]!)).toMatchObject({ width: 1200, maximized: true })
    expect(file.current).toMatchObject({ width: 1200, maximized: true })
    // The timer of the maximize was cleared by the close.
    vi.advanceTimersByTime(5000)
    await file.flush()
    expect(writes).toHaveLength(2)
  })

  it("writes nothing when nothing changed", async () => {
    const { deps, writes } = fakeFile(
      JSON.stringify({ v: 1, x: 10, y: 20, width: 1200, height: 800, maximized: false }),
    )
    const file = new WindowStateFile("w.json", deps)
    await file.ready()
    const { win, emit } = fakeWindow({ x: 10, y: 20, width: 1200, height: 800 })
    file.track(win)
    emit("close")
    await file.flush()
    expect(writes).toEqual([])
  })

  it("keeps the maximized state of a minimized window; full screen opens maximized", async () => {
    const { deps, writes } = fakeFile(JSON.stringify({ v: 1, ...saved, maximized: true }))
    const file = new WindowStateFile("w.json", deps)
    await file.ready()
    const { win, state } = fakeWindow({ x: 0, y: 0, width: 1000, height: 700 })
    state.minimized = true
    file.save(win)
    await file.flush()
    expect(JSON.parse(writes[0]!)).toMatchObject({ width: 1000, maximized: true })

    state.minimized = false
    state.fullScreen = true
    state.bounds = { x: 0, y: 0, width: 1100, height: 700 }
    file.save(win)
    await file.flush()
    expect(JSON.parse(writes[1]!)).toMatchObject({ width: 1100, maximized: true })
  })

  it("keeps the theme, so the next window opens in its colors", async () => {
    const { deps, writes } = fakeFile(JSON.stringify({ v: 1, ...saved, theme: "beige" }))
    const file = new WindowStateFile("w.json", deps)
    await file.ready()
    expect(file.theme).toBe("beige")
    expect(file.current).toEqual(saved)

    file.setTheme("beige")
    await file.flush()
    expect(writes).toEqual([])
    file.setTheme("system")
    await file.flush()
    expect(JSON.parse(writes[0]!)).toEqual({ v: 1, ...saved, theme: "system" })
    // A resize keeps it.
    const { win } = fakeWindow({ x: 0, y: 0, width: 1000, height: 700 })
    file.save(win)
    await file.flush()
    expect(JSON.parse(writes[1]!)).toMatchObject({ width: 1000, theme: "system" })
  })

  it("keeps the design style beside the theme", async () => {
    const { deps, writes } = fakeFile(
      JSON.stringify({ v: 1, ...saved, theme: "dark", style: "terminal" }),
    )
    const file = new WindowStateFile("w.json", deps)
    await file.ready()
    expect(file.style).toBe("terminal")
    file.setStyle("terminal")
    await file.flush()
    expect(writes).toEqual([])
    file.setStyle("glass")
    await file.flush()
    expect(JSON.parse(writes[0]!)).toEqual({ v: 1, ...saved, theme: "dark", style: "glass" })
  })

  it("waits for the window's first save before writing a theme of a first run", async () => {
    const { deps, writes } = fakeFile(null)
    const file = new WindowStateFile("w.json", deps)
    await file.ready()
    expect(file.theme).toBeNull()
    file.setTheme("light")
    await file.flush()
    expect(writes).toEqual([])
    file.save(fakeWindow({ x: 0, y: 0, width: 1000, height: 700 }).win)
    await file.flush()
    expect(JSON.parse(writes[0]!)).toMatchObject({ width: 1000, theme: "light" })
  })

  it("tries again after a failed write", async () => {
    const { deps, writes } = fakeFile(null)
    vi.mocked(deps.write).mockRejectedValueOnce(new Error("disk full"))
    const file = new WindowStateFile("w.json", deps)
    await file.ready()
    const { win } = fakeWindow({ x: 0, y: 0, width: 1000, height: 700 })
    file.save(win)
    await file.flush()
    expect(deps.log).toHaveBeenCalledOnce()
    file.save(win)
    await file.flush()
    expect(writes).toHaveLength(1)
  })
})
