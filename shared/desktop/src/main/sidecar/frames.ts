import { MAX_FRAME_BYTES } from "@panelyth/contracts"

const HEADER_BYTES = 4

export class FrameError extends Error {
  override name = "FrameError"
}

export function encodeFrame(message: unknown, maxBytes = MAX_FRAME_BYTES): Buffer {
  const json = JSON.stringify(message)
  const length = Buffer.byteLength(json)
  if (length > maxBytes) throw new FrameError(`frame of ${length} bytes exceeds ${maxBytes}`)
  const frame = Buffer.allocUnsafe(HEADER_BYTES + length)
  frame.writeUInt32BE(length, 0)
  frame.write(json, HEADER_BYTES, "utf8")
  return frame
}

/**
 * Incremental decoder for length-prefixed frames arriving in arbitrary
 * chunks. Chunks are collected and concatenated once per frame, so large
 * frames split across many reads cost O(n), not O(n²).
 */
export class FrameDecoder {
  private chunks: Buffer[] = []
  private buffered = 0
  private need = -1

  constructor(private readonly maxBytes = MAX_FRAME_BYTES) {}

  /** Returns the payloads completed by this chunk. Throws FrameError on oversize. */
  push(chunk: Buffer): Buffer[] {
    this.chunks.push(chunk)
    this.buffered += chunk.length
    const out: Buffer[] = []
    for (;;) {
      if (this.need < 0) {
        if (this.buffered < HEADER_BYTES) break
        const need = this.take(HEADER_BYTES).readUInt32BE(0)
        if (need > this.maxBytes) {
          this.reset()
          throw new FrameError(`incoming frame of ${need} bytes exceeds ${this.maxBytes}`)
        }
        this.need = need
      }
      if (this.buffered < this.need) break
      out.push(this.take(this.need))
      this.need = -1
    }
    return out
  }

  reset(): void {
    this.chunks = []
    this.buffered = 0
    this.need = -1
  }

  private take(n: number): Buffer {
    const all =
      this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.buffered)
    const head = all.subarray(0, n)
    const rest = all.subarray(n)
    this.chunks = rest.length > 0 ? [rest] : []
    this.buffered = rest.length
    return head
  }
}
