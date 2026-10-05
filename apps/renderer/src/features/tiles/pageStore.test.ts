import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installFakeBridge, makeItems } from "../../test/fakeBridge"
import {
  MAX_PAGES,
  PAGE_SIZE,
  getItem,
  invalidatePages,
  pageStats,
  resetPages,
  setExpiredHandler,
  setRange,
} from "./pageStore"

// The fake bridge resolves through microtasks. Draining microtasks is enough,
// and avoids jsdom's ~4 ms clamping of nested setTimeout(0).
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

let bridge: ReturnType<typeof installFakeBridge>
beforeEach(() => {
  bridge = installFakeBridge()
  bridge.backend.items = makeItems(50_000)
  resetPages({ queryId: 1, version: 1, total: 50_000 })
})
afterEach(() => setExpiredHandler(null))

const offsets = () =>
  bridge.api.query.page.mock.calls.map((c) => (c[0] as { offset: number }).offset)

describe("pageStore", () => {
  it("loads the pages covering the range plus one on each side", async () => {
    setRange(PAGE_SIZE * 10 + 5, PAGE_SIZE * 11 + 5)
    await settle()
    expect(new Set(offsets())).toEqual(new Set([9, 10, 11, 12].map((p) => p * PAGE_SIZE)))
    expect(getItem(PAGE_SIZE * 10 + 5)?.id).toBe(PAGE_SIZE * 10 + 6)
  })

  it("never has more than 3 requests in flight and skips pages scrolled past", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const original = bridge.api.query.page.getMockImplementation()!
    bridge.api.query.page.mockImplementation(async (p) => {
      await gate
      return original(p)
    })
    setRange(0, PAGE_SIZE * 6)
    expect(pageStats().inFlight).toBe(3)
    // The user scrolls far away before anything arrives.
    setRange(PAGE_SIZE * 40, PAGE_SIZE * 40 + 10)
    release()
    await settle()
    const fetched = new Set(offsets().map((o) => o / PAGE_SIZE))
    for (const p of [4, 5, 6]) expect(fetched.has(p)).toBe(false)
    expect(fetched.has(40)).toBe(true)
  })

  it("keeps a bounded number of pages whatever the scroll distance", async () => {
    for (let p = 0; p < 150; p += 2) {
      setRange(p * PAGE_SIZE, p * PAGE_SIZE + 10)
      await settle()
    }
    expect(pageStats().cached).toBeLessThanOrEqual(MAX_PAGES)
  })

  it("refetches only wanted pages after an invalidation", async () => {
    setRange(0, 10)
    await settle()
    const before = offsets().length
    bridge.backend.version = 2
    invalidatePages({ queryId: 1, version: 2, total: 50_000 })
    await settle()
    expect(new Set(offsets().slice(before))).toEqual(new Set([0, PAGE_SIZE]))
    invalidatePages({ queryId: 1, version: 1, total: 3 }) // stale: ignored
    invalidatePages({ queryId: 9, version: 9, total: 3 }) // other session: ignored
    await settle()
    expect(pageStats().version).toBe(2)
  })

  it("asks for a new session when the sidecar no longer knows it", async () => {
    const expired = vi.fn()
    setExpiredHandler(expired)
    bridge.api.query.page.mockResolvedValue({
      ok: false,
      e: { code: "NOT_FOUND", message: "expired", retryable: false },
    } as never)
    setRange(0, 10)
    await settle()
    expect(expired).toHaveBeenCalled()
  })

  it("drops responses that belong to an older session", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const original = bridge.api.query.page.getMockImplementation()!
    bridge.api.query.page.mockImplementationOnce(async (p) => {
      await gate
      return original(p)
    })
    setRange(0, 10)
    resetPages({ queryId: 2, version: 1, total: 5 })
    release()
    await settle()
    expect(getItem(0)).toBeUndefined()
  })
})
