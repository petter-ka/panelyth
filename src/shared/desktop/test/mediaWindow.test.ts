import type { ContentItem, MediaWindowStep } from "@panelyth/contracts"
import { beforeEach, describe, expect, it, vi } from "vitest"

const created: { webContents: { id: number } }[] = []

vi.mock("electron", () => ({
  BrowserWindow: class {
    webContents = { id: 100 + created.length, on: vi.fn(), setWindowOpenHandler: vi.fn() }
    full = true
    constructor() {
      created.push(this)
    }
    setMenuBarVisibility = vi.fn()
    on = vi.fn()
    once = vi.fn()
    loadURL = vi.fn(async () => undefined)
    isDestroyed = () => false
    isFullScreen = () => this.full
    setFullScreen = vi.fn((on: boolean) => {
      this.full = on
    })
    getBounds = () => ({ x: 0, y: 0, width: 1920, height: 1080 })
    setBounds = vi.fn()
    setMinimumSize = vi.fn()
  },
  screen: {
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
  },
}))
vi.mock("../src/main/paths", () => ({ appIconPath: () => "" }))

const { MediaWindows, mediaWindowUrl, windowedBounds, STEP_TIMEOUT_MS, WINDOWED_MIN } =
  await import("../src/main/mediaWindow")

const item = { id: 7, kind: "image", name: "a.jpg" } as ContentItem

function opener() {
  const sent: {
    ch: string
    p: { requestId: number; key: number; direction?: number; command?: string }
  }[] = []
  return {
    sent,
    isDestroyed: () => false,
    send: (_channel: string, message: (typeof sent)[number]) => sent.push(message),
  }
}

describe("mediaWindowUrl", () => {
  it("carries the entry, the theme and the language, never a path", () => {
    const url = mediaWindowUrl("app://commander/media.html", {
      entryId: 9,
      theme: "dark",
      lang: "de",
    })
    const params = new URLSearchParams(url.split("#")[1])
    expect(params.get("entry")).toBe("9")
    expect(params.get("lang")).toBe("de")
    expect(url).not.toContain("/home")
  })
})

const OPTIONS = {
  url: "app://commander/media.html",
  origin: "app://commander",
  preload: "p.cjs",
  devTools: false,
}

describe("a window for a file from the OS", () => {
  beforeEach(() => {
    created.length = 0
  })

  it("stands alone: it asks its source, not an opener, and the source goes with the window", async () => {
    const source = {
      step: vi.fn(async (direction: MediaWindowStep) => (direction === 0 ? item : null)),
      command: vi.fn(async () => ({ item, done: true })),
      current: vi.fn(() => ({ dirId: 3, entryId: 7 })),
      close: vi.fn(),
    }
    const parent = vi.fn(() => null)
    const windows = new MediaWindows(OPTIONS, parent)
    windows.open({ source })
    // No shell window is asked for: there may be none.
    expect(parent).not.toHaveBeenCalled()
    const win = created[0]! as unknown as {
      webContents: { id: number }
      loadURL: { mock: { calls: [string][] } }
      on: { mock: { calls: [string, () => void][] } }
    }
    const params = new URLSearchParams(win.loadURL.mock.calls[0]![0].split("#")[1])
    expect(params.get("alone")).toBe("1")
    expect(params.get("entry")).toBeNull()

    const sender = { id: win.webContents.id } as never
    expect(await windows.step(sender, 0)).toEqual(item)
    expect(await windows.step(sender, 1)).toBeNull()
    expect(source.step.mock.calls.map((c) => c[0])).toEqual([0, 1])
    // Its file keys go to the source as well: no opener carries them out.
    expect(await windows.command(sender, "copy")).toEqual({ item, done: true })
    expect(source.command).toHaveBeenCalledWith("copy")
    expect(await windows.command({ id: 999 } as never, "delete")).toEqual({
      item: null,
      done: false,
    })
    expect(windows.sourceOf(sender)).toBe(source)
    // Any other sender has no source (the reveal is refused for it).
    expect(windows.sourceOf({ id: 999 } as never)).toBeNull()

    win.on.mock.calls.find(([name]) => name === "closed")![1]()
    expect(source.close).toHaveBeenCalledTimes(1)
    expect(windows.sourceOf(sender)).toBeNull()
  })

  it("a window opened from an app has no source", () => {
    const windows = new MediaWindows(OPTIONS, () => null)
    windows.open({ opener: opener() as never, key: 1, entryId: 7 })
    expect(windows.sourceOf({ id: created[0]!.webContents.id } as never)).toBeNull()
  })
})

describe("MediaWindows relay", () => {
  beforeEach(() => {
    created.length = 0
    vi.useFakeTimers()
  })

  function setup() {
    const windows = new MediaWindows(
      {
        url: "app://commander/media.html",
        origin: "app://commander",
        preload: "p.cjs",
        devTools: false,
      },
      () => null,
    )
    const from = opener()
    windows.open({ opener: from as never, key: 4, entryId: 7 })
    const child = { id: created[0]!.webContents.id } as never
    return { windows, from, child }
  }

  it("asks the opener and returns what it answers", async () => {
    const { windows, from, child } = setup()
    const asked = windows.step(child, 1)
    expect(from.sent[0]!.p).toMatchObject({ key: 4, direction: 1 })
    windows.answer(from as never, from.sent[0]!.p.requestId, item)
    await expect(asked).resolves.toEqual(item)
  })

  it("ignores an answer from anyone but the opener", async () => {
    const { windows, from, child } = setup()
    const asked = windows.step(child, -1)
    windows.answer({} as never, from.sent[0]!.p.requestId, item)
    await vi.advanceTimersByTimeAsync(STEP_TIMEOUT_MS)
    await expect(asked).resolves.toBeNull()
  })

  it("gives up when the opener never answers, and for a window it does not know", async () => {
    const { windows, child } = setup()
    const asked = windows.step(child, 0)
    await vi.advanceTimersByTimeAsync(STEP_TIMEOUT_MS)
    await expect(asked).resolves.toBeNull()
    await expect(windows.step({ id: 1 } as never, 1)).resolves.toBeNull()
  })

  it("relays a file command to the opener and returns the item it shows next", async () => {
    const { windows, from, child } = setup()
    const asked = windows.command(child, "trash")
    expect(from.sent[0]).toMatchObject({
      ch: "mediaWindow.command",
      p: { key: 4, command: "trash" },
    })
    windows.answer(from as never, from.sent[0]!.p.requestId, item, true)
    await expect(asked).resolves.toEqual({ item, done: true })
  })

  it("tells the opener when the window closes", () => {
    const { from } = setup()
    const win = created[0]! as unknown as { on: { mock: { calls: [string, () => void][] } } }
    win.on.mock.calls.find(([name]) => name === "closed")![1]()
    expect(from.sent).toEqual([{ ch: "mediaWindow.closed", p: { key: 4 } }])
  })
})

describe("a window for a file from the OS has no opener", () => {
  it("its source answers a command, and no opener is asked", async () => {
    created.length = 0
    const source = {
      step: vi.fn(async () => item),
      command: vi.fn(async () => ({ item: null, done: true })),
      current: vi.fn(() => null),
      close: vi.fn(),
    }
    const windows = new MediaWindows(OPTIONS, () => null)
    windows.open({ source })
    await expect(
      windows.command({ id: created[0]!.webContents.id } as never, "delete"),
    ).resolves.toEqual({ item: null, done: true })
    expect(source.command).toHaveBeenCalledWith("delete")
  })
})

describe("leaving full screen", () => {
  type Win = {
    webContents: { id: number }
    setFullScreen: { mock: { calls: [boolean][] } }
    setBounds: { mock: { calls: unknown[][] } }
    once: { mock: { calls: [string, () => void][] } }
  }

  it("sizes the window to a share of the screen, centred, never below its least size", () => {
    expect(windowedBounds({ x: 0, y: 0, width: 1920, height: 1040 })).toEqual({
      x: 288,
      y: 156,
      width: 1344,
      height: 728,
    })
    // A small screen: the least size, kept on the screen.
    expect(windowedBounds({ x: 100, y: 0, width: 600, height: 400 })).toEqual({
      x: 160,
      y: 40,
      width: WINDOWED_MIN.width,
      height: WINDOWED_MIN.height,
    })
    expect(windowedBounds({ x: 0, y: 0, width: 400, height: 300 })).toMatchObject({
      width: 400,
      height: 300,
    })
  })

  it("leaves and goes back to full screen; the first time out it is placed, later it keeps its place", () => {
    created.length = 0
    const windows = new MediaWindows(OPTIONS, () => null)
    windows.open({ opener: opener() as never, key: 1, entryId: 7 })
    const win = created[0]! as unknown as Win
    const sender = { id: win.webContents.id } as never
    const placings = () => win.once.mock.calls.filter(([name]) => name === "leave-full-screen")

    expect(windows.setFullScreen(sender, false)).toBe(false)
    expect(win.setFullScreen.mock.calls).toEqual([[false]])
    placings()[0]![1]()
    expect(win.setBounds.mock.calls).toEqual([[{ x: 288, y: 156, width: 1344, height: 728 }]])
    // Already out: nothing to do.
    expect(windows.setFullScreen(sender, false)).toBe(false)
    expect(win.setFullScreen.mock.calls).toHaveLength(1)

    expect(windows.setFullScreen(sender, true)).toBe(true)
    expect(windows.setFullScreen(sender, false)).toBe(false)
    expect(win.setFullScreen.mock.calls).toEqual([[false], [true], [false]])
    // The size and place the user gave the window stay.
    expect(placings()).toHaveLength(1)
  })

  it("does nothing for a sender that is no media window", () => {
    created.length = 0
    const windows = new MediaWindows(OPTIONS, () => null)
    windows.open({ opener: opener() as never, key: 1, entryId: 7 })
    expect(windows.setFullScreen({ id: 999 } as never, false)).toBe(true)
    expect((created[0]! as unknown as Win).setFullScreen.mock.calls).toEqual([])
  })
})
