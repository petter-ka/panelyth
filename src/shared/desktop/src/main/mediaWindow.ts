import { BrowserWindow, type WebContents } from "electron"
import type { ContentItem } from "@panelyth/contracts"
import { broadcast } from "./ipc/router"
import { hardenWebContents } from "./security"
import { appIconPath } from "./paths"
import { securePreferences } from "./window"

// Media windows (ADR-0033 amended): an image or a video in a frameless,
// full-screen window, a child of the shell window. The page is the shared
// media overlay (zoom, fit, the Panelyth player, next / previous) served from
// the commander's origin, so it runs on the commander's narrow profile
// (ADR-0027) like quick view does. The folder listing stays with the window
// that opened it: the media window asks it for neighbours through main.

export interface MediaWindowOptions {
  /** The page's URL (media.html on the commander's origin). */
  url: string
  origin: string
  preload: string
  devTools: boolean
}

export interface MediaWindowRequest {
  opener: WebContents
  key: number
  entryId: number
  theme?: string
  lang?: string
}

/** The fragment the page reads. No path: the page asks main for everything else. */
export function mediaWindowUrl(
  base: string,
  request: Pick<MediaWindowRequest, "entryId" | "theme" | "lang">,
): string {
  const params = new URLSearchParams({ entry: String(request.entryId) })
  if (request.theme) params.set("theme", request.theme)
  if (request.lang) params.set("lang", request.lang)
  return `${base}#${params.toString()}`
}

/** How long an opener has to answer a step before the window is told "no neighbour". */
export const STEP_TIMEOUT_MS = 5000

interface Child {
  opener: WebContents
  key: number
}

interface Pending {
  opener: WebContents
  resolve: (item: ContentItem | null) => void
  timer: ReturnType<typeof setTimeout>
}

export class MediaWindows {
  private readonly windows = new Set<BrowserWindow>()
  private readonly children = new Map<number, Child>()
  private readonly pending = new Map<number, Pending>()
  private nextRequest = 1

  constructor(
    private readonly options: MediaWindowOptions,
    private readonly parent: () => BrowserWindow | null,
  ) {}

  open(request: MediaWindowRequest): void {
    const parent = this.parent()
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      frame: false,
      fullscreen: true,
      fullscreenable: true,
      autoHideMenuBar: true,
      title: "Panelyth",
      icon: appIconPath(),
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      backgroundColor: "#000000",
      webPreferences: securePreferences(this.options.preload, this.options.devTools, []),
    })
    const id = win.webContents.id
    this.children.set(id, { opener: request.opener, key: request.key })
    win.setMenuBarVisibility(false)
    hardenWebContents(win.webContents, this.options.origin)
    win.on("page-title-updated", (event) => event.preventDefault())
    win.once("ready-to-show", () => {
      win.show()
      win.focus()
    })
    win.on("closed", () => {
      this.windows.delete(win)
      this.children.delete(id)
    })
    this.windows.add(win)
    void win.loadURL(mediaWindowUrl(this.options.url, request))
  }

  /** The media window `sender` asks its opener for the first, previous or next item. */
  step(sender: WebContents, direction: -1 | 0 | 1): Promise<ContentItem | null> {
    const child = this.children.get(sender.id)
    if (!child || child.opener.isDestroyed()) return Promise.resolve(null)
    const requestId = this.nextRequest++
    return new Promise((resolve) => {
      const done = (item: ContentItem | null): void => {
        const entry = this.pending.get(requestId)
        if (!entry) return
        clearTimeout(entry.timer)
        this.pending.delete(requestId)
        resolve(item)
      }
      const timer = setTimeout(() => done(null), STEP_TIMEOUT_MS)
      this.pending.set(requestId, { opener: child.opener, resolve: done, timer })
      broadcast([child.opener], "mediaWindow.step", { requestId, key: child.key, direction })
    })
  }

  /** The opener's reply; ignored from anyone but the window the request went to. */
  answer(sender: WebContents, requestId: number, item: ContentItem | null): void {
    const entry = this.pending.get(requestId)
    if (entry?.opener === sender) entry.resolve(item)
  }

  get count(): number {
    return this.windows.size
  }
}
