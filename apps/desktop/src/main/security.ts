import type { Session, WebContents, WebFrameMain } from "electron"

export const APP_SCHEME = "app"
export const APP_HOST = "fastview"
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`

// Previews load from fastview-thumb: (Stage 02); originals and videos from
// fastview-media: (Stages 04 and 06).
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: fastview-thumb: fastview-media:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src fastview-media:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ")

// Vite's dev server needs inline preamble scripts and a websocket for HMR.
const devCsp = (origin: string): string =>
  [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: fastview-thumb: fastview-media:",
    "media-src fastview-media:",
    `connect-src 'self' ${origin.replace(/^http/, "ws")}`,
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ")

export function contentSecurityPolicy(devOrigin: string | null): string {
  return devOrigin ? devCsp(devOrigin) : PROD_CSP
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
  origin: string,
): boolean {
  return permission === "fullscreen" && originOf(requestingUrl) === origin
}

export function hardenSession(session: Session, devUrl: string | null): void {
  const origin = trustedOrigin(devUrl)
  session.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(allowPermission(permission, details.requestingUrl, origin)),
  )
  session.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    allowPermission(permission, requestingOrigin, origin),
  )
  if (devUrl) {
    // Production responses carry the CSP from the app:// protocol handler.
    const csp = contentSecurityPolicy(new URL(devUrl).origin)
    session.webRequest.onHeadersReceived((details, callback) => {
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
