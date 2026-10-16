import { nativeTheme, WebContentsView, type BrowserWindow, type WebContents } from "electron"
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

/**
 * The chrome color of each theme (src/shared/ui/src/styles.css): what the
 * commander view shows before its page has painted, so a first switch shows
 * the theme's surface rather than a dark one in a light theme.
 */
const CHROME: Record<string, string> = {
  dark: "#242424",
  light: "#f7f7f7",
  "dark-purple": "#2a2233",
  "dark-brown": "#30251e",
  beige: "#f6f1e7",
  "light-brown": "#f2e4d0",
}

/** The view background for a `shared.appearance` value; dark when unknown. */
export function chromeColorOf(appearance: unknown): string {
  const theme = (appearance as { theme?: unknown } | null | undefined)?.theme
  if (theme === "system") return nativeTheme.shouldUseDarkColors ? CHROME.dark! : CHROME.light!
  return (typeof theme === "string" && CHROME[theme]) || CHROME.dark!
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
  private background = CHROME.dark!

  constructor(
    private readonly window: BrowserWindow,
    private readonly commanderView: CommanderView | null,
    /** Called when another app is shown (the sidecar's watches follow it, ADR-0026). */
    private readonly onShown: (app: AppId) => void = () => undefined,
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
    this.commander?.setBackgroundColor(color)
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
    this.onShown(to)
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
    // The theme's chrome, so a first switch never flashes another color.
    view.setBackgroundColor(this.background)
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
