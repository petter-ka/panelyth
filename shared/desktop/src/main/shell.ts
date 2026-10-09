import { WebContentsView, type BrowserWindow, type WebContents } from "electron"
import { readSwitchSettings, SHARED_SWITCH_KEY, type AppId } from "@panelyth/contracts"
import { broadcast } from "./ipc/router"
import { perfMark } from "./perf"
import { hardenWebContents } from "./security"
import { securePreferences } from "./window"

export const APP_TITLES: Record<AppId, string> = {
  viewer: "Panelyth",
  commander: "Panelyth Commander",
}

/**
 * The app shown at start (ADR-0031): Settings → General "Start with", or on
 * "last used app" the app named by the persisted shared context.
 */
export function startAppFrom(settings: Record<string, unknown>): AppId {
  const { startWith } = readSwitchSettings(settings[SHARED_SWITCH_KEY])
  if (startWith !== "last") return startWith
  const context = settings["shared.context"] as { app?: unknown } | undefined
  return context?.app === "commander" ? "commander" : "viewer"
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
  private switchedByUser = false
  private nextMediaRequestId = 1
  private readonly pendingMedia = new Map<
    number,
    { resolve: (ready: boolean) => void; timeout: ReturnType<typeof setTimeout> }
  >()

  constructor(
    private readonly window: BrowserWindow,
    private readonly commanderView: CommanderView | null,
  ) {
    window.setTitle(APP_TITLES.viewer)
    // The shell owns the title: it names the visible app.
    window.on("page-title-updated", (event) => event.preventDefault())
    window.on("resize", () => this.layout())
    window.on("closed", () => {
      for (const pending of this.pendingMedia.values()) {
        clearTimeout(pending.timeout)
        pending.resolve(false)
      }
      this.pendingMedia.clear()
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

  /** True once an app.switch request came from an app (not the start-up choice). */
  get switched(): boolean {
    return this.switchedByUser
  }

  /** app.switch from a renderer. */
  async requestSwitch(to: AppId, options: { openMedia?: boolean } = {}): Promise<void> {
    this.switchedByUser = true
    const prepared = to === "viewer" && options.openMedia ? await this.prepareViewerMedia() : false
    this.switchTo(to, { openMedia: options.openMedia === true && !prepared })
  }

  /** Resolves when the hidden Viewer has mounted the requested media surface. */
  reportMediaReady(requestId: number, ready: boolean): void {
    const pending = this.pendingMedia.get(requestId)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pendingMedia.delete(requestId)
    pending.resolve(ready)
  }

  webContentsOf(app: AppId): WebContents | null {
    if (app === "viewer") return this.window.webContents
    return this.commander?.webContents ?? null
  }

  /** Shows the given app; creates the commander view the first time. */
  switchTo(to: AppId, options: { openMedia?: boolean } = {}): void {
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
      if (wc && !wc.isDestroyed())
        broadcast([wc], "app.visibility", {
          app,
          visible: app === to,
          ...(app === "viewer" && to === "viewer" && options.openMedia ? { openMedia: true } : {}),
        })
    }
  }

  private prepareViewerMedia(): Promise<boolean> {
    const viewer = this.webContentsOf("viewer")
    if (!viewer || viewer.isDestroyed() || this.active !== "commander")
      return Promise.resolve(false)
    let requestId = this.nextMediaRequestId++
    if (!Number.isSafeInteger(this.nextMediaRequestId)) this.nextMediaRequestId = 1
    while (this.pendingMedia.has(requestId)) {
      requestId = this.nextMediaRequestId++
      if (!Number.isSafeInteger(this.nextMediaRequestId)) this.nextMediaRequestId = 1
    }
    const result = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingMedia.delete(requestId)
        resolve(false)
      }, 10_000)
      this.pendingMedia.set(requestId, { resolve, timeout })
    })
    broadcast([viewer], "app.mediaLaunch", { requestId })
    return result
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
