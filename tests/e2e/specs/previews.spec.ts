import { appendFileSync, cpSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { ensureFixture } from "../fixtures"
import { launchApp, repoRoot, waitForReady } from "../launch"

const IMAGES = { count: 150, width: 1600, height: 1200, pngAlphaEvery: 10, rotatedEvery: 7 }
/** Minimum image tiles in view at the default window size (1440×900, medium tiles). */
const MIN_VISIBLE = 8

const toolbarOpen = (page: Page) =>
  page.getByRole("toolbar", { name: "Navigation" }).getByRole("button", { name: "Open folder…" })

/** Mounted image tiles, and how many of them show a decoded fastview-thumb: image. */
const thumbCounts = (page: Page): Promise<{ images: number; loaded: number }> =>
  page.evaluate(() => {
    const tiles = [...document.querySelectorAll('[data-testid="tile"][data-kind="image"]')]
    const loaded = tiles.filter((t) => {
      const img = t.querySelector("img")
      return (
        !!img && img.complete && img.naturalWidth > 0 && img.src.startsWith("fastview-thumb://")
      )
    })
    return { images: tiles.length, loaded: loaded.length }
  })

async function waitForThumbs(page: Page, n: number, timeout = 60_000): Promise<void> {
  await expect
    .poll(async () => (await thumbCounts(page)).loaded, { timeout, intervals: [50] })
    .toBeGreaterThanOrEqual(n)
}

/** Waits until every mounted image tile shows its thumbnail; returns how many. */
async function waitForAllThumbs(page: Page, timeout = 60_000): Promise<number> {
  await expect
    .poll(
      async () => {
        const c = await thumbCounts(page)
        return c.images >= MIN_VISIBLE && c.loaded === c.images
      },
      { timeout, intervals: [50] },
    )
    .toBe(true)
  return (await thumbCounts(page)).images
}

/** Counts preview.ready events and long tasks in the renderer. */
async function instrument(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __pv: { events: number; items: number; longTasks: number[] } }
    w.__pv = { events: 0, items: 0, longTasks: [] }
    window.fastview!.onEvent("preview.ready", (p) => {
      w.__pv.events++
      w.__pv.items += p.items.length
    })
    new PerformanceObserver((l) =>
      l.getEntries().forEach((e) => w.__pv.longTasks.push(e.duration)),
    ).observe({ type: "longtask" })
  })
}

const pv = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __pv: { events: number; items: number; longTasks: number[] } }).__pv,
  )

/** The media folder is copied per test so tests can modify it. */
function freshCopy(): string {
  const fx = ensureFixture("images-150", { files: 0, images: IMAGES })
  const dir = join(mkdtempSync(join(tmpdir(), "fastview-imgs-")), "photos")
  cpSync(fx.root, dir, { recursive: true })
  return dir
}

test.describe("thumbnail pipeline (Stage 02, on the Stage 03 tile view)", () => {
  test("visible thumbnails appear incrementally, then come from the cache after a restart", async () => {
    test.setTimeout(240_000)
    const photos = freshCopy()
    const cache = mkdtempSync(join(tmpdir(), "fastview-cache-"))
    const env = { FASTVIEW_TEST_DIALOG_PATH: photos, FASTVIEW_CACHE_DIR: cache }

    const first = await launchApp(env)
    let cold: Record<string, number>
    try {
      await waitForReady(first.page)
      await instrument(first.page)
      const t0 = Date.now()
      await toolbarOpen(first.page).click()
      await waitForThumbs(first.page, 1)
      const firstThumbMs = Date.now() - t0
      const visible = await waitForAllThumbs(first.page)
      const allMs = Date.now() - t0
      const m = await pv(first.page)
      cold = {
        firstThumbMs,
        mountedImageTiles: visible,
        allMountedThumbsMs: allMs,
        readyEvents: m.events,
        readyItems: m.items,
        longTaskMaxMs: Math.max(0, ...m.longTasks),
      }
      // Incremental, batched, and only for the view and its neighbours.
      expect(m.events).toBeLessThan(m.items)
      expect(m.items).toBeGreaterThanOrEqual(visible)
      expect(m.items).toBeLessThan(IMAGES.count)
      expect(cold.longTaskMaxMs).toBeLessThan(100)
    } finally {
      await first.app.close()
    }

    const second = await launchApp(env)
    try {
      await waitForReady(second.page)
      await instrument(second.page)
      const t0 = Date.now()
      await toolbarOpen(second.page).click()
      await waitForAllThumbs(second.page, 15_000)
      const warmMs = Date.now() - t0
      const m = await pv(second.page)
      // Every visible thumbnail came with the page: nothing was generated.
      expect(m.items).toBe(0)
      writeResult({ ...cold, warmAllMountedThumbsMs: warmMs, warmReadyItems: m.items })
    } finally {
      await second.app.close()
    }
  })

  test("a modified image gets a new thumbnail", async () => {
    test.setTimeout(180_000)
    const photos = freshCopy()
    const { app, page } = await launchApp({ FASTVIEW_TEST_DIALOG_PATH: photos })
    try {
      await waitForReady(page)
      await toolbarOpen(page).click()
      await waitForAllThumbs(page)
      // Replace a visible JPEG in place with the bytes of another JPEG: same
      // name, same id, new size/mtime. The watcher re-lists, the page
      // refetches, and the tile must show a new thumbnail.
      const target = (await page
        .locator('[data-testid="tile"][data-kind="image"][aria-label$=".jpg"]')
        .first()
        .getAttribute("aria-label"))!
      const source = readdirSync(photos)
        .filter((n) => n.endsWith(".jpg") && n !== target)
        .at(-1)!
      const tile = page.locator(`[data-testid="tile"][aria-label="${target}"]`)
      const before = await tile.locator("img").getAttribute("src")
      cpSync(join(photos, source), join(photos, target))
      await expect
        .poll(() => tile.locator("img").getAttribute("src"), { timeout: 20_000 })
        .not.toBe(before)
      await waitForAllThumbs(page, 20_000)
    } finally {
      await app.close()
    }
  })

  test("a corrupt cache file is regenerated", async () => {
    test.setTimeout(180_000)
    const photos = freshCopy()
    const cache = mkdtempSync(join(tmpdir(), "fastview-cache-"))
    const env = { FASTVIEW_TEST_DIALOG_PATH: photos, FASTVIEW_CACHE_DIR: cache }

    const first = await launchApp(env)
    let src: string
    try {
      await waitForReady(first.page)
      await toolbarOpen(first.page).click()
      await waitForAllThumbs(first.page)
      src = (await first.page.locator('[data-testid="tile"] img').first().getAttribute("src"))!
    } finally {
      await first.app.close()
    }

    // Overwrite the cached file with garbage while the app is closed.
    const key = /t\/([0-9a-f]{64})\.(jpg|png)$/.exec(src)!
    const file = join(
      cache,
      "v1",
      "thumbnails",
      key[1]!.slice(0, 2),
      key[1]!.slice(2, 4),
      `${key[1]}.${key[2]}`,
    )
    writeFileSync(file, "not an image")

    const second = await launchApp(env)
    try {
      await waitForReady(second.page)
      await toolbarOpen(second.page).click()
      // The broken <img> reports back, the sidecar regenerates, all tiles load.
      await waitForAllThumbs(second.page, 30_000)
    } finally {
      await second.app.close()
    }
  })

  test("a missing or foreign thumbnail URL is refused by the protocol", async () => {
    const { app, page } = await launchApp()
    try {
      await waitForReady(page)
      const statuses = await page.evaluate(async () => {
        const probe = (src: string) =>
          new Promise<string>((resolve) => {
            const img = new Image()
            img.onload = () => resolve("loaded")
            img.onerror = () => resolve("error")
            img.src = src
          })
        return Promise.all([
          probe(`fastview-thumb://t/${"0".repeat(64)}.jpg`),
          probe("fastview-thumb://t/../../../Windows/win.ini"),
          probe("fastview-thumb://t/abc.jpg"),
        ])
      })
      expect(statuses).toEqual(["error", "error", "error"])
    } finally {
      await app.close()
    }
  })
})

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(repoRoot, "bench", "results", `stage-03-${date}-e2e-previews.jsonl`)
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}
