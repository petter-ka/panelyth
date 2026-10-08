import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { launchApp, repoRoot, waitForReady } from "../../launch"

const toolbarOpen = (page: Page) =>
  page.getByRole("toolbar", { name: "Navigation" }).getByRole("button", { name: "Open folder…" })

/** Starts recording long tasks, rAF frame gaps and event counts in the renderer. */
async function instrument(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    const longTasks: number[] = []
    const events = { progress: 0, invalidated: 0 }
    const frames = { maxGap: 0, count: 0 }
    // Timed in the page: Playwright's polling back-off would otherwise add
    // hundreds of milliseconds to "time to first rows".
    const timing = { clickAt: 0, firstRowsAt: 0 }
    w.__fv = { longTasks, events, frames, timing }
    document.addEventListener("click", () => (timing.clickAt ||= performance.now()), true)
    new MutationObserver((_, observer) => {
      if (document.querySelector('[data-testid="tile"][data-kind]:not([data-kind="loading"])')) {
        timing.firstRowsAt = performance.now()
        observer.disconnect()
      }
    }).observe(document.body, { childList: true, subtree: true })
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) longTasks.push(e.duration)
    }).observe({ type: "longtask" })
    window.panelyth!.onEvent("index.progress", () => events.progress++)
    window.panelyth!.onEvent("query.invalidated", () => events.invalidated++)
    let last = performance.now()
    const tick = (t: number): void => {
      frames.maxGap = Math.max(frames.maxGap, t - last)
      frames.count++
      last = t
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

interface Measured {
  longTasks: number[]
  events: { progress: number; invalidated: number }
  frames: { maxGap: number; count: number }
  timing: { clickAt: number; firstRowsAt: number }
}

const measured = (page: Page): Promise<Measured> =>
  page.evaluate(() => (window as unknown as { __fv: Measured }).__fv)

test.describe("file index (Stage 01)", () => {
  test("indexes a 100k-file folder in batches without freezing the renderer", async () => {
    test.setTimeout(300_000)
    const fx = ensureFixture("flat-100k", { files: 100_000, nonMediaEvery: 10 })
    const { app, page } = await launchApp({ PANELYTH_TEST_DIALOG_PATH: fx.root })
    try {
      await waitForReady(page)
      await instrument(page)
      const started = Date.now()
      await toolbarOpen(page).click()
      await expect(page.getByTestId("tile-view")).toBeVisible({ timeout: 15_000 })
      await expect(page.getByTestId("folder-summary")).toHaveText(
        /^90,000 items\. 10,000 other files not shown$/,
        { timeout: 120_000 },
      )
      const completeMs = Date.now() - started
      const m = await measured(page)
      const tiles = await page.getByTestId("tile").count()
      const result = {
        fixture: fx.expected,
        firstRowsMs: Math.round(m.timing.firstRowsAt - m.timing.clickAt),
        completeMs,
        longTaskMaxMs: Math.max(0, ...m.longTasks),
        longTasks: m.longTasks.length,
        maxFrameGapMs: Math.round(m.frames.maxGap),
        frames: m.frames.count,
        progressEvents: m.events.progress,
        invalidations: m.events.invalidated,
        mountedTiles: tiles,
      }
      test.info().annotations.push({ type: "metrics", description: JSON.stringify(result) })
      writeResult(result)

      expect(tiles).toBeGreaterThan(0)
      expect(tiles).toBeLessThanOrEqual(300) // rows in view, never the folder
      expect(result.firstRowsMs).toBeLessThan(500)
      expect(m.events.progress).toBeLessThan(200) // batches, not per-file events
      expect(m.events.invalidated).toBeLessThan(100)
      expect(result.longTaskMaxMs).toBeLessThan(100)
      expect(result.maxFrameGapMs).toBeLessThan(250)
    } finally {
      await app.close()
    }
  })

  test("a recursive scan can be stopped and keeps what it found", async () => {
    test.setTimeout(300_000)
    const fx = ensureFixture("tree-50k", { files: 200, depth: 3, fanout: 6, nonMediaEvery: 10 })
    const { app, page } = await launchApp({ PANELYTH_TEST_DIALOG_PATH: fx.root })
    try {
      await waitForReady(page)
      await page.getByLabel("Include subfolders").check()
      await toolbarOpen(page).click()
      await page.getByRole("button", { name: "Stop" }).click()
      await expect(page.getByTestId("folder-summary")).toContainText("Indexing stopped", {
        timeout: 10_000,
      })
      await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test("reopening a folder reuses the existing index immediately", async () => {
    test.setTimeout(180_000)
    const fx = ensureFixture("flat-5k", { files: 5_000, nonMediaEvery: 10 })
    const cache = mkdtempSync(join(tmpdir(), "panelyth-cache-"))
    const env = { PANELYTH_TEST_DIALOG_PATH: fx.root, PANELYTH_CACHE_DIR: cache }

    const first = await launchApp(env)
    try {
      await waitForReady(first.page)
      await toolbarOpen(first.page).click()
      await expect(first.page.getByTestId("folder-summary")).toHaveText(/^4,500 items/, {
        timeout: 60_000,
      })
    } finally {
      await first.app.close()
    }

    const second = await launchApp(env)
    try {
      await waitForReady(second.page)
      const reopened = await second.page.evaluate(async (path) => {
        const dir = await window.panelyth!.dir.open({ path, recursive: false })
        if (!dir.ok) throw new Error(dir.e.message)
        const q = await window.panelyth!.query.open({
          dirId: dir.r.dirId,
          recursive: false,
          sort: [],
          kinds: [],
          search: "",
          exts: [],
          favorite: false,
          minRating: 0,
          tags: [],
        })
        if (!q.ok) throw new Error(q.e.message)
        return { listedBefore: dir.r.listedBefore, totalBeforeRescan: q.r.total }
      }, fx.root)
      expect(reopened).toEqual({ listedBefore: true, totalBeforeRescan: 4_500 })
    } finally {
      await second.app.close()
    }
  })

  test("the open folder updates when files are added", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panelyth-watch-"))
    for (const n of ["a.jpg", "b.png"]) writeFileSync(join(dir, n), "x")
    const { app, page } = await launchApp({ PANELYTH_TEST_DIALOG_PATH: dir })
    try {
      await waitForReady(page)
      await toolbarOpen(page).click()
      await expect(page.getByTestId("folder-summary")).toHaveText("2 items")
      writeFileSync(join(dir, "c.webp"), "x")
      mkdirSync(join(dir, "new folder"))
      await expect(page.getByTestId("folder-summary")).toHaveText("4 items", { timeout: 5_000 })
      await expect(page.getByText("c.webp")).toBeVisible()
    } finally {
      await app.close()
    }
  })

  test("a missing folder shows an actionable error", async () => {
    const missing = join(tmpdir(), "panelyth-does-not-exist-" + Date.now())
    const { app, page } = await launchApp({ PANELYTH_TEST_DIALOG_PATH: missing })
    try {
      await waitForReady(page)
      await toolbarOpen(page).click()
      await expect(page.getByText("This folder no longer exists.")).toBeVisible()
    } finally {
      await app.close()
    }
  })
})

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(repoRoot, "shared", "bench", "results", `stage-03-${date}-e2e-index.jsonl`)
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}
