import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { launchApp, waitForReady } from "../../launch"

const canvasColor = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const main = document.querySelector('main[aria-label="Content"] > div:last-child')
    return main ? getComputedStyle(main).backgroundColor : "missing"
  })

test("a fresh profile opens in the dark theme on the neutral canvas", async () => {
  const { app, page } = await launchApp()
  try {
    await waitForReady(page)
    await expect(page.locator("html")).toHaveClass(/\bdark\b/)
    await expect(page.getByTestId("theme-toggle")).toHaveText("Theme: dark")
    expect(await canvasColor(page)).toBe("rgb(27, 27, 27)")
  } finally {
    await app.close()
  }
})

test("the chosen theme persists across restarts", async () => {
  const profile = mkdtempSync(join(tmpdir(), "fastview-profile-"))
  const first = await launchApp({ FASTVIEW_USER_DATA_DIR: profile })
  try {
    await waitForReady(first.page)
    await first.page.getByTestId("theme-toggle").click()
    await expect(first.page.getByTestId("theme-toggle")).toHaveText("Theme: light")
  } finally {
    await first.app.close()
  }
  const second = await launchApp({ FASTVIEW_USER_DATA_DIR: profile })
  try {
    await waitForReady(second.page)
    await expect(second.page.getByTestId("theme-toggle")).toHaveText("Theme: light")
    await expect(second.page.locator("html")).not.toHaveClass(/\bdark\b/)
    expect(await canvasColor(second.page)).toBe("rgb(232, 232, 232)")
  } finally {
    await second.app.close()
  }
})
