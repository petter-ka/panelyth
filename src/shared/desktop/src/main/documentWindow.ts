import { BrowserWindow } from "electron"
import { basename } from "node:path"
import { documentKindOf, type DocumentKind } from "@panelyth/contracts"
import { hardenWebContents } from "./security"
import { appIconPath } from "./paths"

// Document windows (ADR-0033): a PDF or text file in a window of its own, a
// child of the shell window. The page has no preload and no IPC: all it gets
// is one read-only panelyth-media token in its URL fragment, which only its
// own origin may fetch(). Nothing in it can reach the sidecar or the disk.

export interface DocumentWindowOptions {
  url: string
  origin: string
  devTools: boolean
}

export interface DocumentRequest {
  /** The panelyth-media token URL (read-only, fetch() from the documents origin only). */
  tokenUrl: string
  path: string
  sizeBytes: number
  theme?: string
}

/** The fragment the page reads; the path itself never leaves main, only the name. */
export function documentUrl(
  base: string,
  kind: DocumentKind,
  request: Pick<DocumentRequest, "tokenUrl" | "sizeBytes" | "theme"> & { name: string },
): string {
  const params = new URLSearchParams({
    kind,
    name: request.name,
    size: String(request.sizeBytes),
    src: request.tokenUrl,
  })
  if (request.theme) params.set("theme", request.theme)
  return `${base}#${params.toString()}`
}

export class DocumentWindows {
  private readonly windows = new Set<BrowserWindow>()

  constructor(
    private readonly options: DocumentWindowOptions,
    private readonly parent: () => BrowserWindow | null,
  ) {}

  /** Opens the file in a new window; false when it is not a document kind. */
  open(request: DocumentRequest): boolean {
    const kind = documentKindOf(request.path)
    if (!kind) return false
    const name = basename(request.path)
    const parent = this.parent()
    const win = new BrowserWindow({
      width: 1000,
      height: 800,
      minWidth: 480,
      minHeight: 360,
      show: false,
      title: name,
      icon: appIconPath(),
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      backgroundColor: request.theme?.startsWith("dark") || !request.theme ? "#242424" : "#f7f7f7",
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
    // The page sets no title of its own that outlives the file's name.
    win.on("page-title-updated", (event) => event.preventDefault())
    win.once("ready-to-show", () => win.show())
    win.on("closed", () => this.windows.delete(win))
    this.windows.add(win)
    void win.loadURL(documentUrl(this.options.url, kind, { ...request, name }))
    return true
  }

  get count(): number {
    return this.windows.size
  }
}
