import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ net: {}, protocol: {} }))

const { resolveThumb } = await import("../src/main/thumbProtocol")

const root = join("/cache", "FastView", "v1", "thumbnails")
const key = "ab" + "cd" + "0".repeat(60)

describe("fastview-thumb URL resolution", () => {
  it("maps a key to its sharded cache file", () => {
    expect(resolveThumb(root, `fastview-thumb://t/${key}.jpg`)).toEqual({
      path: join(root, "ab", "cd", `${key}.jpg`),
      mime: "image/jpeg",
    })
    expect(resolveThumb(root, `fastview-thumb://t/${key}.png`)?.mime).toBe("image/png")
  })

  it.each([
    ["wrong host", `fastview-thumb://x/${key}.jpg`],
    ["short key", `fastview-thumb://t/${key.slice(1)}.jpg`],
    ["uppercase hex", `fastview-thumb://t/${key.toUpperCase()}.jpg`],
    ["other extension", `fastview-thumb://t/${key}.gif`],
    ["traversal", `fastview-thumb://t/../../etc/passwd`],
    ["encoded traversal", `fastview-thumb://t/%2e%2e%2f${key}.jpg`],
    ["nested path", `fastview-thumb://t/ab/cd/${key}.jpg`],
    ["query string", `fastview-thumb://t/${key}.jpg?x=1`],
    ["other scheme", `file:///t/${key}.jpg`],
    ["garbage", "not a url"],
  ])("rejects %s", (_name, url) => {
    expect(resolveThumb(root, url)).toBeNull()
  })
})
