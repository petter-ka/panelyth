import { BrowserWindow } from "electron"
import { DEV_METHODS_ARG } from "@panelyth/contracts"
import { perfMark } from "./perf"
import { hardenWebContents } from "./security"
import { appIconPath } from "./paths"
import type { ThemeColors } from "./themeColors"
import { DEFAULT_SIZE, MIN_SIZE, type InitialBounds } from "./windowState"

export interface WindowOptions {
  preload: string
  url: string
  origin: string
  devMethods: boolean
  devTools: boolean
  /** Extra renderer arguments (for example COMMANDER_ENABLED_ARG). */
  extraArgs?: readonly string[]
  /** The size and place of the previous run (windowState.ts); the default size otherwise. */
  bounds?: InitialBounds
  /** The theme the window opens in (the previous run's). */
  colors: ThemeColors
  /** The apps draw the title strip and its window buttons; no native title bar (Windows, ADR-0045). */
  titleBar: boolean
}

/** The secure web preferences every app view uses (ADR-0027). */
export function securePreferences(preload: string, devTools: boolean, args: readonly string[]) {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    devTools,
    additionalArguments: [...args],
  }
}

export function createMainWindow(options: WindowOptions): BrowserWindow {
  const { maximized, ...bounds } = options.bounds ?? { ...DEFAULT_SIZE, maximized: false }
  const win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    icon: appIconPath(),
    // The theme's chrome, so there is no flash of another color.
    backgroundColor: options.colors.chrome,
    ...(options.titleBar ? { titleBarStyle: "hidden" as const } : {}),
    webPreferences: securePreferences(options.preload, options.devTools, [
      ...(options.devMethods ? [DEV_METHODS_ARG] : []),
      ...(options.extraArgs ?? []),
    ]),
  })
  perfMark("window-created")
  // No menu bar row on Windows and Linux; the menu stays set, so its shortcuts still work.
  // (With the title strip there is no frame row for it either.)
  win.setMenuBarVisibility(false)
  hardenWebContents(win.webContents, options.origin)
  win.once("ready-to-show", () => {
    perfMark("ready-to-show")
    // Maximized only now: maximize() shows a hidden window on Windows.
    if (maximized) win.maximize()
    win.show()
  })
  void win.loadURL(options.url)
  return win
}
