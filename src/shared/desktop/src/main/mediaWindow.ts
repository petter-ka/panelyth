import { BrowserWindow, type WebContents } from "electron"
import type {
  ContentItem,
  MediaWindowCommand,
  MediaWindowCommandResult,
  MediaWindowStep,
  OpenRequest,
} from "@panelyth/contracts"
import { broadcast } from "./ipc/router"
import { hardenWebContents } from "./security"
import { appIconPath } from "./paths"
import { securePreferences } from "./window"

// Media windows (ADR-0033 amended): an image or a video in a frameless,
// full-screen window. The page is the shared media overlay (zoom, fit, the
// Panelyth player, next / previous) served from the commander's origin, so it
// runs on the commander's narrow profile (ADR-0027) like quick view does.
//
// Opened from an app, the window is a child of the shell window and the
// folder listing stays with the window that opened it: the media window asks
// it for neighbours through main. Opened for a file from the OS ("Open
// with"), it stands alone, with no window behind it: main finds the items
// itself (openWith.ts).

export interface MediaWindowOptions {
  /** The page's URL (media.html on the commander's origin). */
  url: string
  origin: string
  preload: string
  devTools: boolean
}

/** Where a window without an opener gets its items (a file opened from the OS). */
export interface MediaSource {
  step(direction: MediaWindowStep): Promise<ContentItem | null>
  /** The folder and the item now shown, for "show it in the viewer". */
  current(): OpenRequest | null
  close(): void
}

export type MediaWindowRequest = { theme?: string; lang?: string } & (
  { opener: WebContents; key: number; entryId: number } | { source: MediaSource }
)

/** The fragment the page reads. No path: the page asks main for everything else. */
export function mediaWindowUrl(
  base: string,
  request: { entryId?: number; alone?: boolean; theme?: string; lang?: string },
): string {
  const params = new URLSearchParams()
  if (request.entryId !== undefined) params.set("entry", String(request.entryId))
  // No app behind it: a double-click takes the picture into the viewer instead of closing.
  if (request.alone) params.set("alone", "1")
  if (request.theme) params.set("theme", request.theme)
  if (request.lang) params.set("lang", request.lang)
  return `${base}#${params.toString()}`
}

/** How long an opener has to answer a step before the window is told "no neighbour". */
export const STEP_TIMEOUT_MS = 5000

type Child = { opener: WebContents; key: number } | { source: MediaSource }

interface Pending {
  opener: WebContents
  resolve: (answer: MediaWindowCommandResult) => void
  timer: ReturnType<typeof setTimeout>
}

const NO_ANSWER: MediaWindowCommandResult = { item: null, done: false }

export class MediaWindows {
  private readonly windows = new Set<BrowserWindow>()
  private readonly children = new Map<number, Child>()
  private readonly pending = new Map<number, Pending>()
  private nextRequest = 1

  constructor(
    private readonly options: MediaWindowOptions,
    private readonly parent: () => BrowserWindow | null,
  ) {}

  open(request: MediaWindowRequest): BrowserWindow {
    const alone = "source" in request
    // A window for a file from the OS belongs to no other window: the shell
    // may not exist, or be minimized.
    const parent = alone ? null : this.parent()
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
    this.children.set(
      id,
      alone ? { source: request.source } : { opener: request.opener, key: request.key },
    )
    win.setMenuBarVisibility(false)
    hardenWebContents(win.webContents, this.options.origin)
    win.on("page-title-updated", (event) => event.preventDefault())
    win.once("ready-to-show", () => {
      win.show()
      win.focus()
    })
    win.on("closed", () => {
      this.windows.delete(win)
      const child = this.children.get(id)
      this.children.delete(id)
      if (child && "source" in child) child.source.close()
      // The opener selects the file the window showed last.
      else if (child) broadcast([child.opener], "mediaWindow.closed", { key: child.key })
    })
    this.windows.add(win)
    void win.loadURL(
      mediaWindowUrl(this.options.url, {
        ...(alone ? { alone: true } : { entryId: request.entryId }),
        ...(request.theme && { theme: request.theme }),
        ...(request.lang && { lang: request.lang }),
      }),
    )
    return win
  }

  /** The media window `sender` asks for an item (MediaWindowStep): of its opener, or of its source. */
  step(sender: WebContents, direction: MediaWindowStep): Promise<ContentItem | null> {
    const child = this.children.get(sender.id)
    if (!child) return Promise.resolve(null)
    if ("source" in child) return child.source.step(direction)
    return this.ask(child, (requestId) =>
      broadcast([child.opener], "mediaWindow.step", { requestId, key: child.key, direction }),
    ).then((answer) => answer.item)
  }

  /**
   * A file command from the media window `sender` (copy, cut, paste, trash,
   * delete), carried out by its opener on the file the window shows; the
   * answer is the item to show next and whether the command ran. A window
   * opened from the OS has no opener to carry it out.
   */
  command(sender: WebContents, command: MediaWindowCommand): Promise<MediaWindowCommandResult> {
    const child = this.children.get(sender.id)
    if (!child || "source" in child) return Promise.resolve(NO_ANSWER)
    return this.ask(child, (requestId) =>
      broadcast([child.opener], "mediaWindow.command", { requestId, key: child.key, command }),
    )
  }

  /** One question to an opener; it answers through media.windowAnswer, or nothing comes after STEP_TIMEOUT_MS. */
  private ask(
    child: { opener: WebContents },
    send: (requestId: number) => void,
  ): Promise<MediaWindowCommandResult> {
    if (child.opener.isDestroyed()) return Promise.resolve(NO_ANSWER)
    const requestId = this.nextRequest++
    return new Promise((resolve) => {
      const done = (answer: MediaWindowCommandResult): void => {
        const entry = this.pending.get(requestId)
        if (!entry) return
        clearTimeout(entry.timer)
        this.pending.delete(requestId)
        resolve(answer)
      }
      const timer = setTimeout(() => done(NO_ANSWER), STEP_TIMEOUT_MS)
      this.pending.set(requestId, { opener: child.opener, resolve: done, timer })
      send(requestId)
    })
  }

  /** The opener's reply; ignored from anyone but the window the request went to. */
  answer(sender: WebContents, requestId: number, item: ContentItem | null, done = false): void {
    const entry = this.pending.get(requestId)
    if (entry?.opener === sender) entry.resolve({ item, done })
  }

  /** The source of a window opened for a file from the OS; null for any other sender. */
  sourceOf(sender: WebContents): MediaSource | null {
    const child = this.children.get(sender.id)
    return child && "source" in child ? child.source : null
  }

  get count(): number {
    return this.windows.size
  }
}
