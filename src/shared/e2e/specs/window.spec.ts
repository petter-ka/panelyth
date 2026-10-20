import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type ElectronApplication } from "@playwright/test"
import { launchApp } from "../launch"

// The main window opens at the size, place and maximized state of the
// previous run (windowState.ts in the shell).

const bounds = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    return { ...win.getNormalBounds(), maximized: win.isMaximized() }
  })

test("the window opens at the size and place it had when the app quit", async () => {
  const env = { PANELYTH_USER_DATA_DIR: mkdtempSync(join(tmpdir(), "panelyth-e2e-window-")) }

  const first = await launchApp(env)
  // A first run opens at the default size.
  expect(await bounds(first.app)).toMatchObject({ width: 1440, height: 900, maximized: false })
  await first.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.setBounds({ x: 60, y: 40, width: 1100, height: 700 })
  })
  await first.app.close()

  const second = await launchApp(env)
  expect(await bounds(second.app)).toEqual({
    x: 60,
    y: 40,
    width: 1100,
    height: 700,
    maximized: false,
  })
  await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.maximize())
  await second.app.close()

  // Maximized again, over the size it had before.
  const third = await launchApp(env)
  try {
    await expect.poll(() => bounds(third.app)).toMatchObject({ maximized: true })
    await third.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.unmaximize())
    await expect
      .poll(() => bounds(third.app))
      .toEqual({ x: 60, y: 40, width: 1100, height: 700, maximized: false })
  } finally {
    await third.app.close()
  }
})
