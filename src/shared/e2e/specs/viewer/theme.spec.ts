import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { commanderEnv, launchApp, openSettingsWindow, waitForReady } from "../../launch"

// The theme is chosen in Settings → Appearance (shared by both apps since
// Stage C00). A fresh profile is dark; "System" follows the system's setting.
// Settings open from the app rail, which the product always shows (packaged
// builds have both apps), so the specs launch with the commander enabled.

const theme = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => document.documentElement.dataset.theme)

const isDark = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.classList.contains("dark"))

/** Settings opens in a window of its own (ADR-0039); the choice applies to the app at once. */
async function chooseTheme(app: ElectronApplication, page: Page, name: string): Promise<void> {
  const step = { timeout: 5_000 }
  const settings = await openSettingsWindow(app, page)
  await settings.getByRole("tab", { name: "Appearance" }).click(step)
  const group = settings.getByRole("group", { name: "Color theme" })
  // System is a checkbox above the dark and light groups.
  if (name === "System") await group.getByRole("checkbox", { name }).check(step)
  else await group.getByRole("button", { name, exact: true }).click(step)
  // Esc closes the window on keydown: there is no page left for a keyup.
  await settings.keyboard.down("Escape")
  await expect.poll(() => app.windows().some((p) => p === settings)).toBe(false)
}

test("a fresh profile opens in the dark theme; System follows the system's setting", async () => {
  const { app, page } = await launchApp(commanderEnv("viewer"))
  try {
    await waitForReady(page)
    await page.emulateMedia({ colorScheme: "light" })
    await expect.poll(() => theme(page)).toBe("dark")
    expect(await isDark(page)).toBe(true)
    await chooseTheme(app, page, "System")
    await expect.poll(() => theme(page)).toBe("light")
    expect(await isDark(page)).toBe(false)
    await page.emulateMedia({ colorScheme: "dark" })
    await expect.poll(() => theme(page)).toBe("dark")
    expect(await isDark(page)).toBe(true)
  } finally {
    await app.close()
  }
})

test("the chosen theme persists across restarts, whatever the system says", async () => {
  const profile = mkdtempSync(join(tmpdir(), "panelyth-profile-"))
  const env = { ...commanderEnv("viewer"), PANELYTH_USER_DATA_DIR: profile }
  const first = await launchApp(env)
  try {
    await waitForReady(first.page)
    await first.page.emulateMedia({ colorScheme: "dark" })
    await chooseTheme(first.app, first.page, "Light")
    await expect.poll(() => theme(first.page)).toBe("light")
    expect(await isDark(first.page)).toBe(false)
  } finally {
    await first.app.close()
  }
  const second = await launchApp(env)
  try {
    await waitForReady(second.page)
    await second.page.emulateMedia({ colorScheme: "dark" })
    await expect.poll(() => theme(second.page)).toBe("light")
    expect(await isDark(second.page)).toBe(false)
  } finally {
    await second.app.close()
  }
})
