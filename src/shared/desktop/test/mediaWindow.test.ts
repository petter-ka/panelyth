import type { ContentItem } from "@panelyth/contracts"
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
  const sent: { ch: string; p: { requestId: number; key: number; direction: number } }[] = []
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
})
