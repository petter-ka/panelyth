import type { ContentItem, MediaWindowStep } from "@panelyth/contracts"
import { beforeEach, describe, expect, it, vi } from "vitest"

const created: { webContents: { id: number } }[] = []

vi.mock("electron", () => ({
  BrowserWindow: class {
    webContents = { id: 100 + created.length, on: vi.fn(), setWindowOpenHandler: vi.fn() }
    constructor() {
      created.push(this)
    }
    setMenuBarVisibility = vi.fn()
    on = vi.fn()
    once = vi.fn()
    loadURL = vi.fn(async () => undefined)
  },
}))
vi.mock("../src/main/paths", () => ({ appIconPath: () => "" }))

const { MediaWindows, mediaWindowUrl, STEP_TIMEOUT_MS } = await import("../src/main/mediaWindow")

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

describe("a window for a file from the OS takes no commands", () => {
  it("answers null without asking anyone", async () => {
    created.length = 0
    const source = { step: vi.fn(async () => item), current: vi.fn(() => null), close: vi.fn() }
    const windows = new MediaWindows(OPTIONS, () => null)
    windows.open({ source })
    await expect(
      windows.command({ id: created[0]!.webContents.id } as never, "delete"),
    ).resolves.toEqual({ item: null, done: false })
  })
})
