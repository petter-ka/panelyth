import { describe, expect, it } from "vitest"
import { readAssetsFolder } from "./features/settings"

// Stage C10.7: the folder beside a document for its pictures. One plain
// name; anything else falls back to "" (main then uses "assets").

describe("the pictures folder setting", () => {
  it("keeps one plain folder name", () => {
    for (const name of ["assets", "images", "my pictures", "_media", "img-2026"]) {
      expect(readAssetsFolder(name)).toBe(name)
    }
    expect(readAssetsFolder("  media  ")).toBe("media")
  })

  it("refuses a path, a reserved character, a dot name or a trailing dot or space", () => {
    for (const name of [
      "a/b",
      "a\\b",
      "..",
      ".",
      "c:",
      "x*y",
      "pic?",
      "a<b",
      "name.",
      "\u0007bell",
    ]) {
      expect(readAssetsFolder(name), JSON.stringify(name)).toBe("")
    }
    expect(readAssetsFolder("x".repeat(65))).toBe("")
    expect(readAssetsFolder(42)).toBe("")
    expect(readAssetsFolder(undefined)).toBe("")
  })
})
