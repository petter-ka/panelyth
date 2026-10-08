import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type ElectronApplication } from "@playwright/test"
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

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(repoRoot, "shared", "bench", "results", `stage-C00-${date}-e2e-switch.jsonl`)
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
      expect(await page.evaluate(() => Object.keys(window.panelyth!.app))).toEqual(["exit"])
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

  test("theme and interface size are shared between the apps", async () => {
    const { app, page } = await launchApp(commanderEnv())
    try {
      await waitForReady(page)
      // By the rail: a key pressed this early can arrive before the viewer
      // takes keys (slow runners); the shortcut is covered above.
      await page.getByRole("button", { name: "Switch to Commander" }).click()
      const commander = await commanderPage(app)
      await expect(commander.getByTestId("theme-toggle")).toHaveText("Theme: Dark")
      await commander.getByTestId("theme-toggle").click()
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
