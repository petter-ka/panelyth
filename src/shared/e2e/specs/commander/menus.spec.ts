import { rmSync } from "node:fs"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { commanderOf, folderOf, goTo, launch } from "./helpers"

// The commander's popup menus are drawn at the top level of the page: over
// the panels and the cards' edges (a menu drawn in its bar was covered by
// the panel below it), within the window, and scrolling when the window is
// too small for them.

async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows()[0]!
      win.unmaximize()
      win.setContentSize(w, h)
    },
    [width, height] as const,
  )
}

/** Whether the menu is inside the window, nothing covers it, and it scrolls. */
function fit(c: Page, testId: string) {
  return c.getByTestId(testId).evaluate((menu) => {
    const r = menu.getBoundingClientRect()
    const points = [
      [r.left + 6, r.top + 6],
      [r.right - 6, r.top + 6],
      [r.left + 6, r.bottom - 6],
      [r.right - 6, r.bottom - 6],
      [r.left + r.width / 2, r.top + r.height / 2],
    ] as const
    return {
      inside: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
      covered: points.filter(([x, y]) => !menu.contains(document.elementFromPoint(x, y))).length,
      scrolls: menu.scrollHeight > menu.clientHeight,
    }
  })
}

test.describe("popup menus stay on top and within the window", () => {
  for (const style of ["classic", "glass", "terminal"] as const) {
    test(`the toolbar's add menu is drawn over the panels below it (${style})`, async () => {
      const { app } = await launch("commander")
      try {
        const c = await commanderOf(app)
        await resize(app, 1000, 600)
        // After the shared appearance has loaded, so it does not set the style back.
        await c.waitForTimeout(1000)
        await c.evaluate((s) => (document.documentElement.dataset.style = s), style)
        // The add menu is part of editing the toolbar.
        await c.getByTestId("toolbar-edit").click()
        await c.getByTestId("toolbar-add").click()
        await expect(c.getByTestId("toolbar-add-menu")).toBeVisible()
        expect(await fit(c, "toolbar-add-menu")).toMatchObject({ inside: true, covered: 0 })
      } finally {
        await app.close()
      }
    })
  }

  test("a scrolled menu stays where it was scrolled while the pointer moves over it", async () => {
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      // Small enough that the toolbar's add menu scrolls.
      await resize(app, 1000, 600)
      await c.getByTestId("toolbar-edit").click()
      await c.getByTestId("toolbar-add").click()
      const menu = c.getByTestId("toolbar-add-menu")
      await expect(menu).toBeVisible()
      expect(await fit(c, "toolbar-add-menu")).toMatchObject({ scrolls: true })
      const box = (await menu.boundingBox())!
      await c.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await c.mouse.wheel(0, 400)
      const scrolled = () => menu.evaluate((el) => el.scrollTop)
      await expect.poll(scrolled).toBeGreaterThan(100)
      const at = await scrolled()
      // Each item the pointer passes is highlighted (a render): the menu used to jump to its top.
      for (let y = box.y + 60; y < box.y + box.height - 20; y += 28) {
        await c.mouse.move(box.x + box.width / 2, y)
      }
      expect(await scrolled()).toBe(at)
    } finally {
      await app.close()
    }
  })

  test("the row menu opens above a row near the bottom, and scrolls in a small window", async () => {
    const root = folderOf(60)
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      // Tall enough for the menu (about twenty entries), but not below the last row.
      await resize(app, 1000, 900)
      await goTo(c, "left", root)
      // Holding the right button on the last row on screen: the menu opens at the
      // pointer, where there is no room below.
      const openAtLastRow = async () => {
        const rows = c.getByTestId("grid-left").locator("[data-id]")
        // The lowest row that is really under the pointer (not behind the bottom bars).
        const last = (await rows.evaluateAll((all) =>
          all
            .map((row) => {
              const r = row.getBoundingClientRect()
              const at = { x: r.left + 60, y: r.top + r.height / 2 }
              return row.contains(document.elementFromPoint(at.x, at.y)) ? at : null
            })
            .filter((at) => at !== null)
            .at(-1),
        ))!
        await c.mouse.move(last.x, last.y)
        await c.mouse.down({ button: "right" })
        await c.waitForTimeout(700)
        await c.mouse.up({ button: "right" })
        return last
      }
      const pointer = await openAtLastRow()
      const menu = c.getByTestId("row-menu-left")
      await expect(menu).toBeVisible()
      expect(await fit(c, "row-menu-left")).toMatchObject({
        inside: true,
        covered: 0,
        scrolls: false,
      })
      // Above the pointer, as a native menu opens when there is no room below.
      expect(
        (await menu.boundingBox())!.y + (await menu.boundingBox())!.height,
      ).toBeLessThanOrEqual(pointer.y + 1)
      await c.keyboard.press("Escape")
      await expect(menu).toHaveCount(0)

      // The smallest window (480 px high) is shorter than the menu: it fills the
      // window's height and scrolls.
      await resize(app, 1000, 480)
      await c.waitForFunction(() => innerHeight <= 480)
      await openAtLastRow()
      await expect(menu).toBeVisible()
      expect(await fit(c, "row-menu-left")).toMatchObject({
        inside: true,
        covered: 0,
        scrolls: true,
      })
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
