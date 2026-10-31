import { childFrameArgs, childFrameOptions, trackChildFrame } from "./childFrame"
import { BrowserWindow, type WebContents } from "electron"
import type { CompareWindowOpenParams } from "@panelyth/contracts"
import { hardenWebContents } from "./security"
import { appIconPath } from "./paths"
import { securePreferences } from "./window"

// Compare windows (ADR-0048): compare by content, the result list of several
// compared files and Synchronize directories in windows of their own,
// children of the shell window that do not block it. The page is compare.html
// on the commander's origin with the commander's preload, so it runs on the
// commander's profile (ADR-0027) like the settings and media windows; it
// compares, pages and synchronizes through the same methods the dialogs used.

export interface CompareWindowOptions {
  /** compare.html on the commander's origin. */
  url: string
  origin: string
  preload: string
  devTools: boolean
  /** Windows: the page draws the title strip (ADR-0045). */
  titleBar: boolean
}

/** The fragment the page reads: what to compare. */
export function compareWindowUrl(base: string, p: CompareWindowOpenParams): string {
  const params = new URLSearchParams({ view: p.view })
  switch (p.view) {
    case "files":
      params.set("l", String(p.left.id))
      params.set("ln", p.left.name)
      params.set("r", String(p.right.id))
      params.set("rn", p.right.name)
      break
    case "many":
      params.set("job", String(p.jobId))
      params.set("side", p.side)
      params.set("count", String(p.count))
      params.set("folder", p.folder)
      params.set("mq", String(p.mineQueryId))
      params.set("tq", String(p.theirsQueryId))
      break
    case "sync":
      params.set("lp", p.left.path)
      if (p.left.dirId !== null) params.set("ld", String(p.left.dirId))
      params.set("rp", p.right.path)
      if (p.right.dirId !== null) params.set("rd", String(p.right.dirId))
      break
  }
  return `${base}#${params.toString()}`
}

/**
 * The comparison a window shows, when asking for it again should bring that
 * window forward: the same two files, the same two folders. A result list
 * belongs to its own job.
 */
export function compareWindowKey(p: CompareWindowOpenParams): string | null {
  if (p.view === "files") return `files:${p.left.id}:${p.right.id}`
  if (p.view === "sync") return `sync:${p.left.path}\0${p.right.path}`
  return null
}

const TITLES: Record<CompareWindowOpenParams["view"], string> = {
  files: "Compare by content",
  many: "Compare by content",
  sync: "Synchronize directories",
}

export class CompareWindows {
  private readonly windows = new Set<BrowserWindow>()
  private readonly byKey = new Map<string, BrowserWindow>()

  constructor(
    private readonly options: CompareWindowOptions,
    private readonly parent: () => BrowserWindow | null,
  ) {}

  /** Opens a window for the comparison, or brings forward the one that shows it. */
  open(p: CompareWindowOpenParams): BrowserWindow {
    const key = compareWindowKey(p)
    const open = key === null ? undefined : this.byKey.get(key)
    if (open && !open.isDestroyed()) {
      if (open.isMinimized()) open.restore()
      open.focus()
      return open
    }
    const parent = this.parent()
    const win = new BrowserWindow({
      width: p.view === "many" ? 900 : 1200,
      height: p.view === "many" ? 640 : 800,
      minWidth: 560,
      minHeight: 400,
      show: false,
      // The page names the window by what it compares once it has loaded.
      title: TITLES[p.view],
      icon: appIconPath(),
      autoHideMenuBar: true,
      ...(parent && !parent.isDestroyed() ? { parent } : {}),
      ...childFrameOptions(this.options.titleBar),
      webPreferences: securePreferences(
        this.options.preload,
        this.options.devTools,
        childFrameArgs(this.options.titleBar),
      ),
    })
    win.setMenuBarVisibility(false)
    if (this.options.titleBar) trackChildFrame(win)
    hardenWebContents(win.webContents, this.options.origin)
    win.once("ready-to-show", () => {
      win.show()
      win.focus()
    })
    win.on("closed", () => {
      this.windows.delete(win)
      if (key !== null && this.byKey.get(key) === win) this.byKey.delete(key)
    })
    this.windows.add(win)
    if (key !== null) this.byKey.set(key, win)
    void win.loadURL(compareWindowUrl(this.options.url, p))
    return win
  }

  /** The pages of the open compare windows. */
  webContents(): WebContents[] {
    return [...this.windows].filter((w) => !w.isDestroyed()).map((w) => w.webContents)
  }

  /** Whether `sender` is the page of a compare window. */
  owns(sender: WebContents): boolean {
    return [...this.windows].some((w) => !w.isDestroyed() && w.webContents === sender)
  }

  get count(): number {
    return this.windows.size
  }
}
