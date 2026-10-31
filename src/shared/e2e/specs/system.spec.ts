import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { commanderOf, launch } from "./commander/helpers"
import { expectOutlineFirst, removeTemp, shellState, systemPage } from "../launch"

// Panelyth System (ADR-0042): the third app on the rail. Its dashboard reads
// the computer, its load and its volumes; its search runs the find engine on
// the volumes ticked and shows a result in the commander.

test.describe("Panelyth System (ADR-0042)", () => {
  test("opens from the rail with the computer, its load and its volumes", async () => {
    test.setTimeout(60_000)
    const { app, page } = await launch("viewer")
    try {
      expect(await shellState(app)).toMatchObject({ active: "viewer", systemCreated: false })
      await page.getByRole("button", { name: "Switch to System" }).click()
      const s = await systemPage(app)
      await expect(s.getByTestId("system-dashboard")).toBeVisible()
      expect(await shellState(app)).toMatchObject({ active: "system", systemCreated: true })
      // Its first paint is the dashboard's outline (index.html), never an empty surface.
      await expectOutlineFirst(s)
      await expect(s.getByTestId("hostname")).toHaveText(hostname())
      await expect(s.getByTestId("live")).toBeVisible({ timeout: 5_000 })
      // Two samples make the first reading of the load: a percentage in the ring.
      await expect(s.getByRole("meter", { name: "Processor load" })).toContainText(/\d+\s?%/, {
        timeout: 5_000,
      })
      await expect(s.getByRole("meter", { name: "Memory in use" })).toContainText(/\d+\s?%/)
      await expect(s.getByTestId("volume").first()).toBeVisible()
      await expect(s.getByTestId("gpu-card")).toBeVisible()
      // System's narrow API: no folders, files or file operations of its own (ADR-0027).
      expect(await s.evaluate(() => Object.keys(window.panelyth!).sort())).toEqual([
        "app",
        "context",
        "dir",
        "find",
        // ADR-0045: the title strip's window buttons and state.
        "frame",
        "fs",
        "library",
        "onEvent",
        "query",
        "settings",
        "sidecar",
        "system",
        "update",
      ])
      await s.screenshot({ path: test.info().outputPath("system-dashboard.png") })
      // Back to the viewer from System's rail.
      await s.getByRole("button", { name: "Switch to Viewer" }).click()
      await expect.poll(async () => (await shellState(app)).active).toBe("viewer")
    } finally {
      await app.close()
    }
  })

  test("searches a volume by name and shows a result in the commander", async () => {
    test.skip(process.platform !== "win32", "a drive letter of a temporary folder (subst)")
    test.setTimeout(90_000)
    const letter = [..."PQRSTUVWXYZ"].find((l) => !existsSync(`${l}:\\`))
    test.skip(!letter, "no free drive letter")
    const root = mkdtempSync(join(tmpdir(), "panelyth-system-"))
    mkdirSync(join(root, "trips", "2024"), { recursive: true })
    writeFileSync(join(root, "trips", "2024", "holiday-beach.txt"), "x")
    writeFileSync(join(root, "trips", "holiday-notes.txt"), "x")
    writeFileSync(join(root, "unrelated.txt"), "x")
    const drive = `${letter}:`
    execFileSync("subst", [drive, root])
    const { app, page } = await launch("viewer")
    try {
      await page.getByRole("button", { name: "Switch to System" }).click()
      const s = await systemPage(app)
      const chip = s.getByRole("button", { name: new RegExp(`^${letter}:`) })
      await expect(chip).toBeVisible({ timeout: 15_000 })
      // Only the temporary drive: turn the others off.
      const chips = s.getByRole("group", { name: "Volumes to search" }).getByRole("button")
      for (const each of await chips.all()) {
        const mine = ((await each.textContent()) ?? "").startsWith(`${letter}:`)
        if ((await each.getAttribute("aria-pressed")) !== String(mine)) await each.click()
      }
      await expect(s.getByRole("button", { pressed: true })).toHaveCount(1)
      await s.getByTestId("search-text").fill("holiday")
      await s.getByTestId("search-text").press("Enter")
      await expect(s.getByTestId("search-status")).toContainText("Found: 2", { timeout: 20_000 })
      const results = s.getByTestId("search-results")
      await expect(results.getByRole("option")).toHaveCount(2)
      await expect(results).not.toContainText("unrelated")
      await s.screenshot({ path: test.info().outputPath("system-search.png") })

      await results.getByText("holiday-beach.txt").dblclick()
      const c = await commanderOf(app)
      await expect.poll(async () => (await shellState(app)).active).toBe("commander")
      await expect(c.locator("[data-cursor=true]").first()).toContainText("holiday-beach", {
        timeout: 15_000,
      })
    } finally {
      await app.close()
      execFileSync("subst", [drive, "/D"])
      removeTemp(root)
    }
  })
})
