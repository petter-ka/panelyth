import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { launchApp, repoRoot, showViewerFolder } from "../../launch"

// Mirrors src/viewer/renderer/src/features/tiles/layout.ts (docs/viewer/stages/03-tile-view.md).
const METRICS = {
  small: { tile: 120, gap: 8 },
  medium: { tile: 180, gap: 12 },
  large: { tile: 260, gap: 16 },
}
const perRowFor = (width: number, size: keyof typeof METRICS): number => {
  const { tile, gap } = METRICS[size]
  return Math.max(1, Math.floor((width - 32 + gap) / (tile + gap)))
}

/** Resizes the window; with `page`, returns once the page has the new width. */
async function setWindow(
  app: ElectronApplication,
  width: number,
  height: number,
  page?: Page,
): Promise<void> {
  // The OS may clamp the window to the screen: wait for the size it got.
  const actual = await app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows()[0]!
      win.unmaximize()
      win.setContentSize(w, h)
      return win.getContentSize()[0]!
    },
    [width, height] as const,
  )
  await page?.waitForFunction((w) => window.innerWidth === w, actual)
}

const viewState = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="tile-view"]')!
    return {
      width: el.clientWidth,
      perRow: Number(el.dataset.perRow),
      size: el.dataset.tileSize as "small" | "medium" | "large",
      tiles: document.querySelectorAll('[data-testid="tile"]').length,
      boxWidth: document.querySelector<HTMLElement>("[data-thumb-box]")?.style.width ?? "",
    }
  })

const ipcCounts = (app: ElectronApplication): Promise<Record<string, number>> =>
  app.evaluate(
    () =>
      (
        globalThis as { __panelythIpcCounts?: () => Record<string, number> }
      ).__panelythIpcCounts?.() ?? {},
  )

/**
 * The viewer opens the folder named in its settings at start (the toolbar has
 * had no "Open folder…" button since the sidebar took over navigation).
 */
async function openFolderAt(dir: string, size?: "small" | "medium" | "large") {
  const launched = await launchApp({ PANELYTH_TEST_DIALOG_PATH: dir })
  const { page } = launched
  await showViewerFolder(page, dir)
  if (size)
    await page
      .getByRole("button", { name: `${size[0]!.toUpperCase()}${size.slice(1)} tiles` })
      .click()
  await expect(page.getByTestId("tile").first()).toBeVisible({ timeout: 30_000 })
  return launched
}

interface ScrollResult {
  frames: number
  maxFrameGapMs: number
  p95FrameMs: number
  longTasks: number
  longTaskMaxMs: number
  maxMountedTiles: number
  scrolledPx: number
}

/** Scrolls the tile view in the page: a fast fling phase, then a slow phase. */
async function scrollStress(
  page: Page,
  fastMs: number,
  fastPxPerFrame: number,
  slowMs: number,
): Promise<ScrollResult> {
  return page.evaluate(
    async ({ fastMs, fastPxPerFrame, slowMs }) => {
      const el = document.querySelector<HTMLElement>('[data-testid="tile-view"]')!
      const long: number[] = []
      const po = new PerformanceObserver((l) =>
        l.getEntries().forEach((e) => long.push(e.duration)),
      )
      po.observe({ type: "longtask" })
      const gaps: number[] = []
      let maxTiles = 0
      const run = (ms: number, px: number) =>
        new Promise<void>((resolve) => {
          const start = performance.now()
          let last = start
          const tick = (t: number) => {
            gaps.push(t - last)
            last = t
            maxTiles = Math.max(maxTiles, document.querySelectorAll('[data-testid="tile"]').length)
            el.scrollTop += px
            if (t - start < ms) requestAnimationFrame(tick)
            else resolve()
          }
          requestAnimationFrame(tick)
        })
      const top = el.scrollTop
      await run(fastMs, fastPxPerFrame)
      await run(slowMs, 12)
      await new Promise((r) => setTimeout(r, 300))
      po.disconnect()
      const sorted = gaps.slice(1).sort((a, b) => a - b)
      return {
        frames: sorted.length,
        maxFrameGapMs: Math.round(sorted.at(-1) ?? 0),
        p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
        longTasks: long.length,
        longTaskMaxMs: Math.round(Math.max(0, ...long)),
        maxMountedTiles: maxTiles,
        scrolledPx: Math.round(el.scrollTop - top),
      }
    },
    { fastMs, fastPxPerFrame, slowMs },
  )
}

/** Filed under BENCH_STAGE when a stage re-measures the tile view (P01, P05). */
function writeResult(result: object, stage = process.env.BENCH_STAGE ?? "03"): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(
    repoRoot,
    "src",
    "shared",
    "bench",
    "results",
    `stage-${stage}-${date}-e2e-tiles.jsonl`,
  )
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

function imagesCopy(): string {
  const fx = ensureFixture("images-150", {
    files: 0,
    images: { count: 150, width: 1600, height: 1200, pngAlphaEvery: 10, rotatedEvery: 7 },
  })
  const dir = join(mkdtempSync(join(tmpdir(), "panelyth-tiles-")), "photos")
  cpSync(fx.root, dir, { recursive: true })
  return dir
}

const COVER_FOLDERS = 2_000
const coverFolderName = (i: number) => `album ${String(i).padStart(4, "0")}`
/** Every 5th folder holds no media and must keep the folder symbol. */
const coverFolderEmpty = (i: number) => i % 5 === 4

/**
 * A folder of 2,000 subfolders (Stage 08.6): six real images in each, hard
 * linked from one small set so the tree costs little disk; every 5th folder
 * has only a text file. Built once per machine, like ensureFixture.
 */
function ensureFolderFixture(): string {
  const src = ensureFixture("cover-src-6", {
    files: 0,
    images: { count: 6, width: 1600, height: 1200 },
  })
  const root = join(tmpdir(), "panelyth-fixtures", `folders-${COVER_FOLDERS}`)
  const images = readdirSync(src.root).filter((f) => !f.startsWith("."))
  // The tree is checked, not a marker: a cleaner of temporary files removed
  // the folders with pictures and left the marker and the rest (Stage P04).
  const withMedia = Array.from({ length: COVER_FOLDERS }, (_, i) => i).filter(
    (i) => !coverFolderEmpty(i),
  )
  const whole = (i: number): boolean =>
    images.every((f) => existsSync(join(root, coverFolderName(i), f)))
  if (
    existsSync(root) &&
    readdirSync(root).filter((f) => !f.startsWith(".")).length === COVER_FOLDERS &&
    whole(withMedia[0]!) &&
    whole(withMedia[withMedia.length - 1]!)
  )
    return root
  rmSync(root, { recursive: true, force: true })
  for (let i = 0; i < COVER_FOLDERS; i++) {
    const dir = join(root, coverFolderName(i))
    mkdirSync(dir, { recursive: true })
    if (coverFolderEmpty(i)) {
      writeFileSync(join(dir, "notes.txt"), "no media here")
      continue
    }
    for (const f of images) {
      try {
        linkSync(join(src.root, f), join(dir, f))
      } catch {
        copyFileSync(join(src.root, f), join(dir, f))
      }
    }
  }
  return root
}

test.describe("tile view (Stage 03)", () => {
  test("wider windows fit more tiles per row; tiles keep their size", async () => {
    const { app, page } = await openFolderAt(imagesCopy())
    try {
      const seen: { window: number; width: number; perRow: number }[] = []
      for (const w of [1280, 1920, 2560]) {
        await setWindow(app, w, 1000, page)
        await expect
          .poll(async () => {
            const s = await viewState(page)
            return s.perRow === perRowFor(s.width, s.size)
          })
          .toBe(true)
        const s = await viewState(page)
        expect(s.boxWidth).toBe("180px") // fixed, never stretched
        seen.push({ window: w, width: s.width, perRow: s.perRow })
      }
      // More width, more tiles (the OS may clamp the largest window to the screen).
      for (let i = 1; i < seen.length; i++) {
        if (seen[i]!.width > seen[i - 1]!.width)
          expect(seen[i]!.perRow).toBeGreaterThanOrEqual(seen[i - 1]!.perRow)
      }
      expect(seen.at(-1)!.perRow).toBeGreaterThan(seen[0]!.perRow)
      writeResult({ test: "responsive", seen })
    } finally {
      await app.close()
    }
  })

  for (const [size, width] of [
    ["medium", 1920],
    ["small", 2560],
  ] as const) {
    test(`scrolling 100k items (${size} tiles, ${width} px): bounded DOM, no long tasks, bounded thumbnail work`, async () => {
      test.setTimeout(300_000)
      const fx = ensureFixture("flat-100k", { files: 100_000, nonMediaEvery: 10 })
      const { app, page } = await openFolderAt(fx.root, size)
      try {
        await setWindow(app, width, 1100)
        await expect(page.getByTestId("folder-summary")).toHaveText(/^90,000 items/, {
          timeout: 120_000,
        })
        await page.waitForTimeout(500)
        const before = await ipcCounts(app)
        const scroll = await scrollStress(page, 3000, 400, 2000)
        const after = await ipcCounts(app)
        const delta = (m: string) => (after[m] ?? 0) - (before[m] ?? 0)
        const s = await viewState(page)
        const result = {
          test: "scroll-100k",
          size,
          windowWidth: width,
          contentWidth: s.width,
          perRow: s.perRow,
          ...scroll,
          ensureCalls: delta("preview.ensure"),
          pageCalls: delta("query.page"),
        }
        writeResult(result)
        test.info().annotations.push({ type: "metrics", description: JSON.stringify(result) })

        expect(scroll.scrolledPx).toBeGreaterThan(100_000)
        expect(scroll.maxMountedTiles).toBeLessThanOrEqual(300)
        expect(scroll.longTaskMaxMs).toBeLessThan(50)
        // Thumbnails are requested only when the range settles, so a 5 s scroll
        // over ~100k px costs a handful of ensure calls, not one per row.
        expect(result.ensureCalls).toBeLessThanOrEqual(10)
      } finally {
        await app.close()
      }
    })
  }

  test("scrolling a 10k folder stays within the same bounds", async () => {
    test.setTimeout(180_000)
    const fx = ensureFixture("flat-10k", { files: 10_000, nonMediaEvery: 10 })
    const { app, page } = await openFolderAt(fx.root)
    try {
      await setWindow(app, 1920, 1100)
      await expect(page.getByTestId("folder-summary")).toHaveText(/^9,000 items/, {
        timeout: 60_000,
      })
      const scroll = await scrollStress(page, 2000, 300, 1000)
      writeResult({ test: "scroll-10k", ...scroll })
      expect(scroll.maxMountedTiles).toBeLessThanOrEqual(300)
      expect(scroll.longTaskMaxMs).toBeLessThan(50)
    } finally {
      await app.close()
    }
  })

  test("first thumbnails are requested right away, not after a scroll-settle delay", async () => {
    // Regression guard: a no-op programmatic scroll on mount (scroll reset,
    // scroll anchoring) used to flag isScrolling and hold the first request
    // for ~230 ms. Timed inside the page from the click that opens the folder
    // (its tile in the parent folder).
    const launched = await openFolderAt(dirname(imagesCopy()))
    try {
      await launched.page.evaluate(() => {
        const t = { click: 0, mounted: 0, ready: 0 }
        ;(window as unknown as { __t: typeof t }).__t = t
        document.addEventListener("click", () => (t.click ||= performance.now()), true)
        window.panelyth!.onEvent("preview.ready", () => (t.ready ||= performance.now()))
        new MutationObserver(() => {
          if (!t.mounted && document.querySelector('[data-testid="tile"][data-kind="image"]'))
            t.mounted = performance.now()
        }).observe(document.body, { childList: true, subtree: true, attributes: true })
      })
      await launched.page.locator('[data-testid="tile"][data-kind="dir"]').dblclick()
      await launched.page.waitForFunction(
        () => (window as unknown as { __t: { ready: number } }).__t.ready > 0,
        null,
        {
          timeout: 30_000,
        },
      )
      const t = await launched.page.evaluate(
        () => (window as unknown as { __t: { click: number; mounted: number; ready: number } }).__t,
      )
      const result = {
        test: "first-thumb",
        tilesMountedMs: Math.round(t.mounted - t.click),
        firstReadyMs: Math.round(t.ready - t.click),
        mountToReadyMs: Math.round(t.ready - t.mounted),
      }
      writeResult(result)
      // Generation of the first 1600x1200 images plus the 50 ms event batch.
      expect(result.mountToReadyMs).toBeLessThan(200)
    } finally {
      await launched.app.close()
    }
  })

  test("scrolling 2,000 folder tiles with covers (Stage 08.6): bounded DOM and cover requests", async () => {
    test.setTimeout(300_000)
    const { app, page } = await openFolderAt(ensureFolderFixture())
    try {
      await setWindow(app, 1920, 1100)
      await expect(page.getByTestId("folder-summary")).toHaveText(/^2,000 items/, {
        timeout: 60_000,
      })
      // Covers fill in at the top; folders without media keep the symbol.
      const tile = (i: number) =>
        page.locator(`[data-testid="tile"][aria-label="${coverFolderName(i)}"]`)
      await expect(tile(0).getByTestId("folder-cover")).toHaveAttribute("data-covers", "4", {
        timeout: 30_000,
      })
      await expect(tile(0).locator("img")).toHaveCount(4)
      await expect(tile(4)).toHaveAttribute("data-kind", "dir")
      await expect(tile(4).getByTestId("folder-cover")).toHaveCount(0)
      await page.waitForTimeout(500)

      const before = await ipcCounts(app)
      const scroll = await scrollStress(page, 3000, 400, 2000)
      const afterScroll = await ipcCounts(app)
      // Back to the top: those folders are known, so no new request.
      await page.evaluate(() => {
        document.querySelector<HTMLElement>('[data-testid="tile-view"]')!.scrollTop = 0
      })
      await page.waitForTimeout(800)
      await expect(tile(0).getByTestId("folder-cover")).toHaveAttribute("data-covers", "4")
      const afterReturn = await ipcCounts(app)
      const delta = (a: Record<string, number>, b: Record<string, number>, m: string) =>
        (a[m] ?? 0) - (b[m] ?? 0)
      const s = await viewState(page)
      const result = {
        test: "scroll-folders-2k",
        perRow: s.perRow,
        ...scroll,
        coverCalls: delta(afterScroll, before, "folder.covers"),
        coverCallsOnReturn: delta(afterReturn, afterScroll, "folder.covers"),
        ensureCalls: delta(afterScroll, before, "preview.ensure"),
        pageCalls: delta(afterScroll, before, "query.page"),
      }
      writeResult(result, "08.6")
      test.info().annotations.push({ type: "metrics", description: JSON.stringify(result) })

      expect(scroll.scrolledPx).toBeGreaterThan(30_000)
      expect(scroll.maxMountedTiles).toBeLessThanOrEqual(300)
      expect(scroll.longTaskMaxMs).toBeLessThan(50)
      // One folder.covers call per settled range, never one per tile or row.
      expect(result.coverCalls).toBeLessThanOrEqual(10)
      expect(result.coverCallsOnReturn).toBe(0)
      expect(result.ensureCalls).toBe(0)
    } finally {
      await app.close()
    }
  })

  test("keyboard moves by tile and by row, and End reaches the last tile", async () => {
    const { app, page } = await openFolderAt(imagesCopy())
    try {
      const view = page.getByTestId("tile-view")
      await page.getByTestId("tile").first().click()
      const { perRow } = await viewState(page)
      await view.press("ArrowRight")
      await expect(view).toHaveAttribute("aria-activedescendant", "tile-1")
      await view.press("ArrowDown")
      await expect(view).toHaveAttribute("aria-activedescendant", `tile-${1 + perRow}`)
      await view.press("End")
      await expect(view).toHaveAttribute("aria-activedescendant", "tile-149")
      await expect(page.locator("#tile-149")).toBeVisible()
      await expect(page.locator("#tile-149")).toHaveAttribute("aria-selected", "true")
    } finally {
      await app.close()
    }
  })

  test("double-clicking a folder tile opens it", async () => {
    test.setTimeout(180_000)
    const fx = ensureFixture("tree-50k", { files: 200, depth: 3, fanout: 6, nonMediaEvery: 10 })
    const { app, page } = await openFolderAt(fx.root)
    try {
      const folder = page.locator('[data-testid="tile"][aria-label="folder 1"]')
      await expect(folder).toHaveAttribute("data-kind", "dir")
      await folder.dblclick()
      await expect(page.getByTestId("folder-name")).toHaveText("folder 1")
    } finally {
      await app.close()
    }
  })

  test("the tile size control changes tiles and is remembered", async () => {
    const dir = imagesCopy()
    const profile = mkdtempSync(join(tmpdir(), "panelyth-profile-"))
    const first = await launchApp({
      PANELYTH_TEST_DIALOG_PATH: dir,
      PANELYTH_USER_DATA_DIR: profile,
    })
    try {
      await showViewerFolder(first.page, dir)
      await first.page.getByRole("button", { name: "Large tiles" }).click()
      await expect(first.page.getByTestId("tile-view")).toHaveAttribute("data-tile-size", "large")
      expect((await viewState(first.page)).boxWidth).toBe("260px")
    } finally {
      await first.app.close()
    }
    const second = await launchApp({
      PANELYTH_TEST_DIALOG_PATH: dir,
      PANELYTH_USER_DATA_DIR: profile,
    })
    try {
      await showViewerFolder(second.page, dir)
      await expect(second.page.getByTestId("tile-view")).toHaveAttribute("data-tile-size", "large")
    } finally {
      await second.app.close()
    }
  })
})
