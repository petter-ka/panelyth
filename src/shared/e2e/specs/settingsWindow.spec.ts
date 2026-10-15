import { expect, test, type ElectronApplication } from "@playwright/test"
import { commanderEnv, commanderPage, launchApp, openSettingsWindow, shellState } from "../launch"

// ADR-0039: Settings is a native child window that blocks the shell window
// until it closes and can be moved. What it changes applies to its app at once.

/** The settings window as main made it, and whether its parent takes input. */
const windowShape = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const all = BrowserWindow.getAllWindows()
    const settings = all.find((w) => w.webContents.getURL().includes("/settings.html"))
    if (!settings) return null
    const parent = settings.getParentWindow()
    return {
      hasParent: parent !== null,
      parentEnabled: parent?.isEnabled() ?? null,
      movable: settings.isMovable(),
      minimizable: settings.isMinimizable(),
      title: settings.getTitle(),
    }
  })

test("Settings is a movable child window that blocks the app; changes apply at once", async () => {
  const { app } = await launchApp(commanderEnv("commander"))
  try {
    await expect.poll(async () => (await shellState(app)).active).toBe("commander")
    const c = await commanderPage(app)
    await expect(c.getByTestId("function-keys")).toBeVisible({ timeout: 10_000 })

    const settings = await openSettingsWindow(app, c)
    // The commander's own page and profile (ADR-0027): its origin.
    expect(settings.url()).toContain("app://commander/settings.html")
    await expect
      .poll(() => windowShape(app))
      .toEqual({
        hasParent: true,
        // Windows and Linux: a native modal window. macOS: the shell stays enabled (Electron
        // would dim it with a sheet) and the settings window keeps the focus instead.
        parentEnabled: process.platform === "darwin",
        movable: true,
        minimizable: false,
        title: "Settings",
      })

    // The commander's tab: the function-key bar goes from the commander at once.
    await settings.getByRole("checkbox", { name: "Function-key bar" }).uncheck()
    await expect(c.getByTestId("function-keys")).toHaveCount(0)

    // Shortcuts: the window closes and the commander opens its shortcuts dialog.
    await settings.getByRole("tab", { name: "Shortcuts" }).click()
    await settings.getByRole("button", { name: "Open keyboard shortcuts" }).click()
    await expect.poll(() => app.windows().includes(settings)).toBe(false)
    await expect(c.getByRole("dialog", { name: /keyboard shortcuts/i })).toBeVisible()
    // The app takes input again.
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((w) => w.isEnabled()),
        ),
      )
      .toBe(true)
  } finally {
    await app.close()
  }
})
