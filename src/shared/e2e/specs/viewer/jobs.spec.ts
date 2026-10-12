import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { launchApp, repoRoot, showDialogFolder, waitForReady } from "../../launch"

// Stage 07: batch jobs, coalesced progress, user metadata (ADR-0021).

const tileByName = (page: Page, name: string) =>
  page.locator(`[data-testid="tile"][aria-label="${name}"]`)

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(
    repoRoot,
    "src",
    "shared",
    "bench",
    "results",
    `stage-07-${date}-e2e-jobs.jsonl`,
  )
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

const ipcCounts = (app: ElectronApplication): Promise<Record<string, number>> =>
  app.evaluate(
    () =>
      (
        globalThis as { __panelythIpcCounts?: () => Record<string, number> }
      ).__panelythIpcCounts?.() ?? {},
  )

interface Metrics {
  longTasks: number[]
  progress: { t: number; jobId: number; state: string; done: number }[]
}

async function instrument(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __m: Metrics }
    w.__m = { longTasks: [], progress: [] }
    window.panelyth!.onEvent("job.progress", (p) => {
      w.__m.progress.push({ t: performance.now(), jobId: p.jobId, state: p.state, done: p.done })
    })
    new PerformanceObserver((l) =>
      l.getEntries().forEach((e) => w.__m.longTasks.push(e.duration)),
    ).observe({ type: "longtask" })
  })
}
const metrics = (page: Page) => page.evaluate(() => (window as unknown as { __m: Metrics }).__m)

test.describe("batch operations (Stage 07)", () => {
  test("a metadata job over 90,000 selected files stays responsive with coalesced progress", async () => {
    test.setTimeout(300_000)
    const fx = ensureFixture("flat-100k", { files: 100_000, nonMediaEvery: 10 })
    const { app, page } = await launchApp({ PANELYTH_TEST_DIALOG_PATH: fx.root })
    try {
      await waitForReady(page)
      await showDialogFolder(page)
      await expect(page.getByTestId("folder-summary")).toHaveText(/^90,000 items/, {
        timeout: 120_000,
      })
      await instrument(page)
      await page.getByTestId("tile").first().click()
      await page.keyboard.press("Control+a")
      const bar = page.getByTestId("batch-bar")
      await expect(bar).toContainText("90,000 selected")
      const before = await ipcCounts(app)
      const t0 = Date.now()
      await bar.getByRole("button", { name: "Favorite" }).click()
      await expect(page.getByTestId("job")).toHaveAttribute("data-state", "completed", {
        timeout: 120_000,
      })
      const jobMs = Date.now() - t0
      const after = await ipcCounts(app)
      const m = await metrics(page)

      // Coalescing: at most one snapshot per 250 ms per job, plus the forced
      // running and final states.
      const events = m.progress.length
      const span = m.progress.length > 1 ? m.progress.at(-1)!.t - m.progress[0]!.t : 0
      const allowed = Math.ceil(span / 250) + 3
      // Filtering by favorites finds every file.
      await page.getByRole("button", { name: "Favorites" }).click()
      await expect(page.getByTestId("folder-summary")).toHaveText(
        /^90,000 items match the filters/,
        { timeout: 30_000 },
      )
      const result = {
        test: "favorite-90k",
        jobMs,
        progressEvents: events,
        progressSpanMs: Math.round(span),
        jobsStartCalls: (after["jobs.start"] ?? 0) - (before["jobs.start"] ?? 0),
        longTaskMaxMs: Math.round(Math.max(0, ...m.longTasks)),
        longTasksOver50: m.longTasks.filter((d) => d > 50).length,
      }
      writeResult(result)
      test.info().annotations.push({ type: "metrics", description: JSON.stringify(result) })
      expect(result.jobsStartCalls).toBe(1)
      expect(events).toBeLessThanOrEqual(allowed)
      expect(m.progress.at(-1)?.state).toBe("completed")
      expect(result.longTasksOver50).toBe(0)
    } finally {
      await app.close()
    }
  })

  test("copy, rename and delete in a folder; failed items leave the index consistent", async () => {
    test.setTimeout(180_000)
    const dir = join(mkdtempSync(join(tmpdir(), "panelyth-jobs-")), "work")
    const names = Array.from({ length: 12 }, (_, i) => `IMG_${String(i).padStart(2, "0")}.jpg`)
    mkdirSync(dir, { recursive: true })
    for (const n of [...names, "x1.jpg"]) writeFileSync(join(dir, n), "")
    const onDisk = () =>
      readdirSync(dir)
        .filter((n) => !n.startsWith("."))
        .sort()

    const { app, page } = await launchApp({ PANELYTH_TEST_DIALOG_PATH: dir })
    try {
      await waitForReady(page)
      await showDialogFolder(page)
      await expect(page.getByTestId("folder-summary")).toHaveText(/^13 items/, { timeout: 30_000 })

      // Copy everything and paste into the same folder: duplicates keep both.
      await tileByName(page, "IMG_00.jpg").click()
      await page.keyboard.press("Control+a")
      await page.keyboard.press("Control+c")
      await page.keyboard.press("Control+v")
      await expect(page.getByTestId("job").first()).toHaveAttribute("data-state", "completed", {
        timeout: 30_000,
      })
      await expect(page.getByTestId("folder-summary")).toHaveText(/^26 items/, { timeout: 10_000 })
      expect(onDisk()).toContain("IMG_00 (2).jpg")

      // F2 to a taken name: the error is shown and nothing changes.
      await tileByName(page, "IMG_01.jpg").click()
      await page.keyboard.press("F2")
      const input = page.getByTestId("rename-input")
      await input.fill("IMG_02.jpg")
      await input.press("Enter")
      await expect(page.getByRole("alert")).toBeVisible()
      await page.keyboard.press("Escape")
      expect(onDisk()).toContain("IMG_01.jpg")

      // Batch rename where one new name is taken by an unselected file.
      await tileByName(page, "IMG_10.jpg").click()
      await tileByName(page, "IMG_11.jpg").click({ modifiers: ["Control"] })
      await page.keyboard.press("F2")
      await page.getByTestId("pattern-input").fill("x{n}")
      await page.getByRole("button", { name: "Rename 2" }).click()
      const renameJob = page.getByTestId("job").filter({ hasText: "Renaming 2 items" })
      await expect(renameJob).toHaveAttribute("data-state", "completed", { timeout: 30_000 })
      await expect(renameJob).toContainText("1 failed")
      await renameJob.getByRole("button", { name: "Details" }).click()
      await expect(page.getByTestId("job-errors")).toContainText("IMG_10.jpg")
      await page.keyboard.press("Escape")
      expect(onDisk()).toEqual(expect.arrayContaining(["IMG_10.jpg", "x2.jpg", "x1.jpg"]))

      // Shift+Delete the copies (search narrows to them), after confirming.
      await page.locator("#folder-search").fill("(2)")
      await expect(page.getByTestId("folder-summary")).toHaveText(/^13 results for/, {
        timeout: 10_000,
      })
      await page.getByTestId("tile").first().click()
      await page.keyboard.press("Control+a")
      await page.keyboard.press("Shift+Delete")
      await page.getByTestId("confirm-delete").click()
      await expect(page.getByTestId("folder-summary")).toHaveText(/^0 results for/, {
        timeout: 30_000,
      })
      await page.locator("#folder-search").fill("")

      // The index matches the disk after successes and failures alike.
      await expect(page.getByTestId("folder-summary")).toHaveText(/^13 items/, { timeout: 10_000 })
      const tiles = await page
        .getByTestId("tile")
        .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? "").sort())
      expect(tiles).toEqual(onDisk())
      writeResult({ test: "file-ops", items: tiles.length, consistent: true })
    } finally {
      await app.close()
    }
  })
})
