import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ net: {}, protocol: {} }))

const { resolveThumb } = await import("../src/main/thumbProtocol")

const root = join("/cache", "Panelyth", "v1", "thumbnails")
const key = "ab" + "cd" + "0".repeat(60)

describe("panelyth-thumb URL resolution", () => {
  it("maps a key to its sharded cache file", () => {
    expect(resolveThumb(root, `panelyth-thumb://t/${key}.jpg`)).toEqual({
      path: join(root, "ab", "cd", `${key}.jpg`),
      mime: "image/jpeg",
    })
    expect(resolveThumb(root, `panelyth-thumb://t/${key}.png`)?.mime).toBe("image/png")
  })

  it.each([
    ["wrong host", `panelyth-thumb://x/${key}.jpg`],
    ["short key", `panelyth-thumb://t/${key.slice(1)}.jpg`],
    ["uppercase hex", `panelyth-thumb://t/${key.toUpperCase()}.jpg`],
    ["other extension", `panelyth-thumb://t/${key}.gif`],
    ["traversal", `panelyth-thumb://t/../../etc/passwd`],
    ["encoded traversal", `panelyth-thumb://t/%2e%2e%2f${key}.jpg`],
    ["nested path", `panelyth-thumb://t/ab/cd/${key}.jpg`],
    ["query string", `panelyth-thumb://t/${key}.jpg?x=1`],
    ["other scheme", `file:///t/${key}.jpg`],
    ["garbage", "not a url"],
  ])("rejects %s", (_name, url) => {
    expect(resolveThumb(root, url)).toBeNull()
  })
})
