import { WebContentsView, type BrowserWindow, type WebContents } from "electron"
import type { AppId } from "@fastview/contracts"
import { broadcast } from "./ipc/router"
import { perfMark } from "./perf"
import { hardenWebContents } from "./security"
import { securePreferences } from "./window"

export const APP_TITLES: Record<AppId, string> = {
  viewer: "FastView",
  commander: "FastView Commander",
}

export interface CommanderView {
  url: string
  origin: string
  preload: string
  devTools: boolean
}

/**
 * The shell's app switch (ADR-0031). The viewer is the window's own web
 * contents; the commander is a WebContentsView laid over it, created on the
 * first switch and then kept alive hidden. Each has its own preload and
 * origin, so main checks every call against that app's profile (ADR-0027).
 */
export class AppShell {
  private commander: WebContentsView | null = null
  private active: AppId = "viewer"

  constructor(
    private readonly window: BrowserWindow,
    private readonly commanderView: CommanderView | null,
  ) {
    window.setTitle(APP_TITLES.viewer)
    // The shell owns the title: it names the visible app.
    window.on("page-title-updated", (event) => event.preventDefault())
    window.on("resize", () => this.layout())
    window.on("closed", () => {
      const wc = this.commander?.webContents
      if (wc && !wc.isDestroyed()) wc.close()
      this.commander = null
    })
  }

  get enabled(): boolean {
    return this.commanderView !== null
  }

  get activeApp(): AppId {
    return this.active
  }

  webContentsOf(app: AppId): WebContents | null {
    if (app === "viewer") return this.window.webContents
    return this.commander?.webContents ?? null
  }

  /** Shows the given app; creates the commander view the first time. */
  switchTo(to: AppId): void {
    if (this.window.isDestroyed()) return
    if (to === "commander") {
      const view = this.ensureCommander()
      if (!view) return
      view.setVisible(true)
      view.webContents.focus()
    } else {
      this.commander?.setVisible(false)
      this.window.webContents.focus()
    }
    if (to === this.active) return
    this.active = to
    this.window.setTitle(APP_TITLES[to])
    for (const app of ["viewer", "commander"] as const) {
      const wc = this.webContentsOf(app)
      if (wc && !wc.isDestroyed()) broadcast([wc], "app.visibility", { app, visible: app === to })
    }
  }

  private ensureCommander(): WebContentsView | null {
    if (this.commander) return this.commander
    const options = this.commanderView
    if (!options) return null
    perfMark("commander-view-created")
    const view = new WebContentsView({
      webPreferences: securePreferences(options.preload, options.devTools, []),
    })
    // The dark chrome token, so a first switch never flashes white.
    view.setBackgroundColor("#242424")
    hardenWebContents(view.webContents, options.origin)
    // A crashed commander reloads alone; the viewer keeps running (NFR-13).
    view.webContents.on("render-process-gone", () => {
      if (!view.webContents.isDestroyed()) view.webContents.reload()
    })
    this.window.contentView.addChildView(view)
    this.commander = view
    this.layout()
    void view.webContents.loadURL(options.url)
    return view
  }

  private layout(): void {
    if (!this.commander || this.window.isDestroyed()) return
    const [width = 0, height = 0] = this.window.getContentSize()
    this.commander.setBounds({ x: 0, y: 0, width, height })
  }
}
