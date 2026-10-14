import { BrowserWindow, type WebContents } from "electron"
import type { SettingsTab } from "@panelyth/contracts"
import { hardenWebContents } from "./security"
import { appIconPath } from "./paths"
import { securePreferences } from "./window"

// Settings in a native window (ADR-0039): a child of the shell window that
// blocks it until closed and can be moved. Its page is settings.html on the
// opening app's origin with that app's preload, so it runs on that app's
// profile (ADR-0027) and shares its stored theme, size and language.

/** The opening app's settings page. */
export interface SettingsPage {
  /** settings.html on the app's origin. */
  url: string
  origin: string
  preload: string
  /** The app view's renderer arguments (whether the commander is enabled). */
  args: readonly string[]
}

export interface SettingsWindowOptions {
  devTools: boolean
  platform: NodeJS.Platform
}

/** The fragment the page reads: the tab to show first. */
export const settingsWindowUrl = (base: string, tab?: SettingsTab): string =>
  tab ? `${base}#tab=${tab}` : base

export class SettingsWindow {
  private win: BrowserWindow | null = null
  private opener: WebContents | null = null

  constructor(
    private readonly options: SettingsWindowOptions,
    private readonly parent: () => BrowserWindow | null,
  ) {}

  /** Opens the window for `opener`'s app, or focuses the one that is open. */
  open(opener: WebContents, page: SettingsPage, tab?: SettingsTab): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore()
      this.win.focus()
      return this.win
    }
    const parent = this.parent()
    const shell = parent && !parent.isDestroyed() ? parent : null
    // macOS shows a modal window as a sheet fixed to the parent's title bar; the
    // owner wants it movable, so there main disables the parent instead.
    const sheetless = this.options.platform === "darwin"
    const win = new BrowserWindow({
      width: 640,
      height: 640,
      minWidth: 520,
      minHeight: 480,
      show: false,
      title: "Settings",
      icon: appIconPath(),
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      ...(shell ? { parent: shell, modal: !sheetless } : {}),
      webPreferences: securePreferences(page.preload, this.options.devTools, page.args),
    })
    this.win = win
    this.opener = opener
    win.setMenuBarVisibility(false)
    hardenWebContents(win.webContents, page.origin)
    if (shell && sheetless) shell.setEnabled(false)
    win.once("ready-to-show", () => {
      win.show()
      win.focus()
    })
    win.on("closed", () => {
      if (this.win === win) {
        this.win = null
        this.opener = null
      }
      if (shell && !shell.isDestroyed()) {
        if (sheetless) shell.setEnabled(true)
        shell.focus()
      }
    })
    void win.loadURL(settingsWindowUrl(page.url, tab))
    return win
  }

  /** The app view that opened the window `sender` is, or null when `sender` is not the settings window. */
  openerOf(sender: WebContents): WebContents | null {
    const win = this.win
    if (!win || win.isDestroyed() || win.webContents !== sender) return null
    return this.opener && !this.opener.isDestroyed() ? this.opener : null
  }

  /** Closes the window when `sender` is it; false otherwise. */
  closeFrom(sender: WebContents): boolean {
    const win = this.win
    if (!win || win.isDestroyed() || win.webContents !== sender) return false
    win.close()
    return true
  }

  get isOpen(): boolean {
    return this.win !== null && !this.win.isDestroyed()
  }
}
