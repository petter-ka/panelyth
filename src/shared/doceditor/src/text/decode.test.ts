import { describe, expect, it } from "vitest"
import { decodeBytes, encodingLabel, lineEndingLabel, skipBom } from "./decode"

describe("decodeBytes", () => {
  it("skips a UTF-8 byte order mark", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0xc3, 0xa9])
    expect(decodeBytes(bytes, "utf-8", 3)).toBe("hé")
  })

  it("decodes UTF-16 LE and BE after their marks", () => {
    expect(decodeBytes(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x14, 0x20]), "utf-16le", 2)).toBe(
      "A—",
    )
    expect(decodeBytes(new Uint8Array([0xfe, 0xff, 0x00, 0x41]), "utf-16be", 2)).toBe("A")
  })

  it("decodes a legacy code page", () => {
    // windows-1250 (Node's own windows-1252 decoder is Latin-1, unlike Chromium's).
    expect(decodeBytes(new Uint8Array([0x8a, 0xe8]), "windows-1250", 0)).toBe("Šč")
  })

  it("keeps the first bytes when they are no mark of that length", () => {
    const bytes = new Uint8Array([0x61, 0x62, 0x63])
    expect(skipBom(bytes, 3)).toBe(bytes)
    expect(decodeBytes(bytes, "utf-8", 3)).toBe("abc")
  })

  it("turns malformed bytes into replacement characters", () => {
    expect(decodeBytes(new Uint8Array([0x61, 0xff, 0x62]), "utf-8", 0)).toBe("a�b")
  })
})

describe("labels", () => {
  it("names encodings and line endings", () => {
    expect(encodingLabel("utf-8", 0)).toBe("UTF-8")
    expect(encodingLabel("utf-8", 3)).toBe("UTF-8 BOM")
    expect(encodingLabel("utf-16le", 2)).toBe("UTF-16 LE")
    expect(encodingLabel("windows-1250", 0)).toBe("Windows-1250")
    expect(lineEndingLabel("crlf")).toBe("CRLF")
    expect(lineEndingLabel("cr")).toBe("CR")
  })
})
