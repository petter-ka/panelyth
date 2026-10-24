import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron"
import { TITLE_BAR_ARG } from "@panelyth/contracts"
import { broadcast } from "./ipc/router"

// The title strip of a child window (ADR-0045, owner request 2026-10-24): the
// settings window, the document window and the text editor window draw the
// main window's strip with its own buttons (Windows). Windows that have no
// title row (the full-screen media window) stay as they are.

/** Windows: no native title row; the page draws the strip. */
export function childFrameOptions(
  titleBar: boolean,
): Pick<BrowserWindowConstructorOptions, "titleBarStyle"> {
  return titleBar ? { titleBarStyle: "hidden" } : {}
}

/** The renderer arguments that tell the page to draw the strip. */
export const childFrameArgs = (titleBar: boolean): string[] => (titleBar ? [TITLE_BAR_ARG] : [])

/** The page's buttons follow the window: restore while maximized, no strip in full screen. */
export function trackChildFrame(win: BrowserWindow): void {
  const send = (): void => {
    if (win.isDestroyed()) return
    broadcast([win.webContents], "window.state", {
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
    })
  }
  for (const event of [
    "maximize",
    "unmaximize",
    "enter-full-screen",
    "leave-full-screen",
  ] as const) {
    win.on(event as "maximize", send)
  }
}
