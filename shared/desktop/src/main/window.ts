import { BrowserWindow } from "electron"
import { DEV_METHODS_ARG } from "@fastview/contracts"
import { perfMark } from "./perf"
import { hardenWebContents } from "./security"

export interface WindowOptions {
  preload: string
  url: string
  origin: string
  devMethods: boolean
  devTools: boolean
  /** Extra renderer arguments (for example COMMANDER_ENABLED_ARG). */
  extraArgs?: readonly string[]
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
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    show: false,
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
    win.show()
  })
  void win.loadURL(options.url)
  return win
}
