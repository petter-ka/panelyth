import { expect, test } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { launchApp, showDialogFolder, waitForReady } from "../../launch"

// A context menu taller than the room around it stays within the window and
// scrolls (the menus of src/shared/ui cap themselves to the room Radix finds).

test("a tile's context menu stays within a small window and scrolls", async () => {
  const root = ensureFixture("c05-images", {
    files: 0,
    images: { count: 40, width: 1600, height: 1200 },
  }).root
  const { app, page } = await launchApp({ PANELYTH_TEST_DIALOG_PATH: root })
  try {
    await waitForReady(page)
    await showDialogFolder(page)
    // Shorter than the tile menu (about twenty items).
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!
      win.unmaximize()
      win.setContentSize(1000, 420)
    })
    await page.waitForFunction(() => innerHeight < 450)
    const tile = page.getByTestId("tile").first()
    await expect(tile).toBeVisible()
    const box = (await tile.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 10, { button: "right" })
    const menu = page.getByRole("menu")
    await expect(menu).toBeVisible()
    const fit = await menu.evaluate((m) => {
      const r = m.getBoundingClientRect()
      return {
        inside: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
        scrolls: m.scrollHeight > m.clientHeight,
      }
    })
    expect(fit).toEqual({ inside: true, scrolls: true })
    // The last item can be reached.
    await menu.getByRole("menuitem").last().scrollIntoViewIfNeeded()
    await expect(menu.getByRole("menuitem").last()).toBeInViewport()
  } finally {
    await app.close()
  }
})
