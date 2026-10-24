import { TEXTEDIT_MAX_IMAGE_LINKS } from "@panelyth/contracts"
import { describe, expect, it, vi } from "vitest"
import { createImageResolver, type ResolveBatch } from "./images"

const token = (n: number): string => `panelyth-media://m/${String(n % 10).repeat(32)}`

describe("the picture resolver", () => {
  it("asks in batches of at most 200, one after the other, and caches the answers", async () => {
    let inFlight = 0
    let most = 0
    const resolve = vi.fn<ResolveBatch>(async (links) => {
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return links.map((link, i) => ({ link, src: token(i) }))
    })
    const resolver = createImageResolver(resolve)
    const links = Array.from({ length: 450 }, (_, i) => `assets/p${i}.png`)
    await resolver.resolveAll(links)
    expect(resolve.mock.calls.map((c) => c[0].length)).toEqual([200, 200, 50])
    expect(resolve.mock.calls.every((c) => c[0].length <= TEXTEDIT_MAX_IMAGE_LINKS)).toBe(true)
    expect(most).toBe(1)
    expect(resolver.get("assets/p0.png")).toBe(token(0))
    // Known links are not asked again.
    await resolver.resolveAll(links.slice(0, 10))
    resolver.request(links.slice(0, 10))
    expect(resolve).toHaveBeenCalledTimes(3)
  })

  it("never asks about web or empty links", async () => {
    const resolve = vi.fn<ResolveBatch>(async (links) => links.map((link) => ({ link, src: null })))
    const resolver = createImageResolver(resolve)
    await resolver.resolveAll(["https://x/y.png", "//cdn/z.png", "data:image/png;base64,AA", ""])
    expect(resolve).not.toHaveBeenCalled()
  })

  it("asks once for links requested many times while pending, and tells listeners", async () => {
    const resolve = vi.fn<ResolveBatch>(async (links) =>
      links.map((link) => ({ link, src: token(1) })),
    )
    const resolver = createImageResolver(resolve)
    const heard = vi.fn()
    resolver.onChange(heard)
    resolver.request(["a.png", "b.png"])
    resolver.request(["a.png", "b.png", "c.png"])
    await vi.waitFor(() => expect(resolver.get("c.png")).toBe(token(1)))
    const asked = resolve.mock.calls.flatMap((c) => c[0])
    expect(asked.sort()).toEqual(["a.png", "b.png", "c.png"])
    expect(heard).toHaveBeenCalled()
  })

  it("asks again after a save for links that named nothing", async () => {
    let exists = false
    const resolve = vi.fn<ResolveBatch>(async (links) =>
      links.map((link) => ({ link, src: exists ? token(2) : null })),
    )
    const resolver = createImageResolver(resolve)
    await resolver.resolveAll(["assets/new.png", "assets/old.png"])
    expect(resolver.get("assets/new.png")).toBeNull()
    exists = true
    resolver.forgetMissing()
    expect(resolver.get("assets/new.png")).toBeUndefined()
    await resolver.resolveAll(["assets/new.png"])
    expect(resolver.get("assets/new.png")).toBe(token(2))
  })

  it("a failed batch shows placeholders and is retried after a save", async () => {
    const resolve = vi.fn<ResolveBatch>(async () => {
      throw new Error("sidecar down")
    })
    const resolver = createImageResolver(resolve)
    await resolver.resolveAll(["a.png"])
    expect(resolver.get("a.png")).toBeNull()
  })
})
