import { describe, expect, it } from "vitest"
import { defaultIndent, detectIndent } from "./indent"

describe("detectIndent", () => {
  it("finds tabs", () => {
    expect(detectIndent("func main() {\n\tfmt.Println()\n\tif x {\n\t\treturn\n\t}\n}\n")).toEqual({
      unit: "\t",
      tabSize: 4,
    })
  })

  it("finds two spaces, also with deeper dedents", () => {
    const text = '{\n  "a": {\n    "b": {\n      "c": 1\n    }\n  },\n  "d": 2\n}\n'
    expect(detectIndent(text)).toEqual({ unit: "  ", tabSize: 2 })
  })

  it("finds four spaces", () => {
    const text = "def f():\n    if x:\n        return 1\n    return 2\n\nclass A:\n    pass\n"
    expect(detectIndent(text)).toEqual({ unit: "    ", tabSize: 4 })
  })

  it("ignores the one-space step of block comments and CRLF endings", () => {
    const text = "/**\r\n * Doc\r\n */\r\nfunction f() {\r\n  return 1\r\n}\r\n"
    expect(detectIndent(text)).toEqual({ unit: "  ", tabSize: 2 })
  })

  it("is null when nothing is indented", () => {
    expect(detectIndent("# Title\n\nSome text.\n")).toBeNull()
    expect(detectIndent("")).toBeNull()
  })
})

describe("defaultIndent", () => {
  it("follows the file type's convention", () => {
    expect(defaultIndent("main.go").unit).toBe("\t")
    expect(defaultIndent("Makefile").unit).toBe("\t")
    expect(defaultIndent("package.json").unit).toBe("  ")
    expect(defaultIndent("notes.txt").unit).toBe("    ")
  })
})
