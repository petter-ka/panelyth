import { documentKindOf } from "@panelyth/contracts"
import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  BrowserWindow: class {},
  app: { isPackaged: false, getAppPath: () => "" },
}))

const { documentUrl } = await import("../src/main/documentWindow")
const { documentsCsp } = await import("../src/main/security")

describe("documentKindOf", () => {
  it("knows pdfs and text by extension or conventional name, ignoring case and folders", () => {
    expect(documentKindOf("C:\\docs\\Report.PDF")).toBe("pdf")
    expect(documentKindOf("/home/a/notes.md")).toBe("text")
    expect(documentKindOf("main.go")).toBe("text")
    expect(documentKindOf("/src/Makefile")).toBe("text")
    expect(documentKindOf("README")).toBe("text")
    expect(documentKindOf(".gitignore")).toBe("text")
  })

  it("leaves everything else to the lister", () => {
    for (const name of ["photo.jpg", "movie.mkv", "archive.zip", "app.exe", "noext", "a.bin", ""]) {
      expect(documentKindOf(name), name).toBeNull()
    }
  })
})

describe("documentUrl", () => {
  it("carries the token URL, the name and the size in the fragment, never a path", () => {
    const url = documentUrl("app://documents/index.html", "pdf", {
      tokenUrl: "panelyth-media://m/" + "a".repeat(32),
      name: "a b.pdf",
      sizeBytes: 12,
      theme: "dark",
    })
    const [base, fragment] = url.split("#")
    expect(base).toBe("app://documents/index.html")
    const params = new URLSearchParams(fragment)
    expect(params.get("kind")).toBe("pdf")
    expect(params.get("name")).toBe("a b.pdf")
    expect(params.get("size")).toBe("12")
    expect(params.get("theme")).toBe("dark")
    expect(params.get("src")).toMatch(/^panelyth-media:\/\/m\/[0-9a-f]{32}$/)
  })
})

describe("documentsCsp", () => {
  it("fetches tokens and runs workers from itself, and allows no objects or frames", () => {
    const csp = documentsCsp()
    expect(csp).toContain("connect-src 'self' panelyth-media:")
    expect(csp).toContain("worker-src 'self' blob:")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain("unsafe-inline")
  })
})
