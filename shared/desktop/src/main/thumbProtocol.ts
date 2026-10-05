import { net, protocol } from "electron"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

export const THUMB_SCHEME = "fastview-thumb"

const NAME = /^\/([0-9a-f]{64})\.(jpg|png)$/
const MIME = { jpg: "image/jpeg", png: "image/png" } as const

/**
 * Maps fastview-thumb://t/<64-hex key>.<jpg|png> to its cache file. Only the
 * exact key format is accepted, so no renderer input can name another path
 * (CACHE-DESIGN.md "Security"). Returns null for anything else.
 */
export function resolveThumb(
  root: string,
  url: string,
): { path: string; mime: (typeof MIME)[keyof typeof MIME] } | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== `${THUMB_SCHEME}:` || u.host !== "t" || u.search || u.hash) return null
  const m = NAME.exec(u.pathname)
  if (!m) return null
  const [, key, ext] = m as unknown as [string, string, "jpg" | "png"]
  return { path: join(root, key.slice(0, 2), key.slice(2, 4), `${key}.${ext}`), mime: MIME[ext] }
}

/**
 * Serves preview files from the sidecar's thumbnail root. Content is
 * addressed by key, so responses never change: cache them forever. Reads
 * are asynchronous (net.fetch on a file URL), never blocking main.
 */
export function handleThumbProtocol(getRoot: () => string | null): void {
  protocol.handle(THUMB_SCHEME, async (request) => {
    const root = getRoot()
    const target = root ? resolveThumb(root, request.url) : null
    if (!target) return new Response(null, { status: 404 })
    const file = await net.fetch(pathToFileURL(target.path).toString()).catch(() => null)
    if (!file?.ok) return new Response(null, { status: 404 })
    return new Response(file.body, {
      headers: {
        "Content-Type": target.mime,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    })
  })
}
