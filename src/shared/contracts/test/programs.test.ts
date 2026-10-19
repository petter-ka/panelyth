import { describe, expect, it } from "vitest"
import { MAX_PROGRAMS, newProgramId, programsFor, readPrograms } from "../src/programs"

describe("shared.programs (ADR-0044)", () => {
  it("reads valid programs and leaves out anything malformed", () => {
    const programs = readPrograms({
      v: 1,
      programs: [
        { id: "gimp", name: " GIMP ", path: "C:\\Program Files\\GIMP\\gimp.exe", target: "files" },
        { id: "code", name: "Code", path: "/usr/bin/code", target: "all" },
        { id: "unc", name: "Share", path: "\\\\server\\tools\\x.exe", target: "both" },
        { id: "gimp", name: "Again", path: "/usr/bin/gimp", target: "both" },
        { id: "rel", name: "Relative", path: "gimp.exe", target: "both" },
        { id: "ctl", name: "a\nb", path: "/usr/bin/x", target: "both" },
        { id: "BAD", name: "Bad id", path: "/usr/bin/x", target: "both" },
        { id: "empty", name: "  ", path: "/usr/bin/x", target: "both" },
        null,
      ],
    })
    expect(programs).toEqual([
      { id: "gimp", name: "GIMP", path: "C:\\Program Files\\GIMP\\gimp.exe", target: "files" },
      // An unknown target is offered for both.
      { id: "code", name: "Code", path: "/usr/bin/code", target: "both" },
      { id: "unc", name: "Share", path: "\\\\server\\tools\\x.exe", target: "both" },
    ])
    expect(readPrograms(undefined)).toEqual([])
    expect(readPrograms({ v: 2, programs: [] })).toEqual([])
  })

  it("keeps at most 20", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      path: `/usr/bin/p${i}`,
      target: "both",
    }))
    expect(readPrograms({ v: 1, programs: many })).toHaveLength(MAX_PROGRAMS)
  })

  it("offers a program for files, folders or both", () => {
    const programs = readPrograms({
      v: 1,
      programs: [
        { id: "f", name: "F", path: "/f", target: "files" },
        { id: "d", name: "D", path: "/d", target: "folders" },
        { id: "b", name: "B", path: "/b", target: "both" },
      ],
    })
    expect(programsFor(programs, false).map((p) => p.id)).toEqual(["f", "b"])
    expect(programsFor(programs, true).map((p) => p.id)).toEqual(["d", "b"])
  })

  it("makes ids no program has", () => {
    const id = newProgramId(["abc"])
    expect(id).toMatch(/^[a-z0-9]{1,16}$/)
    expect(id).not.toBe("abc")
  })
})
