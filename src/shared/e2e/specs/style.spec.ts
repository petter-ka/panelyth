import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { hitTest } from "../hitTest"
import { commanderEnv, launchApp, openSettingsWindow, waitForReady } from "../launch"
import { commanderOf } from "./commander/helpers"

// The terminal style (ADR-0047): chosen in Settings → Appearance next to
// Classic and Liquid glass, shared by both apps, kept across restarts, and
// main opens the window in the console's colors.

const style = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => document.documentElement.dataset.style)

async function chooseTerminal(app: ElectronApplication, page: Page): Promise<void> {
  const step = { timeout: 5_000 }
  const settings = await openSettingsWindow(app, page)
  await settings.getByRole("tab", { name: "Appearance" }).click(step)
  await settings
    .getByRole("group", { name: "Design style" })
    .getByRole("button", { name: "Terminal" })
    .click(step)
  // The themes are named after the consoles; choosing one chooses the theme underneath.
  const dark = settings.getByRole("group", { name: "Dark themes" })
  await expect(dark.getByRole("button")).toHaveText(["Phosphor", "Ice", "Amber"])
  await dark.getByRole("button", { name: "Ice" }).click(step)
  await expect.poll(() => style(settings)).toBe("terminal")
  await settings.keyboard.down("Escape")
  await expect.poll(() => app.windows().some((p) => p === settings)).toBe(false)
}

test("the terminal style is shared by both apps and kept across restarts", async () => {
  const profile = mkdtempSync(join(tmpdir(), "panelyth-profile-"))
  const env = { ...commanderEnv("viewer"), PANELYTH_USER_DATA_DIR: profile }
  const first = await launchApp(env)
  try {
    await waitForReady(first.page)
    await chooseTerminal(first.app, first.page)
    await expect.poll(() => style(first.page)).toBe("terminal")
    // The commander's view loads on the first switch to it.
    await first.page.keyboard.press("Control+Shift+M")
    const c = await commanderOf(first.app)
    await expect.poll(() => style(c)).toBe("terminal")
    expect(await c.evaluate(() => document.documentElement.dataset.theme)).toBe("dark-purple")
    // The console's type: the bundled variable mono, in the chrome as in the lists.
    expect(await c.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(
      /^"Panelyth Terminal"/,
    )
  } finally {
    await first.app.close()
  }
  // Main keeps the style beside the theme: the next window opens in Ice's chrome.
  const stored = JSON.parse(readFileSync(join(profile, "window-state.json"), "utf8"))
  expect(stored).toMatchObject({ theme: "dark-purple", style: "terminal" })
  const second = await launchApp(env)
  try {
    await waitForReady(second.page)
    await expect.poll(() => style(second.page)).toBe("terminal")
    const background = await second.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.getBackgroundColor(),
    )
    expect(background.toLowerCase()).toBe("#060c13")
  } finally {
    await second.app.close()
  }
})

test("a real mouse: the strip's buttons click and the strip drags in the terminal style", async () => {
  test.skip(process.platform !== "win32", "the strip is drawn on Windows only")
  const profile = mkdtempSync(join(tmpdir(), "panelyth-profile-"))
  const { app, page } = await launchApp({
    ...commanderEnv("viewer"),
    PANELYTH_USER_DATA_DIR: profile,
  })
  try {
    await waitForReady(page)
    await chooseTerminal(app, page)
    const buttons = await hitTest(app, page, "[data-testid=title-bar] button")
    expect(buttons.length).toBeGreaterThan(2)
    expect(buttons).toEqual(buttons.map(() => "click"))
    expect(await hitTest(app, page, "[data-testid=title-bar] > span")).toContain("drag")
    expect(await hitTest(app, page, "[data-testid=title-bar-mark]")).toEqual(["drag"])
  } finally {
    await app.close()
  }
})
