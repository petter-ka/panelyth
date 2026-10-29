import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { commanderOf, goTo, launch, mixedFolder } from "./commander/helpers"
import {
  commanderEnv,
  commanderPage,
  expectWithinBudget,
  launchApp,
  repoRoot,
  shellState,
  showViewerFolder,
  systemPage,
  waitForReady,
} from "../launch"
import { hitTest } from "../hitTest"

// The app switch between the viewer and the commander (ADR-0031,
// docs/shared/APP-SWITCHING.md), Stage C00 part: the switch itself and shared
// appearance. Folder and selection carry-over arrive in Stages C01 and C02.

function writeResult(result: object, stage = "C00"): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(
    repoRoot,
    "src",
    "shared",
    "bench",
    "results",
    `stage-${stage}-${date}-e2e-switch.jsonl`,
  )
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

const title = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle())

/** Working set of every process of the app, in MB. */
const workingSetMb = (app: ElectronApplication) =>
  app.evaluate(({ app: electronApp }) =>
    Math.round(
      electronApp.getAppMetrics().reduce((sum, m) => sum + m.memory.workingSetSize, 0) / 1024,
    ),
  )

test.describe("app switch (ADR-0031)", () => {
  test("hidden while the commander is disabled", async () => {
    const { app, page } = await launchApp()
    try {
      await waitForReady(page)
      await expect(page.getByRole("toolbar", { name: "Navigation" })).toBeVisible()
      await expect(page.getByTestId("app-switch")).toHaveCount(0)
      // No switch; openRequest is the viewer asking what it was started to show ("Open with"),
      // about and openTarget are Settings → About (Stage P06).
      expect(await page.evaluate(() => Object.keys(window.panelyth!.app).sort())).toEqual([
        "about",
        "exit",
        "openRequest",
        "openTarget",
      ])
      await page.keyboard.press("Control+Shift+M")
      await page.waitForTimeout(300)
      expect(await shellState(app)).toMatchObject({ active: "viewer", commanderCreated: false })
    } finally {
      await app.close()
    }
  })

  test("switches both ways by icon and by key; the commander view is created once", async () => {
    test.setTimeout(60_000)
    const { app, page } = await launchApp(commanderEnv())
    try {
      await waitForReady(page)
      await expect(page.getByRole("toolbar", { name: "Navigation" })).toBeVisible()
      await page.waitForTimeout(1000) // settle startup before measuring memory
      const viewerOnlyMb = await workingSetMb(app)

      // First switch: the view is created on demand.
      let t0 = Date.now()
      await page.getByRole("button", { name: "Switch to Commander" }).click()
      const commander = await commanderPage(app)
      await expect(commander.getByTestId("panel-left")).toBeVisible()
      const firstSwitchMs = Date.now() - t0
      expect(await shellState(app)).toMatchObject({ active: "commander", commanderCreated: true })
      expect(await title(app)).toBe("Panelyth Commander")

      // Keys reach the commander after the switch.
      await commander.keyboard.press("Tab")
      await expect(commander.getByTestId("panel-right")).toHaveAttribute("data-active", "true")

      // Back by icon, then forth and back by key.
      await commander.getByRole("button", { name: "Switch to Viewer" }).click()
      await expect.poll(() => shellState(app)).toMatchObject({ active: "viewer" })
      expect(await title(app)).toBe("Panelyth")
      const later: number[] = []
      for (const [from, to] of [
        [page, "commander"],
        [commander, "viewer"],
        [page, "commander"],
        [commander, "viewer"],
      ] as const) {
        t0 = Date.now()
        await from.keyboard.press("Control+Shift+M")
        await expect.poll(() => shellState(app), { intervals: [5] }).toMatchObject({ active: to })
        later.push(Date.now() - t0)
      }
      expect(app.windows().filter((p) => p.url().startsWith("app://commander"))).toHaveLength(1)

      // The viewer still takes keys after switching back.
      await page.keyboard.press("Control+F")
      await expect(page.locator("#folder-search")).toBeFocused()

      await page.waitForTimeout(1000)
      const bothViewsMb = await workingSetMb(app)
      const result = {
        test: "switch",
        firstSwitchMs,
        laterSwitchMs: later,
        viewerOnlyMb,
        bothViewsMb,
        commanderViewMb: bothViewsMb - viewerOnlyMb,
      }
      writeResult(result)
      test.info().annotations.push({ type: "metrics", description: JSON.stringify(result) })
      expectWithinBudget(firstSwitchMs, 800, "C00 first switch (ms)")
    } finally {
      await app.close()
    }
  })

  // Stage P02 (ADR-0026): the sidecar watches the folders of the app on
  // screen only, and lists a hidden app's folders again when it is shown.
  test("a folder that changed while its app was hidden is current when the app is shown", async () => {
    test.setTimeout(60_000)
    const left = mixedFolder()
    const right = mkdtempSync(join(tmpdir(), "panelyth-p02-"))
    writeFileSync(join(right, "was-here.txt"), "x")
    const { app, page } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "right", right)
      await goTo(c, "left", left)
      const rightRows = c.getByTestId("grid-right").locator("[data-id]")
      await expect(rightRows.filter({ hasText: "was-here" })).toBeVisible()

      // The viewer is shown: it follows the active panel's folder, and the
      // other panel's folder is no longer watched.
      await c.getByTestId("grid-left").focus()
      await c.keyboard.press("Control+Shift+M")
      await expect.poll(() => shellState(app)).toMatchObject({ active: "viewer" })
      await expect(page.getByTestId("tile").first()).toBeVisible()
      writeFileSync(join(right, "arrived-while-hidden.txt"), "x")
      // Longer than the watcher's forced re-listing: nobody is told by the OS.
      await page.waitForTimeout(2500)

      const t0 = Date.now()
      await page.keyboard.press("Control+Shift+M")
      await expect.poll(() => shellState(app)).toMatchObject({ active: "commander" })
      await expect(rightRows.filter({ hasText: "arrived-while-hidden" })).toBeVisible()
      const shownMs = Date.now() - t0
      await expect(rightRows.filter({ hasText: "was-here" })).toBeVisible()

      // On screen again, the panel follows changes as before.
      writeFileSync(join(right, "arrived-while-shown.txt"), "x")
      await expect(rightRows.filter({ hasText: "arrived-while-shown" })).toBeVisible()
      writeResult({ test: "relist-on-show", shownMs }, "P02")
    } finally {
      await app.close()
    }
  })

  test("the commander fills the window, also once the native menu is installed", async () => {
    const { app } = await launchApp(commanderEnv("commander"))
    try {
      const commander = await commanderPage(app)
      await waitForReady(commander)
      // Main installs the native menu after start; its bar is never shown, so it
      // takes no height from the content.
      await expect
        .poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu() !== null))
        .toBe(true)
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.isMenuBarVisible(),
        ),
      ).toBe(false)
      const contentHeight = () =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize()[1]!)
      await expect
        .poll(async () => (await commander.evaluate(() => innerHeight)) - (await contentHeight()))
        .toBe(0)
      // The bottom of the commander is on screen: the function keys and the rail's Settings.
      const bottom = (testId: string) =>
        commander.getByTestId(testId).evaluate((el) => el.getBoundingClientRect().bottom)
      const height = await commander.evaluate(() => innerHeight)
      expect(await bottom("app-settings")).toBeLessThanOrEqual(height)
      expect(await bottom("function-keys")).toBeLessThanOrEqual(height)
      // Windows: the title strip is the page's, at the top, with the window's buttons (ADR-0045).
      const strip = commander.getByTestId("title-bar")
      if (process.platform === "win32") {
        await expect(strip).toContainText("Panelyth Commander")
        const box = await strip.evaluate((el) => el.getBoundingClientRect().toJSON())
        expect(box).toMatchObject({ top: 0, height: 33 })
        // The mark takes the corner, level with the strip; the rail starts below it.
        const rect = (testId: string) =>
          commander.getByTestId(testId).evaluate((el) => el.getBoundingClientRect().toJSON())
        expect(await rect("title-bar-mark")).toMatchObject({ top: 0, left: 0, height: 33 })
        expect((await rect("app-switcher")).top).toBe(33)
        const maximized = () =>
          app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized())
        await commander.getByRole("button", { name: "Maximize" }).click()
        await expect.poll(maximized).toBe(true)
        // Main reports it: the button offers Restore.
        await commander.getByRole("button", { name: "Restore" }).click()
        await expect.poll(maximized).toBe(false)
        await commander.getByRole("button", { name: "Minimize" }).click()
        await expect
          .poll(() =>
            app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized()),
          )
          .toBe(true)
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.restore())
      } else {
        await expect(strip).toHaveAttribute("aria-hidden", "true")
      }
    } finally {
      await app.close()
    }
  })

  test("the title strip's switchers: the viewer's tile size and preview, the commander's layouts (ADR-0045)", async () => {
    test.skip(process.platform !== "win32", "the strip is drawn on Windows only")
    const dir = mixedFolder()
    const { app, page } = await launch("viewer")
    try {
      await showViewerFolder(page, dir)
      // The viewer: the tile size and the preview's place.
      const tiles = page.getByTestId("tile-view")
      await page.getByTestId("title-tile-size").getByRole("radio", { name: "Large tiles" }).click()
      await expect(tiles).toHaveAttribute("data-tile-size", "large")
      await page.getByTestId("title-tile-size").getByRole("radio", { name: "Medium tiles" }).click()
      await expect(tiles).toHaveAttribute("data-tile-size", "medium")
      const right = page
        .getByTestId("title-preview-place")
        .getByRole("radio", { name: "Preview in a column on the right" })
      await right.click()
      await expect(right).toHaveAttribute("aria-checked", "true")
      await page
        .getByTestId("title-preview-place")
        .getByRole("radio", { name: "Preview under the folders" })
        .click()

      // The commander: layout presets set the whole window, whichever panel is active.
      await page.getByRole("button", { name: "Switch to Commander" }).click()
      const c = await commanderOf(app)
      await goTo(c, "left", dir)
      await goTo(c, "right", dir)
      const panels = [c.getByTestId("panel-left"), c.getByTestId("panel-right")]
      // One button (owner request 2026-10-27); pointing at it opens the presets as tiles.
      const presets = c.getByTestId("title-layout")
      const menu = c.getByTestId("title-layout-menu")
      const preset = (name: RegExp) => menu.getByRole("menuitemradio", { name })
      const open = async () => {
        // From elsewhere: a pointer resting on the button after Esc opens nothing until it comes again.
        await c.mouse.move(10, 400)
        await presets.hover()
        await expect(menu).toBeVisible()
      }
      const choose = async (name: RegExp) => {
        await open()
        await preset(name).click()
        await expect(menu).toHaveCount(0)
      }
      await open()
      await expect(preset(/^Details/)).toHaveAttribute("aria-checked", "true")
      // The pointer gone from the button and the menu: it closes by itself.
      await c.mouse.move(10, 400)
      await expect(menu).toHaveCount(0)

      await choose(/^List/)
      for (const panel of panels) {
        await expect(panel.getByRole("listbox")).toBeVisible()
        await expect(panel.getByRole("grid")).toHaveCount(0)
      }
      await open()
      await expect(preset(/^List/)).toHaveAttribute("aria-checked", "true")
      await c.keyboard.press("Escape")
      // The click left the keys with the active panel (the right one, opened last).
      await expect(panels[1]!.getByRole("listbox")).toBeFocused()

      await choose(/^Tree/)
      await expect(c.getByTestId("tree-one")).toBeVisible()
      for (const panel of panels) await expect(panel.getByRole("grid")).toBeVisible()

      await choose(/^Preview/)
      await expect(c.getByTestId("quick-view")).toBeVisible()
      await expect(c.getByTestId("tree-one")).toHaveCount(0)

      // Stacked: the left panel above the right one, as wide as the window.
      const box = (i: 0 | 1) => panels[i]!.evaluate((el) => el.getBoundingClientRect().toJSON())
      await choose(/^Stacked/)
      await expect(c.getByTestId("quick-view")).toHaveCount(0)
      await expect.poll(async () => (await box(0)).bottom <= (await box(1)).top + 1).toBe(true)
      expect((await box(0)).left).toBe((await box(1)).left)

      // Single: the active panel alone across the window, as thumbnails.
      await choose(/^Single/)
      await expect(c.getByTestId("panel-left")).toHaveCount(0)
      await expect(panels[1]!).toBeVisible()
      await open()
      await expect(preset(/^Single/)).toHaveAttribute("aria-checked", "true")
      await c.keyboard.press("Escape")

      await choose(/^Details/)
      for (const panel of panels) await expect(panel.getByRole("grid")).toBeVisible()
      await expect.poll(async () => (await box(0)).right <= (await box(1)).left + 1).toBe(true)

      // A change by hand that matches no preset lights none.
      await c.keyboard.press("Control+F1")
      await open()
      await expect(menu.getByRole("menuitemradio", { checked: true })).toHaveCount(0)
      await c.keyboard.press("Escape")
    } finally {
      await app.close()
    }
  })

  test("a real mouse: the strip's buttons click and the strip drags, in every app (ADR-0045)", async () => {
    test.skip(process.platform !== "win32", "the strip is drawn on Windows only")
    // The commander first: the viewer's page lies under it from the start.
    const { app, page } = await launch("commander")
    try {
      const expectRealMouse = async (p: Page) => {
        const buttons = await hitTest(app, p, "[data-testid=title-bar] button")
        expect(buttons.length).toBeGreaterThan(2)
        expect(buttons).toEqual(buttons.map(() => "click"))
        // The name and the corner are the window's handle.
        expect(await hitTest(app, p, "[data-testid=title-bar] > span")).toContain("drag")
        expect(await hitTest(app, p, "[data-testid=title-bar-mark]")).toEqual(["drag"])
      }
      const c = await commanderOf(app)
      await expectRealMouse(c)

      await c.getByRole("button", { name: "Switch to Viewer" }).click()
      await expect(page.getByTestId("current-app")).toHaveAttribute("data-target", "viewer")
      await expectRealMouse(page)

      await page.getByRole("button", { name: "Switch to System" }).click()
      const system = await systemPage(app)
      await expect(system.getByTestId("current-app")).toHaveAttribute("data-target", "system")
      await expectRealMouse(system)
    } finally {
      await app.close()
    }
  })

  test("theme and interface size are shared between the apps", async () => {
    const { app, page } = await launchApp(commanderEnv())
    try {
      await waitForReady(page)
      // By the rail: a key pressed this early can arrive before the viewer
      // takes keys (slow runners); the shortcut is covered above.
      await page.getByRole("button", { name: "Switch to Commander" }).click()
      const commander = await commanderPage(app)
      await expect(commander.getByTestId("theme-toggle")).toHaveText("Theme: Dark")
      // The status bar is hidden for now; its theme button still works.
      await commander.getByTestId("theme-toggle").dispatchEvent("click")
      await expect(commander.getByTestId("theme-toggle")).toHaveText("Theme: Light")
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
        .toBe("light")
      expect(await commander.evaluate(() => document.documentElement.dataset.theme)).toBe("light")
    } finally {
      await app.close()
    }
  })
})
