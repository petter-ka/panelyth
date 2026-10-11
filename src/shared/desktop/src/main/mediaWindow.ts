import { BrowserWindow } from "electron"
import { basename } from "node:path"
import { hardenWebContents } from "./security"
import { appIconPath } from "./paths"

// Media windows (ADR-0033 amended): an image or a video in a frameless,
// full-screen window, a child of the shell window. Like the document window the
// page has no preload and no IPC: all it gets is one read-only panelyth-media
// token in its URL fragment, which it can only use as an <img> or <video> source.

export type MediaWindowKind = "image" | "video"

export interface MediaWindowRequest {
  kind: MediaWindowKind
  /** The panelyth-media token URL (element loads only). */
  tokenUrl: string
  path: string
  mime: string
  theme?: string
  lang?: string
}

/** The fragment the page reads; the path itself never leaves main, only the name. */
export function mediaWindowUrl(
  base: string,
  request: Pick<MediaWindowRequest, "kind" | "tokenUrl" | "mime" | "theme" | "lang"> & {
    name: string
  },
): string {
  const params = new URLSearchParams({
    kind: request.kind,
    name: request.name,
    mime: request.mime,
    src: request.tokenUrl,
  })
  if (request.theme) params.set("theme", request.theme)
  if (request.lang) params.set("lang", request.lang)
  return `${base}#${params.toString()}`
}

export class MediaWindows {
  private readonly windows = new Set<BrowserWindow>()

  constructor(
    private readonly options: { url: string; origin: string; devTools: boolean },
    private readonly parent: () => BrowserWindow | null,
  ) {}

  open(request: MediaWindowRequest): void {
    const name = basename(request.path)
    const parent = this.parent()
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      frame: false,
      fullscreen: true,
      fullscreenable: true,
      autoHideMenuBar: true,
      title: name,
      icon: appIconPath(),
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      backgroundColor: "#000000",
      webPreferences: {
        // No preload: the page has no bridge to main (ADR-0033).
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        spellcheck: false,
        devTools: this.options.devTools,
      },
    })
    win.setMenuBarVisibility(false)
    hardenWebContents(win.webContents, this.options.origin)
    win.on("page-title-updated", (event) => event.preventDefault())
    // Esc closes the window; main sees it before the page, so it works while a video has focus.
    win.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        event.preventDefault()
        win.close()
      }
    })
    win.once("ready-to-show", () => {
      win.show()
      win.focus()
    })
    win.on("closed", () => this.windows.delete(win))
    this.windows.add(win)
    void win.loadURL(mediaWindowUrl(this.options.url, { ...request, name }))
  }

  get count(): number {
    return this.windows.size
  }
}
