import type { ContentItem } from "@fastview/contracts"
import { act, render } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPageStore, type PageFetch, type PageStore, usePageItem } from "./pageStore"

async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

const item = (id: number): ContentItem => ({
  id,
  kind: "file",
  name: `f${id}.txt`,
  ext: "txt",
  sizeBytes: id,
  modifiedMs: 0,
  favorite: false,
  rating: 0,
  label: 0,
  thumb: null,
})

class Expired extends Error {}

/** A backend with one session per query id; items are id = index + 1. */
function backend(totals: Record<number, number>) {
  const versions: Record<number, number> = {}
  const fetch = vi.fn<PageFetch>(async (queryId, offset, limit) => {
    const total = totals[queryId]
    if (total === undefined) throw new Expired()
    const items: ContentItem[] = []
    for (let i = offset; i < Math.min(total, offset + limit); i++)
      items.push(item(queryId * 1e6 + i + 1))
    return { queryId, version: versions[queryId] ?? 1, total, items }
  })
  return { fetch, versions }
}

let b: ReturnType<typeof backend>
let store: PageStore
const make = () => createPageStore({ fetch: b.fetch, isExpired: (e) => e instanceof Expired })
const offsets = () => b.fetch.mock.calls.map((c) => c[1])

beforeEach(() => {
  b = backend({ 1: 50_000, 2: 300 })
  store = make()
  store.reset({ queryId: 1, version: 1, total: 50_000 })
})

describe("createPageStore", () => {
  it("loads the pages covering the range plus one on each side", async () => {
    const n = store.pageSize
    store.setRange(n * 10 + 5, n * 11 + 5)
    await settle()
    expect(new Set(offsets())).toEqual(new Set([9, 10, 11, 12].map((p) => p * n)))
    expect(store.getItem(n * 10 + 5)?.id).toBe(1e6 + n * 10 + 6)
  })

  it("bounds requests in flight and cached pages", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const original = b.fetch.getMockImplementation()!
    b.fetch.mockImplementation(async (...args) => {
      await gate
      return original(...args)
    })
    store.setRange(0, store.pageSize * 6)
    expect(store.stats().inFlight).toBe(3)
    release()
    for (let p = 0; p < 150; p += 2) {
      store.setRange(p * store.pageSize, p * store.pageSize + 10)
      await settle()
    }
    expect(store.stats().cached).toBeLessThanOrEqual(store.maxPages)
  })

  it("refetches only wanted pages after an invalidation and ignores stale ones", async () => {
    store.setRange(0, 10)
    await settle()
    const before = offsets().length
    b.versions[1] = 2
    store.invalidate({ queryId: 1, version: 2, total: 50_000 })
    await settle()
    expect(new Set(offsets().slice(before))).toEqual(new Set([0, store.pageSize]))
    store.invalidate({ queryId: 1, version: 1, total: 3 })
    store.invalidate({ queryId: 9, version: 9, total: 3 })
    expect(store.stats().version).toBe(2)
  })

  it("reports an expired session", async () => {
    const expired = vi.fn()
    store.setExpiredHandler(expired)
    store.reset({ queryId: 7, version: 1, total: 10 })
    store.setRange(0, 5)
    await settle()
    expect(expired).toHaveBeenCalledTimes(1)
    // A failed page is not retried in a loop, only when the view asks again.
    expect(b.fetch).toHaveBeenCalledTimes(1)
    store.setRange(0, 5)
    await settle()
    expect(b.fetch).toHaveBeenCalledTimes(2)
  })

  it("ensureIndex loads a page outside the range", async () => {
    expect(store.getItem(40_000)).toBeUndefined()
    expect((await store.ensureIndex(40_000))?.id).toBe(1e6 + 40_001)
    expect(await store.ensureIndex(50_000)).toBeUndefined()
  })

  it("two stores keep independent sessions (one per commander panel)", async () => {
    const right = make()
    right.reset({ queryId: 2, version: 1, total: 300 })
    store.setRange(0, 10)
    right.setRange(0, 10)
    await settle()
    expect(store.getItem(0)?.id).toBe(1e6 + 1)
    expect(right.getItem(0)?.id).toBe(2e6 + 1)
    store.reset(null)
    expect(store.getTotal()).toBe(0)
    expect(right.getTotal()).toBe(300)
    expect(right.getItem(0)?.id).toBe(2e6 + 1)
  })

  it("usePageItem re-renders a row when its page arrives", async () => {
    const seen: (number | undefined)[] = []
    function Row() {
      seen.push(usePageItem(store, 3)?.id)
      return null
    }
    render(<Row />)
    await act(async () => {
      store.setRange(0, 10)
      await settle()
    })
    expect(seen[0]).toBeUndefined()
    expect(seen.at(-1)).toBe(1e6 + 4)
  })
})
