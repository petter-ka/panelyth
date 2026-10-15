import { afterEach, describe, expect, it } from "vitest"
import { beginOwnDrag, endOwnDrag, ownDrag } from "./ownDrag"

const files = { types: ["Files"] } as unknown as DataTransfer
const text = { types: ["text/plain"] } as unknown as DataTransfer

afterEach(() => endOwnDrag())

describe("own drag (ADR-0040)", () => {
  it("is what this view drags while files are over it, and nothing else", () => {
    expect(ownDrag(files)).toBeNull()
    beginOwnDrag("left")
    expect(ownDrag(files)).toBe("left")
    expect(ownDrag(text)).toBeNull()
    expect(ownDrag(null)).toBeNull()
  })

  it("ends when a pointer moves with no button held, presses again, or the window loses the focus", () => {
    beginOwnDrag("left")
    // Still held (the OS drag is starting): it stays.
    window.dispatchEvent(new MouseEvent("pointermove", { buttons: 1 }))
    expect(ownDrag(files)).toBe("left")
    window.dispatchEvent(new MouseEvent("pointermove", { buttons: 0 }))
    expect(ownDrag(files)).toBeNull()

    beginOwnDrag("right")
    window.dispatchEvent(new MouseEvent("pointerdown"))
    expect(ownDrag(files)).toBeNull()

    beginOwnDrag("right")
    window.dispatchEvent(new FocusEvent("blur"))
    expect(ownDrag(files)).toBeNull()
  })
})
