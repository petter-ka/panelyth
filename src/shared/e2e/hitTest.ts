import { execFileSync } from "node:child_process"
import type { ElectronApplication, Page } from "@playwright/test"

// Windows' own hit test over the main window (ADR-0045). Playwright's clicks
// go to the page and skip it, so a drag area over a button (the viewer's page
// lies under the other apps' views) passes a click test and fails a real
// mouse. WM_NCHITTEST asks the window what a screen point is, without moving
// the user's mouse.

const SCRIPT = `
param([Int64]$Hwnd, [string]$Points)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PanelythHit {
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
"@
$answers = foreach ($p in $Points.Split(";")) {
  $xy = $p.Split(",")
  $l = [IntPtr](([int]$xy[1] -shl 16) -bor ([int]$xy[0] -band 0xFFFF))
  [PanelythHit]::SendMessage([IntPtr]$Hwnd, 0x84, [IntPtr]::Zero, $l)
}
$answers -join ","
`

export type Hit = "click" | "drag" | `other ${string}`

/**
 * What a real mouse would do at the centre of every element each selector
 * matches, in order: reach the page (click) or move the window (drag).
 */
export async function hitTest(
  app: ElectronApplication,
  page: Page,
  selector: string,
): Promise<Hit[]> {
  // The window whose own page this is (a settings, document or editor window); an app
  // view (the commander, System) lives in the main window, whose own page is the viewer's.
  const { hwnd, content, scale } = await app.evaluate(({ BrowserWindow, screen }, url) => {
    const all = BrowserWindow.getAllWindows()
    const win =
      all.find((w) => w.webContents.getURL() === url) ??
      all.find(
        (w) =>
          /\/index\.html/.test(w.webContents.getURL()) &&
          !/texteditor|documents/.test(w.webContents.getURL()),
      ) ??
      all[0]!
    const handle = win.getNativeWindowHandle()
    return {
      hwnd: handle.readBigInt64LE(0).toString(),
      content: win.getContentBounds(),
      scale: screen.getDisplayMatching(win.getBounds()).scaleFactor,
    }
  }, page.url())
  const centres = await page.evaluate(
    (s) =>
      [...document.querySelectorAll(s)].map((el) => {
        const r = el.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      }),
    selector,
  )
  if (centres.length === 0) throw new Error(`nothing matches ${selector}`)
  const points = centres
    .map((c) => `${Math.round((content.x + c.x) * scale)},${Math.round((content.y + c.y) * scale)}`)
    .join(";")
  const answer = execFileSync(
    "powershell",
    ["-NoProfile", "-Command", `& {${SCRIPT}} -Hwnd ${hwnd} -Points '${points}'`],
    { encoding: "utf8" },
  ).trim()
  // HTCLIENT 1: the page gets the click; HTCAPTION 2: the window moves.
  return answer
    .split(",")
    .map((code): Hit => (code === "1" ? "click" : code === "2" ? "drag" : `other ${code}`))
}
