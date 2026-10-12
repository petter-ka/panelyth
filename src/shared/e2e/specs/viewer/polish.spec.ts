import { appendFileSync, cpSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { launchApp, repoRoot, showDialogFolder, waitForReady } from "../../launch"

// Stage 08.6: copying pictures to the OS clipboard and additive selection.
// Main records clipboard writes instead of touching the user's clipboard
// (PANELYTH_TEST_SHELL=record): a picture is logged as "WxH" from its PNG.

const tile = (page: Page, name: string) =>
  page.locator(`[data-testid="tile"][aria-label="${name}"]`)

const shellLog = (app: ElectronApplication) =>
  app.evaluate(
    () =>
      (globalThis as { __panelythShellLog?: { action: string; value: string }[] })
        .__panelythShellLog ?? [],
  )

const pictures = async (app: ElectronApplication) =>
  (await shellLog(app)).filter((e) => e.action === "clipboardImage").map((e) => e.value)

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(
    repoRoot,
    "src",
    "shared",
    "bench",
    "results",
    `stage-08.6-${date}-e2e-polish.jsonl`,
  )
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

function imagesCopy(): string {
  const fx = ensureFixture("images-150", {
    files: 0,
    images: { count: 150, width: 1600, height: 1200, pngAlphaEvery: 10, rotatedEvery: 7 },
  })
  const dir = join(mkdtempSync(join(tmpdir(), "panelyth-polish-")), "photos")
  cpSync(fx.root, dir, { recursive: true })
  return dir
}

async function open() {
  const launched = await launchApp({ PANELYTH_TEST_DIALOG_PATH: imagesCopy() })
  await waitForReady(launched.page)
  await showDialogFolder(launched.page)
  await expect(tile(launched.page, "photo_0000.jpg")).toBeVisible({ timeout: 30_000 })
  return launched
}

test.describe("UI polish v2 (Stage 08.6)", () => {
  test("Ctrl+C copies the picture (oriented) from the tiles and the menu", async () => {
    const { app, page } = await open()
    try {
      await page.evaluate(() => {
        const w = window as unknown as { __long: number[] }
        w.__long = []
        new PerformanceObserver((l) =>
          l.getEntries().forEach((e) => w.__long.push(e.duration)),
        ).observe({ type: "longtask" })
      })
      await tile(page, "photo_0000.jpg").click()
      const t0 = Date.now()
      await page.keyboard.press("Control+c")
      await expect.poll(() => pictures(app)).toEqual(["1600x1200"])
      const copyMs = Date.now() - t0
      await expect(page.getByTestId("notice")).toHaveText("Picture copied to the clipboard")

      // EXIF orientation 6: the copy is upright.
      await tile(page, "photo_0006.jpg").click({ button: "right" })
      const menu = page.getByTestId("tile-menu")
      await expect(menu.getByRole("menuitem", { name: "Copy name" })).toBeVisible()
      await menu.getByRole("menuitem", { name: "Copy picture" }).click()
      await expect.poll(() => pictures(app)).toEqual(["1600x1200", "1200x1600"])

      // Several items: files only, no picture.
      await tile(page, "photo_0001.jpg").click()
      await tile(page, "photo_0002.jpg").click({ modifiers: ["Shift"] })
      await page.keyboard.press("Control+c")
      await expect(page.getByTestId("notice")).toContainText("2 items copied")
      expect(await pictures(app)).toHaveLength(2)

      // The full-screen viewer had Ctrl+C and "Copy picture" in its menu too.
      // A double-click now opens the media window (ADR-0033), which has
      // neither; see "Open" in docs/shared/stages/P04-cross-platform.md.

      const longTasks = await page.evaluate(
        () => (window as unknown as { __long: number[] }).__long,
      )
      const result = {
        test: "copy-picture",
        source: "1600x1200 JPEG",
        copyMs,
        longTasksOver50: longTasks.filter((d) => d > 50).length,
      }
      writeResult(result)
      test.info().annotations.push({ type: "metrics", description: JSON.stringify(result) })
      expect(result.longTasksOver50).toBe(0)
    } finally {
      await app.close()
    }
  })

  test("Shift+click and Ctrl+Shift+click add ranges without clearing earlier Ctrl+click picks", async () => {
    const { app, page } = await open()
    try {
      await tile(page, "photo_0001.jpg").click()
      await tile(page, "photo_0004.jpg").click({ modifiers: ["Control"] })
      await tile(page, "photo_0008.jpg").click({ modifiers: ["Control"] })
      await tile(page, "photo_0011.jpg").click({ modifiers: ["Control", "Shift"] })
      const selected = () =>
        page
          .locator('[data-testid="tile"][aria-selected="true"]')
          .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))
      await expect
        .poll(selected)
        .toEqual([
          "photo_0001.jpg",
          "photo_0004.jpg",
          "photo_0008.jpg",
          "photo_0010.jpg",
          "photo_0011.jpg",
        ])
      // overlay_0009.png sorts before the photos, so it is outside the range.
      await expect(page.getByTestId("selection-summary")).toContainText("5 selected")

      // Plain Shift+click from a new Ctrl pick keeps everything picked so far.
      await tile(page, "photo_0020.jpg").click({ modifiers: ["Control"] })
      await tile(page, "photo_0022.jpg").click({ modifiers: ["Shift"] })
      await expect(page.getByTestId("selection-summary")).toContainText("8 selected")
      await expect
        .poll(selected)
        .toEqual([
          "photo_0001.jpg",
          "photo_0004.jpg",
          "photo_0008.jpg",
          "photo_0010.jpg",
          "photo_0011.jpg",
          "photo_0020.jpg",
          "photo_0021.jpg",
          "photo_0022.jpg",
        ])
    } finally {
      await app.close()
    }
  })
})
