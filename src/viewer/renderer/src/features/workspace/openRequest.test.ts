import type { OpenRequest } from "@panelyth/contracts"
import { beforeEach, describe, expect, it, vi } from "vitest"

// "Open with" (ADR-0033 amended): the viewer shows a file's folder with the
// file selected when main asks, at start or later.

const m = vi.hoisted(() => ({
  available: true,
  request: null as OpenRequest | null,
  listener: null as ((r: OpenRequest) => void) | null,
  folder: null as { dirId: number } | null,
  /** The folder openFolderEntry leaves open (null: it could not be opened). */
  opens: true,
  calls: [] as string[],
}))

vi.mock("../../bridge", () => ({
  isBridgeAvailable: () => m.available,
  bridge: {
    takeOpenRequest: vi.fn(async () => {
      const r = m.request
      m.request = null
      return r
    }),
    on: vi.fn((channel: string, listener: (r: OpenRequest) => void) => {
      if (channel === "open.request") m.listener = listener
      return () => {
        m.listener = null
      }
    }),
  },
}))
vi.mock("../folder/folderStore", () => ({
  openFolderEntry: vi.fn(async (dirId: number) => {
    m.calls.push(`open ${dirId}`)
    m.folder = m.opens ? { dirId } : null
  }),
  useFolderStore: { getState: () => ({ folder: m.folder }) },
}))
vi.mock("./appSwitch", () => ({
  selectEntry: vi.fn(async (entryId: number) => {
    m.calls.push(`select ${entryId}`)
  }),
}))

const { openRequestSettled, resetOpenRequests, startOpenRequests } = await import("./openRequest")

beforeEach(() => {
  resetOpenRequests()
  m.available = true
  m.request = null
  m.listener = null
  m.folder = null
  m.opens = true
  m.calls = []
})

describe("open requests", () => {
  it("opens the folder and selects the file the app was started for", async () => {
    m.request = { dirId: 12, entryId: 34 }
    startOpenRequests()
    expect(await openRequestSettled()).toBe(true)
    // The folder first, then the entry in it.
    expect(m.calls).toEqual(["open 12", "select 34"])
  })

  it("says there was none on an ordinary start, so the startup folder opens", async () => {
    startOpenRequests()
    expect(await openRequestSettled()).toBe(false)
    expect(m.calls).toEqual([])
  })

  it("follows a request while the viewer runs", async () => {
    startOpenRequests()
    await openRequestSettled()
    m.listener!({ dirId: 5, entryId: 6 })
    await vi.waitFor(() => expect(m.calls).toEqual(["open 5", "select 6"]))
  })

  it("selects nothing when the folder could not be opened", async () => {
    m.opens = false
    m.request = { dirId: 12, entryId: 34 }
    startOpenRequests()
    expect(await openRequestSettled()).toBe(true)
    expect(m.calls).toEqual(["open 12"])
  })

  it("does nothing without a bridge, and stops listening when stopped", async () => {
    m.available = false
    startOpenRequests()
    expect(await openRequestSettled()).toBe(false)
    expect(m.listener).toBeNull()

    m.available = true
    resetOpenRequests()
    const stop = startOpenRequests()
    expect(m.listener).not.toBeNull()
    stop()
    expect(m.listener).toBeNull()
  })
})
