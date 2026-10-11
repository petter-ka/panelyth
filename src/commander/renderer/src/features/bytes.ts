import { t } from "@panelyth/i18n"
// Byte windows of one file for the lister and quick view (Stage C05,
// ADR-0027): the bytes come through the file's panelyth-media token URL with
// HTTP Range, never over IPC. Reads are served from fixed-size chunks in a
// small LRU, so a multi-GB file opens instantly and memory stays bounded
// however far the view scrolls.

export const CHUNK_BYTES = 64 * 1024
/** 4 MiB of cached chunks per open file. */
export const MAX_CHUNKS = 64

/** Reads bytes [start, end] (inclusive) of a token URL. */
export type RangeFetch = (url: string, start: number, end: number) => Promise<Uint8Array>

const httpFetch: RangeFetch = async (url, start, end) => {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
  if (!res.ok)
    throw new Error(
      res.status === 404 ? t("The file can no longer be read.") : `HTTP ${res.status}`,
    )
  return new Uint8Array(await res.arrayBuffer())
}

let rangeFetch: RangeFetch = httpFetch

/** Tests: serve token URLs from memory. */
export function setRangeFetch(fn: RangeFetch | null): void {
  rangeFetch = fn ?? httpFetch
}

export interface ByteSourceStats {
  chunks: number
  fetches: number
}

export class ByteSource {
  private readonly chunks = new Map<number, Uint8Array>()
  private readonly inFlight = new Map<number, Promise<Uint8Array>>()
  private fetches = 0

  constructor(
    readonly url: string,
    readonly size: number,
  ) {}

  /** Bytes [start, end) clipped to the file; assembled from cached chunks. */
  async read(start: number, end: number): Promise<Uint8Array> {
    const from = Math.max(0, Math.min(start, this.size))
    const to = Math.max(from, Math.min(end, this.size))
    if (to === from) return new Uint8Array(0)
    const first = Math.floor(from / CHUNK_BYTES)
    const last = Math.floor((to - 1) / CHUNK_BYTES)
    // A read never needs more chunks than the cache keeps.
    if (last - first + 1 > MAX_CHUNKS) return this.readDirect(from, to)
    const parts = await Promise.all(
      Array.from({ length: last - first + 1 }, (_, i) => this.chunk(first + i)),
    )
    if (parts.length === 1) {
      const base = first * CHUNK_BYTES
      return parts[0]!.subarray(from - base, to - base)
    }
    const out = new Uint8Array(to - from)
    let pos = 0
    parts.forEach((part, i) => {
      const base = (first + i) * CHUNK_BYTES
      const a = Math.max(from, base) - base
      const b = Math.min(to, base + part.length) - base
      out.set(part.subarray(a, b), pos)
      pos += b - a
    })
    return out
  }

  /** Uncached bytes [start, end) (find reads the file once and keeps nothing). */
  async readDirect(start: number, end: number): Promise<Uint8Array> {
    const to = Math.min(end, this.size)
    if (to <= start) return new Uint8Array(0)
    this.fetches++
    return rangeFetch(this.url, start, to - 1)
  }

  stats(): ByteSourceStats {
    return { chunks: this.chunks.size, fetches: this.fetches }
  }

  private chunk(index: number): Promise<Uint8Array> {
    const cached = this.chunks.get(index)
    if (cached) {
      this.chunks.delete(index) // LRU order
      this.chunks.set(index, cached)
      return Promise.resolve(cached)
    }
    const pending = this.inFlight.get(index)
    if (pending) return pending
    const start = index * CHUNK_BYTES
    const end = Math.min(this.size, start + CHUNK_BYTES) - 1
    this.fetches++
    const p = rangeFetch(this.url, start, end)
      .then((bytes) => {
        this.chunks.set(index, bytes)
        while (this.chunks.size > MAX_CHUNKS) this.chunks.delete(this.chunks.keys().next().value!)
        return bytes
      })
      .finally(() => this.inFlight.delete(index))
    this.inFlight.set(index, p)
    return p
  }
}
