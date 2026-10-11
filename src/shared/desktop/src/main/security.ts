import type { Session, WebContents, WebFrameMain } from "electron"

export const APP_SCHEME = "app"
export const APP_HOST = "panelyth"
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
/** The commander's app view is served from its own origin (ADR-0031). */
export const COMMANDER_HOST = "commander"
export const COMMANDER_ORIGIN = `${APP_SCHEME}://${COMMANDER_HOST}`

// Previews load from panelyth-thumb: (Stage 02); originals and videos from
// panelyth-media: (Stages 04 and 06). Only the commander may also fetch()
// token URLs: its lister reads byte windows (Stage C05, ADR-0027). The
// viewer keeps connect-src 'self', so it can never read a token's bytes.
/** The document window is served from its own origin (ADR-0033). */
export const DOCUMENTS_HOST = "documents"
export const DOCUMENTS_ORIGIN = `${APP_SCHEME}://${DOCUMENTS_HOST}`

const connectTokens = (fetchTokens: boolean): string => (fetchTokens ? " panelyth-media:" : "")

const prodCsp = (fetchTokens: boolean): string =>
  [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: panelyth-thumb: panelyth-media:",
    "font-src 'self'",
    `connect-src 'self'${connectTokens(fetchTokens)}`,
    "media-src panelyth-media:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ")

// Vite's dev servers need inline preamble scripts and a websocket each for HMR.
const devCsp = (origins: readonly string[], fetchTokens: boolean): string =>
  [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: panelyth-thumb: panelyth-media:",
    "media-src panelyth-media:",
    `connect-src 'self'${connectTokens(fetchTokens)} ${origins.map((o) => o.replace(/^http/, "ws")).join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ")

/**
 * The document window (ADR-0033): fetches its one token URL, runs the PDF
 * worker from its own files (and the blob: pdf.js makes from them), and
 * draws pages to canvases. No object/embed, no frames, no network.
 */
export function documentsCsp(devOrigins: string | readonly string[] | null = null): string {
  const list = devOrigins === null ? [] : typeof devOrigins === "string" ? [devOrigins] : devOrigins
  const dev = list.length > 0
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${dev ? " 'unsafe-inline'" : ""}`,
    `style-src 'self'${dev ? " 'unsafe-inline'" : ""}`,
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    `connect-src 'self' panelyth-media: blob: data:${dev ? " " + list.map((o) => o.replace(/^http/, "ws")).join(" ") : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ")
}

/** fetchTokens: the page may fetch() panelyth-media: URLs (the commander's view only). */
export function contentSecurityPolicy(
  devOrigins: string | readonly string[] | null,
  fetchTokens = false,
): string {
  if (devOrigins === null) return prodCsp(fetchTokens)
  const list = typeof devOrigins === "string" ? [devOrigins] : devOrigins
  return list.length > 0 ? devCsp(list, fetchTokens) : prodCsp(fetchTokens)
}

/**
 * scheme://host[:port] of a URL. Unlike URL.origin this also works for our
 * custom app: scheme, whose WHATWG origin is the opaque string "null".
 */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.host ? `${u.protocol}//${u.host}` : null
  } catch {
    return null
  }
}

export function trustedOrigin(devUrl: string | null): string {
  return (devUrl && originOf(devUrl)) || APP_ORIGIN
}

/** IPC is accepted only from the main frame of our own renderer origin. */
export function isTrustedSender(frame: WebFrameMain | null, origin: string): boolean {
  if (!frame || frame.parent !== null) return false
  return originOf(frame.url) === origin
}

/**
 * Every permission is denied except element fullscreen for our own page
 * (the video player's fullscreen button, Stage 06).
 */
export function allowPermission(
  permission: string,
  requestingUrl: string,
  origins: string | readonly string[],
): boolean {
  const allowed = typeof origins === "string" ? [origins] : origins
  const origin = originOf(requestingUrl)
  return permission === "fullscreen" && origin !== null && allowed.includes(origin)
}

/**
 * devUrls: the dev-server URLs of the app views (unpackaged dev runs only);
 * tokenFetchOrigins: the app origins whose pages may fetch() token URLs.
 */
export function hardenSession(
  session: Session,
  origins: readonly string[],
  devUrls: readonly string[],
  tokenFetchOrigins: readonly string[] = [],
  documentsDevOrigin: string | null = null,
): void {
  session.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(allowPermission(permission, details.requestingUrl, origins)),
  )
  session.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    allowPermission(permission, requestingOrigin, origins),
  )
  const [devUrl] = devUrls
  if (devUrl) {
    // Production responses carry the CSP from the app:// protocol handler.
    const devOrigins = devUrls.map((url) => new URL(url).origin)
    session.webRequest.onHeadersReceived((details, callback) => {
      const origin = originOf(details.url)
      const csp =
        origin !== null && origin === documentsDevOrigin
          ? documentsCsp(devOrigins)
          : contentSecurityPolicy(devOrigins, origin !== null && tokenFetchOrigins.includes(origin))
      callback({
        responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] },
      })
    })
  }
}

export function hardenWebContents(contents: WebContents, origin: string): void {
  contents.on("will-navigate", (event, url) => {
    if (originOf(url) !== origin) event.preventDefault()
  })
  contents.on("will-attach-webview", (event) => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: "deny" }))
}
