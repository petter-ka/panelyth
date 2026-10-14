import { cpSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { launchApp, showDialogFolder, waitForReady } from "../../launch"

// The filter chips (kinds, file types, favorites, rating, tags) never run
// under the controls on the right: what does not fit the window goes into a
// "…" menu that holds the same choices.

const setWidth = (app: ElectronApplication, width: number) =>
  app.evaluate(({ BrowserWindow }, w) => {
    const win = BrowserWindow.getAllWindows().find((x) =>
      x.webContents.getURL().includes("index.html"),
    )
    win?.setMinimumSize(320, 300)
    win?.setSize(w, 800)
  }, width)

/** The chips' row ends before the controls on the right ("Include subfolders"). */
async function chipsClear(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const group = document.querySelector('[role="group"][aria-label="Filters"]')!
    const right = [...group.querySelectorAll<HTMLElement>("[data-chip]")]
      .filter((c) => !c.classList.contains("invisible"))
      .map((c) => c.getBoundingClientRect().right)
    const more = document
      .querySelector('[data-testid="more-filters"]')
      ?.getBoundingClientRect().right
    const subfolders = [...document.querySelectorAll("label")].find((l) =>
      l.textContent?.includes("Include subfolders"),
    )!
    const edge = Math.max(...right, more ?? 0)
    return edge <= subfolders.getBoundingClientRect().left
  })
}

test("filter chips that do not fit go into a … menu with the same choices", async () => {
  const fx = ensureFixture("images-12", { files: 0, images: { count: 12, width: 64, height: 48 } })
  const dir = join(mkdtempSync(join(tmpdir(), "panelyth-chips-")), "photos")
  cpSync(fx.root, dir, { recursive: true })
  const { app, page } = await launchApp({ PANELYTH_TEST_DIALOG_PATH: dir })
  try {
    await waitForReady(page)
    await showDialogFolder(page)
    const more = page.getByTestId("more-filters")
    await setWidth(app, 1600)
    await expect(more).toHaveCount(0)

    await setWidth(app, 900)
    await expect(more).toBeVisible()
    expect(await chipsClear(page)).toBe(true)
    // The hidden chips' choices are in the menu; turning one on marks the … button.
    await more.click()
    await page.getByRole("menuitemcheckbox", { name: "Favorites" }).click()
    await expect(more).toHaveClass(/bg-accent/)
    await page.keyboard.press("Escape")

    // Wider again: the chips come back, with the filter still on.
    await setWidth(app, 1600)
    await expect(more).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Favorites" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
  } finally {
    await app.close()
  }
})
