import type { ContentItem } from "@panelyth/contracts"
import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { GlyphSprite } from "@panelyth/ui"
import { glyphOf } from "./features/format"
import { item } from "./test/fakeApi"

// The type icons: which icon a row gets, and the sprite they share.

const glyph = (name: string, more: Partial<ContentItem> = {}) => glyphOf(item(1, name, more))

describe("type icons", () => {
  it("picks the icon by kind, then by extension", () => {
    expect(glyph("photo.jpg", { kind: "image" })).toBe("image")
    expect(glyph("clip.mp4", { kind: "video" })).toBe("video")
    // Not media for the index, but still pictures and videos to the user.
    for (const name of ["a.avi", "a.wmv", "a.mpg", "a.flv"]) expect(glyph(name)).toBe("video")
    for (const name of ["a.heic", "a.svg", "a.psd", "a.avif"]) expect(glyph(name)).toBe("image")
    expect(glyph("manual.pdf")).toBe("pdf")
    expect(glyph("song.mp3")).toBe("audio")
    expect(glyph("backup.zip")).toBe("archive")
    expect(glyph("notes.txt")).toBe("text")
    expect(glyph("setup.exe")).toBe("program")
    expect(glyph("data.bin")).toBe("other")
  })

  it("the sprite has one symbol per icon and no id used twice", () => {
    const { container } = render(<GlyphSprite />)
    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id)
    expect(new Set(ids).size).toBe(ids.length) // a gradient sharing a symbol's id blanks the icon
    for (const name of ["folder", "image", "video", "audio", "pdf", "other"])
      expect(container.querySelector(`symbol#glyph-${name}`)).not.toBeNull()
    const fills = container.innerHTML.match(/url\(#[\w-]+\)/g) ?? []
    for (const fill of fills) expect(ids).toContain(fill.slice(5, -1))
  })
})
