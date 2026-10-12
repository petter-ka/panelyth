import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { launchApp, repoRoot, showViewerFolder, waitForReady } from "../../launch"

/** The tile of a subfolder of the folder shown; double-clicking it opens the folder. */
const folderTile = (page: Page, dir: string) =>
  page.locator(`[data-testid="tile"][data-kind="dir"][aria-label="${basename(dir)}"]`)

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
      if (
        document.querySelector('[data-testid="tile"]:is([data-kind="image"], [data-kind="video"])')
      ) {
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
      // The folder is opened from its tile in the folder above it, timed in
      // the page from the click.
      await showViewerFolder(page, dirname(fx.root))
      await expect(folderTile(page, fx.root)).toBeVisible({ timeout: 15_000 })
      await instrument(page)
      const started = Date.now()
      await folderTile(page, fx.root).dblclick()
      await expect(page.getByTestId("folder-name")).toHaveText(basename(fx.root), {
        timeout: 15_000,
      })
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
      await showViewerFolder(page, fx.root)
      await expect(page.getByTestId("tile").first()).toBeVisible({ timeout: 15_000 })
      await page.getByLabel("Include subfolders").check()
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
      await showViewerFolder(first.page, fx.root)
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
      await showViewerFolder(page, dir)
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
      await showViewerFolder(page, missing)
      await expect(page.getByText("This folder no longer exists.")).toBeVisible()
    } finally {
      await app.close()
    }
  })
})

/** Filed under BENCH_STAGE when a stage re-measures the index (P02, P05). */
function writeResult(result: object, stage = process.env.BENCH_STAGE ?? "03"): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(
    repoRoot,
    "src",
    "shared",
    "bench",
    "results",
    `stage-${stage}-${date}-e2e-index.jsonl`,
  )
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}
