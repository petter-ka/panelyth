import { WebContentsView, type BrowserWindow, type WebContents } from "electron"
import { readSwitchSettings, SHARED_SWITCH_KEY, type AppId } from "@panelyth/contracts"
import { broadcast } from "./ipc/router"
import { perfMark } from "./perf"
import { hardenWebContents } from "./security"
import { themeColorsOf } from "./themeColors"
import { securePreferences } from "./window"

// The view background follows the theme (themeColors.ts): a first switch shows
// the theme's surface rather than a dark one in a light theme.
export { chromeColorOf } from "./themeColors"

export const APP_TITLES: Record<AppId, string> = {
  viewer: "Panelyth",
  commander: "Panelyth Commander",
  system: "Panelyth System",
}

/** The apps shown in a view laid over the viewer (the viewer is the window's own page). */
export type ViewApp = Exclude<AppId, "viewer">
const VIEW_APPS: readonly ViewApp[] = ["commander", "system"]

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

/** How an app view is made: its page, origin and preload (ADR-0027). */
export interface AppViewOptions {
  url: string
  origin: string
  preload: string
  devTools: boolean
  /** Renderer arguments (TITLE_BAR_ARG). */
  args?: readonly string[]
}

export type AppViews = Partial<Record<ViewApp, AppViewOptions>>

/**
 * The shell's app switch (ADR-0031). The viewer is the window's own web
 * contents; the commander and Panelyth System (ADR-0042) are WebContentsViews
 * laid over it, each created on its first switch and then kept alive hidden.
 * Each has its own preload and origin, so main checks every call against that
 * app's profile (ADR-0027).
 */
export class AppShell {
  private readonly views = new Map<ViewApp, WebContentsView>()
  private active: AppId = "viewer"
  private switchedByUser = false
  private background = themeColorsOf("dark").chrome

  constructor(
    private readonly window: BrowserWindow,
    /** The apps beside the viewer; null when they are off (the feature flag). */
    private readonly viewOptions: AppViews | null,
    /** Called when another app is shown (the sidecar's watches follow it, ADR-0026). */
    private readonly onShown: (app: AppId) => void = () => undefined,
  ) {
    window.setTitle(APP_TITLES.viewer)
    // The shell owns the title: it names the visible app.
    window.on("page-title-updated", (event) => event.preventDefault())
    window.on("resize", () => this.layout())
    // The content area also changes without a resize: the native menu, set
    // after start, takes its bar's height from it on Windows and Linux. The
    // commander view would then stay taller than the window and lose its
    // bottom (the function keys, the rail's Settings) until the next resize.
    window.contentView.on("bounds-changed", () => this.layout())
    window.on("closed", () => {
      for (const view of this.views.values()) {
        if (!view.webContents.isDestroyed()) view.webContents.close()
      }
      this.views.clear()
    })
  }

  get enabled(): boolean {
    return this.viewOptions !== null
  }

  get activeApp(): AppId {
    return this.active
  }

  /** True once an app.switch request came from an app (not the start-up choice). */
  get switched(): boolean {
    return this.switchedByUser
  }

  /** app.switch from a renderer. */
  requestSwitch(to: AppId): void {
    this.switchedByUser = true
    this.switchTo(to)
  }

  /**
   * Brings the window to the front showing the viewer, and returns the
   * viewer's web contents (null when the window is gone).
   */
  showViewer(): WebContents | null {
    if (this.window.isDestroyed()) return null
    if (this.enabled) this.requestSwitch("viewer")
    if (this.window.isMinimized()) this.window.restore()
    this.window.focus()
    this.window.webContents.focus()
    return this.window.webContents
  }

  /** The theme changed (main follows `shared.appearance`). */
  setBackground(color: string): void {
    this.background = color
    for (const view of this.views.values()) view.setBackgroundColor(color)
  }

  webContentsOf(app: AppId): WebContents | null {
    if (app === "viewer") return this.window.webContents
    return this.views.get(app)?.webContents ?? null
  }

  /** Shows the given app; creates its view the first time. */
  switchTo(to: AppId): void {
    if (this.window.isDestroyed()) return
    if (to !== "viewer") {
      const view = this.ensureView(to)
      if (!view) return
      view.setVisible(true)
      view.webContents.focus()
    }
    // Only one app view is on top of the viewer at a time.
    for (const [app, view] of this.views) if (app !== to) view.setVisible(false)
    if (to === "viewer") this.window.webContents.focus()
    if (to === this.active) return
    this.active = to
    this.onShown(to)
    this.window.setTitle(APP_TITLES[to])
    for (const app of ["viewer", ...VIEW_APPS] as const) {
      const wc = this.webContentsOf(app)
      if (wc && !wc.isDestroyed()) broadcast([wc], "app.visibility", { app, visible: app === to })
    }
  }

  private ensureView(app: ViewApp): WebContentsView | null {
    const existing = this.views.get(app)
    if (existing) return existing
    const options = this.viewOptions?.[app]
    if (!options) return null
    perfMark(app === "commander" ? "commander-view-created" : "system-view-created")
    const view = new WebContentsView({
      webPreferences: securePreferences(options.preload, options.devTools, options.args ?? []),
    })
    // The theme's chrome, so a first switch never flashes another color.
    view.setBackgroundColor(this.background)
    hardenWebContents(view.webContents, options.origin)
    // A crashed app reloads alone; the viewer keeps running (NFR-13).
    view.webContents.on("render-process-gone", () => {
      if (!view.webContents.isDestroyed()) view.webContents.reload()
    })
    this.window.contentView.addChildView(view)
    this.views.set(app, view)
    this.layout()
    void view.webContents.loadURL(options.url)
    return view
  }

  /** The app views cover the window's content area, as the viewer's page does. */
  private layout(): void {
    if (this.window.isDestroyed()) return
    const [width = 0, height = 0] = this.window.getContentSize()
    for (const view of this.views.values()) view.setBounds({ x: 0, y: 0, width, height })
  }
}
