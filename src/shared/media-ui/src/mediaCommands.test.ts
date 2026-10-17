import { describe, expect, it } from "vitest"
import { mediaCommandOf } from "./mediaCommands"

const key = (
  key: string,
  mods: Partial<Record<"ctrl" | "meta" | "alt" | "shift", boolean>> = {},
  code = "",
) => ({
  key,
  code,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
})

describe("mediaCommandOf", () => {
  it("maps the clipboard keys with Ctrl or Cmd", () => {
    expect(mediaCommandOf(key("c", { ctrl: true }))).toBe("copy")
    expect(mediaCommandOf(key("x", { meta: true }))).toBe("cut")
    expect(mediaCommandOf(key("V", { ctrl: true }))).toBe("paste")
    // Another layout: the key's position counts.
    expect(mediaCommandOf(key("с", { ctrl: true }, "KeyC"))).toBe("copy")
  })

  it("maps Delete to the trash and Shift+Delete to a permanent delete", () => {
    expect(mediaCommandOf(key("Delete"))).toBe("trash")
    expect(mediaCommandOf(key("Delete", { shift: true }))).toBe("delete")
    expect(mediaCommandOf(key("Backspace", { meta: true }))).toBe("trash")
    expect(mediaCommandOf(key("Backspace", { meta: true, alt: true }))).toBe("delete")
  })

  it("leaves every other key alone", () => {
    expect(mediaCommandOf(key("c"))).toBeNull()
    expect(mediaCommandOf(key("c", { ctrl: true, shift: true }))).toBeNull()
    expect(mediaCommandOf(key("v", { ctrl: true, alt: true }))).toBeNull()
    expect(mediaCommandOf(key("Backspace"))).toBeNull()
    expect(mediaCommandOf(key("Delete", { ctrl: true }))).toBeNull()
    expect(mediaCommandOf(key("ArrowLeft"))).toBeNull()
  })
})
