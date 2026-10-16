import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type ElectronApplication } from "@playwright/test"
import { commanderOf, goTo, launch, mixedFolder } from "./commander/helpers"
import {
  commanderEnv,
  commanderPage,
  expectWithinBudget,
  launchApp,
  repoRoot,
  shellState,
  waitForReady,
} from "../launch"

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

  test("the commander fills the window, also once the menu bar has appeared", async () => {
    const { app } = await launchApp(commanderEnv("commander"))
    try {
      const commander = await commanderPage(app)
      await waitForReady(commander)
      // Main installs the native menu after start; on Windows and Linux its bar
      // takes height from the content without resizing the window.
      await expect
        .poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu() !== null))
        .toBe(true)
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
