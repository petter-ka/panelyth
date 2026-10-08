import { net, protocol } from "electron"
import { extname, join, normalize, relative, isAbsolute } from "node:path"
import { pathToFileURL } from "node:url"
import { APP_SCHEME, COMMANDER_HOST, contentSecurityPolicy } from "./security"
import { MEDIA_SCHEME } from "./mediaProtocol"
import { THUMB_SCHEME } from "./thumbProtocol"

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
}

/** Must run before app `ready`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    // Preview images: standard + secure so <img> treats them like https.
    { scheme: THUMB_SCHEME, privileges: { standard: true, secure: true } },
    // Originals (and videos in Stage 06): streamed, range-capable.
    {
      scheme: MEDIA_SCHEME,
      // corsEnabled: the commander's lister fetch()es byte windows (Stage C05).
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ])
}

/** Resolves a request pathname inside root, or null if it escapes root. */
export function resolveInside(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  // URLs never legitimately carry NUL or backslashes; reject both on every OS.
  if (decoded.includes("\0") || decoded.includes("\\")) return null
  const target = normalize(join(root, decoded === "/" ? "index.html" : decoded))
  const rel = relative(root, target)
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null
  return target
}

/**
 * Serves each app's built renderer from its own host: app://panelyth/ for the
 * viewer, app://commander/ for the commander (ADR-0031). distDirs maps host → dir.
 */
export function handleAppProtocol(distDirs: Readonly<Record<string, string>>): void {
  const csp = contentSecurityPolicy(null)
  // The commander's lister fetch()es token URLs; the viewer never may (ADR-0027).
  const commanderCsp = contentSecurityPolicy(null, true)
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    const root = Object.hasOwn(distDirs, url.host) ? distDirs[url.host] : undefined
    const file = root ? resolveInside(root, url.pathname) : null
    if (!file) return new Response("Not found", { status: 404 })
    const upstream = await net.fetch(pathToFileURL(file).toString()).catch(() => null)
    if (!upstream?.ok) return new Response("Not found", { status: 404 })
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
        "Content-Security-Policy": url.host === COMMANDER_HOST ? commanderCsp : csp,
        "X-Content-Type-Options": "nosniff",
      },
    })
  })
}
