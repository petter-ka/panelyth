import { describe, expect, it, vi } from "vitest"
import { startAppFrom } from "../src/main/shell"

vi.mock("electron", () => ({ WebContentsView: class {} }))

describe("the app shown at start (ADR-0031)", () => {
  it("follows Start with, else the last used app", () => {
    const last = { "shared.context": { v: 1, app: "commander", path: "/x", pathKey: "/x" } }
    expect(startAppFrom({})).toBe("viewer")
    expect(startAppFrom(last)).toBe("commander")
    expect(
      startAppFrom({ ...last, "shared.switch": { v: 1, carry: {}, startWith: "viewer" } }),
    ).toBe("viewer")
    expect(startAppFrom({ "shared.switch": { v: 1, carry: {}, startWith: "commander" } })).toBe(
      "commander",
    )
    expect(startAppFrom({ ...last, "shared.switch": { v: 2, startWith: "viewer" } })).toBe(
      "commander",
    )
  })
})
