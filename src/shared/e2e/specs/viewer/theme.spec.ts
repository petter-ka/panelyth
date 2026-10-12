import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { commanderEnv, launchApp, waitForReady } from "../../launch"

// The theme is chosen in Settings → Appearance (shared by both apps since
// Stage C00). A fresh profile is dark; "System" follows the system's setting.
// Settings open from the app rail, which the product always shows (packaged
// builds have both apps), so the specs launch with the commander enabled.

const theme = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => document.documentElement.dataset.theme)

const isDark = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.classList.contains("dark"))

async function chooseTheme(page: Page, name: string): Promise<void> {
  const step = { timeout: 5_000 }
  await page.getByTestId("app-settings").click(step)
  await page.getByRole("tab", { name: "Appearance" }).click(step)
  await page
    .getByRole("group", { name: "Color theme" })
    .getByRole("button", { name, exact: true })
    .click(step)
}

test("a fresh profile opens in the dark theme; System follows the system's setting", async () => {
  const { app, page } = await launchApp(commanderEnv("viewer"))
  try {
    await waitForReady(page)
    await page.emulateMedia({ colorScheme: "light" })
    await expect.poll(() => theme(page)).toBe("dark")
    expect(await isDark(page)).toBe(true)
    await chooseTheme(page, "System")
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
    await chooseTheme(first.page, "Light")
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
