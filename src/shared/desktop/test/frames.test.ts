import { describe, expect, it } from "vitest"
import { encodeFrame, FrameDecoder, FrameError } from "../src/main/sidecar/frames"

const decodeAll = (decoder: FrameDecoder, chunks: Buffer[]): unknown[] =>
  chunks.flatMap((c) => decoder.push(c)).map((p) => JSON.parse(p.toString("utf8")))

describe("frame codec", () => {
  const messages = [
    { t: "req", id: 1, m: "system.ping", p: {} },
    { t: "res", id: 1, ok: true, r: { text: "ünïcødé ✓ 🖼" } },
    { big: "x".repeat(200_000) },
  ]
  const stream = Buffer.concat(messages.map((m) => encodeFrame(m)))

  it("decodes frames merged into one chunk", () => {
    expect(decodeAll(new FrameDecoder(), [stream])).toEqual(messages)
  })

  it("decodes frames split at every byte boundary", () => {
    const chunks = [...stream].map((b) => Buffer.from([b]))
    expect(decodeAll(new FrameDecoder(), chunks)).toEqual(messages)
  })

  it("decodes frames split at random boundaries", () => {
    let seed = 42
    const rand = (): number => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    for (let run = 0; run < 50; run++) {
      const chunks: Buffer[] = []
      for (let i = 0; i < stream.length;) {
        const n = 1 + Math.floor(rand() * 70_000)
        chunks.push(stream.subarray(i, i + n))
        i += n
      }
      expect(decodeAll(new FrameDecoder(), chunks)).toEqual(messages)
    }
  })

  it("rejects oversize incoming frames", () => {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(1025, 0)
    expect(() => new FrameDecoder(1024).push(header)).toThrow(FrameError)
  })

  it("rejects oversize outgoing frames", () => {
    expect(() => encodeFrame({ s: "x".repeat(2000) }, 1024)).toThrow(FrameError)
  })

  it("uses byte length, not string length, for the header", () => {
    const frame = encodeFrame({ s: "ü" })
    expect(frame.readUInt32BE(0)).toBe(Buffer.byteLength(JSON.stringify({ s: "ü" })))
  })
})
