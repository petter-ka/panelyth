import { BrowserWindow } from "electron"
import { DEV_METHODS_ARG } from "@panelyth/contracts"
import { perfMark } from "./perf"
import { hardenWebContents } from "./security"
import { appIconPath } from "./paths"
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
    // The dark chrome token (the default theme), so there is no white flash.
    backgroundColor: "#242424",
    webPreferences: securePreferences(options.preload, options.devTools, [
      ...(options.devMethods ? [DEV_METHODS_ARG] : []),
      ...(options.extraArgs ?? []),
    ]),
  })
  perfMark("window-created")
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
