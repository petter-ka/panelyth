import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ BrowserWindow: class {} }))

const { mediaWindowUrl } = await import("../src/main/mediaWindow")

describe("mediaWindowUrl", () => {
  it("carries the kind, the name and the token, never a path", () => {
    const url = mediaWindowUrl("app://documents/index.html", {
      kind: "video",
      name: "clip.mp4",
      mime: "video/mp4",
      tokenUrl: "panelyth-media://m/" + "a".repeat(32),
      lang: "de",
    })
    const params = new URLSearchParams(url.split("#")[1])
    expect(params.get("kind")).toBe("video")
    expect(params.get("name")).toBe("clip.mp4")
    expect(params.get("src")).toBe("panelyth-media://m/" + "a".repeat(32))
    expect(params.get("lang")).toBe("de")
    expect(url).not.toContain("/home")
  })
})
