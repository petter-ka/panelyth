import type {
  FileOpenResult,
  FileResolveResult,
  MediaOpenResult,
  MediaResolveResult,
} from "@panelyth/contracts"
import { protocol } from "electron"
import { randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { Readable } from "node:stream"

export const MEDIA_SCHEME = "panelyth-media"

interface MediaTarget {
  path: string
  mime: string
  /**
   * The app origin allowed to fetch() it (Stage C05: the commander's lister
   * reads byte windows). Absent: element loads only (<img>, <video>).
   */
  fetchOrigin?: string
}

/**
 * Opaque tokens for originals (ADR-0009, ARCHITECTURE-ANALYSIS §8). The
 * renderer only ever holds panelyth-media://m/<token>; tokens map to paths
 * the sidecar validated, and the map is a bounded LRU.
 */
export class MediaTokens {
  private readonly map = new Map<string, MediaTarget>()

  constructor(private readonly capacity = 64) {}

  mint(target: MediaTarget): string {
    const token = randomBytes(16).toString("hex")
    this.map.set(token, target)
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value!)
    return token
  }

  get(token: string): MediaTarget | undefined {
    const target = this.map.get(token)
    if (target) {
      // Refresh LRU position: the open item stays valid while in use.
      this.map.delete(token)
      this.map.set(token, target)
    }
    return target
  }

  get size(): number {
    return this.map.size
  }
}

const URL_PATTERN = /^panelyth-media:\/\/m\/([0-9a-f]{32})$/

/** Extracts the token from a panelyth-media URL, or null for anything else. */
export function parseMediaUrl(url: string): string | null {
  return URL_PATTERN.exec(url)?.[1] ?? null
}

export interface ByteRange {
  start: number
  end: number // inclusive
}

/**
 * Parses a single "bytes=a-b" / "bytes=a-" / "bytes=-n" range. Returns null
 * for no range, "invalid" for unsatisfiable or multi-range requests.
 */
export function parseRange(header: string | null, size: number): ByteRange | null | "invalid" {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === "" && m[2] === "")) return "invalid"
  let start: number
  let end: number
  if (m[1] === "") {
    const suffix = Number(m[2])
    if (suffix === 0) return "invalid"
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return "invalid"
  return { start, end }
}

export function mintMediaUrl(tokens: MediaTokens, target: MediaTarget): string {
  return `${MEDIA_SCHEME}://m/${tokens.mint(target)}`
}

/**
 * media.open: what the renderer gets for a resolved entry. Never the path;
 * a token URL only when the original may be loaded (displayable images,
 * every video; Chromium decides whether it can play it).
 */
export function toMediaOpenResult(r: MediaResolveResult, tokens: MediaTokens): MediaOpenResult {
  return {
    url: r.original ? mintMediaUrl(tokens, { path: r.path, mime: r.mime }) : null,
    kind: r.kind,
    mime: r.mime,
    width: r.width,
    height: r.height,
    durationMs: r.durationMs,
    videoCodec: r.videoCodec,
    audioCodec: r.audioCodec,
  }
}

/**
 * file.open (commander, Stage C05): a read-only token for any file. Files
 * that are not media are served as application/octet-stream with nosniff,
 * so nothing a file contains is ever interpreted by the renderer.
 */
export function toFileOpenResult(
  r: FileResolveResult,
  tokens: MediaTokens,
  fetchOrigin: string,
): FileOpenResult {
  return {
    url: mintMediaUrl(tokens, { path: r.path, mime: r.mime, fetchOrigin }),
    kind: r.kind,
    mime: r.mime,
    sizeBytes: r.sizeBytes,
  }
}

/**
 * CORS for fetch() from the app view that minted the token. A request
 * carrying another Origin is refused; element loads carry none.
 */
export function corsHeaders(
  target: MediaTarget,
  origin: string | null,
): Record<string, string> | "denied" {
  if (origin === null) return {}
  if (!target.fetchOrigin || origin !== target.fetchOrigin) return "denied"
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
    Vary: "Origin",
  }
}

/**
 * Serves token URLs with Range support (video seeking needs 206 responses).
 * A token is looked up in each store: originals have one, the editor's
 * frames another (Stage 12), so a burst of frames never evicts an original.
 */
export function handleMediaProtocol(...stores: MediaTokens[]): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const token = parseMediaUrl(request.url)
    let target: MediaTarget | undefined
    for (const store of stores) {
      target = token ? store.get(token) : undefined
      if (target) break
    }
    if (!target) return new Response(null, { status: 404 })
    const cors = corsHeaders(target, request.headers.get("Origin"))
    if (cors === "denied") return new Response(null, { status: 403 })
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Allow-Methods": "GET",
          "Access-Control-Allow-Headers": "Range",
        },
      })
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405 })
    }
    let size: number
    try {
      size = (await stat(target.path)).size
    } catch {
      return new Response(null, { status: 404 })
    }
    const range = parseRange(request.headers.get("Range"), size)
    if (range === "invalid") {
      return new Response(null, {
        status: 416,
        headers: { ...cors, "Content-Range": `bytes */${size}` },
      })
    }
    const { start, end } = range ?? { start: 0, end: size - 1 }
    const body =
      size === 0 || request.method === "HEAD"
        ? null
        : (Readable.toWeb(createReadStream(target.path, { start, end })) as ReadableStream)
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        ...cors,
        "Content-Type": target.mime || "application/octet-stream",
        "Content-Length": String(size === 0 ? 0 : end - start + 1),
        "Accept-Ranges": "bytes",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  })
}
