import { describe, expect, it } from "vitest"
import { applyTheme, parseParams } from "./params"

const token = `panelyth-media://m/${"a".repeat(32)}`
const hash = (o: Record<string, string>) => "#" + new URLSearchParams(o).toString()

describe("parseParams", () => {
  it("accepts what main sends", () => {
    expect(
      parseParams(hash({ kind: "pdf", name: "a.pdf", size: "10", src: token, theme: "beige" })),
    ).toEqual({ kind: "pdf", name: "a.pdf", sizeBytes: 10, src: token, theme: "beige" })
    expect(parseParams(hash({ kind: "text", name: "a.md", size: "x", src: token }))).toMatchObject({
      kind: "text",
      sizeBytes: 0,
      theme: null,
    })
  })

  it("refuses anything but a media token, and a kind that does not match the name", () => {
    for (const src of [
      "https://example.com/a.pdf",
      "file:///etc/passwd",
      "panelyth-media://m/zz",
      "",
    ]) {
      expect(parseParams(hash({ kind: "pdf", name: "a.pdf", size: "1", src })), src).toBeNull()
    }
    expect(parseParams(hash({ kind: "pdf", name: "a.txt", size: "1", src: token }))).toBeNull()
    expect(parseParams(hash({ kind: "html", name: "a.html", size: "1", src: token }))).toBeNull()
    expect(parseParams("")).toBeNull()
  })
})

describe("applyTheme", () => {
  it("sets the shared tokens' class and name", () => {
    const root = document.createElement("html")
    applyTheme("dark-purple", root)
    expect(root.classList.contains("dark")).toBe(true)
    expect(root.dataset.theme).toBe("dark-purple")
    applyTheme("beige", root)
    expect(root.classList.contains("dark")).toBe(false)
    applyTheme("bad theme!", root)
    expect(root.dataset.theme).toBe("dark")
  })
})
