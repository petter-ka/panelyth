import { join, resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ net: {}, protocol: {} }))

const { resolveInside } = await import("../src/main/appProtocol")

describe("resolveInside", () => {
  const root = resolve("/srv/dist")

  it("maps / to index.html", () => {
    expect(resolveInside(root, "/")).toBe(join(root, "index.html"))
  })

  it("resolves nested assets", () => {
    expect(resolveInside(root, "/assets/app-1.js")).toBe(join(root, "assets", "app-1.js"))
  })

  it.each([
    "/../secret",
    "/assets/../../secret",
    "/%2e%2e/secret",
    "/..%5csecret",
    "/a%00b",
    "/%E0%A4%A",
  ])("rejects %s", (p) => {
    expect(resolveInside(root, p)).toBeNull()
  })
})
