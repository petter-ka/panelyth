import { execFileSync } from "node:child_process"
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { atEveryLoad, launchApp, repoRoot, showDialogFolder, waitForReady } from "../../launch"

// Stage 06: video posters (ADR-0018), pane playback and media states.

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(
    repoRoot,
    "src",
    "shared",
    "bench",
    "results",
    `stage-06-${date}-e2e-media.jsonl`,
  )
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" })
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const ff = (...args: string[]) =>
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-y", ...args], { timeout: 120_000 })
const src = (w: number, h: number, s: number) => [
  "-f",
  "lavfi",
  "-i",
  `testsrc2=size=${w}x${h}:rate=30:duration=${s}`,
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=440:duration=${s}`,
]

/**
 * Generated once per machine (marker file): 24 playable 1080p H.264 clips,
 * a VP9 WebM, an MPEG-4 Part 2 MKV (Chromium can't decode it) and a
 * damaged MP4.
 */
function videoFixture(): string {
  const root = join(tmpdir(), "panelyth-fixtures", "videos-v1")
  if (existsSync(join(root, ".done"))) return root
  mkdirSync(root, { recursive: true })
  const h264 = join(root, "clip_00.mp4")
  ff(
    ...src(1920, 1080, 8),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    h264,
  )
  for (let i = 1; i < 24; i++) cpSync(h264, join(root, `clip_${String(i).padStart(2, "0")}.mp4`))
  ff(
    ...src(640, 360, 4),
    "-c:v",
    "libvpx-vp9",
    "-deadline",
    "realtime",
    "-c:a",
    "libopus",
    join(root, "web.webm"),
  )
  ff(...src(640, 360, 4), "-c:v", "mpeg4", "-c:a", "libmp3lame", join(root, "legacy.mkv"))
  writeFileSync(join(root, "zz_broken.mp4"), "this is not a video")
  writeFileSync(join(root, ".done"), "")
  return root
}

function copyOfVideos(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "panelyth-media-")), "videos")
  cpSync(videoFixture(), dir, { recursive: true })
  return dir
}

const tileByName = (page: Page, name: string) =>
  page.locator(`[data-testid="tile"][aria-label="${name}"]`)

/** Narrows the folder with the search box so a tile below the fold is mounted. */
async function findTile(page: Page, name: string) {
  await page.locator("#folder-search").fill(name)
  // Wait for the debounced search to commit: it re-queries and resets the
  // selection, so a tile visible before that must not be clicked yet.
  await expect(page.getByTestId("folder-summary")).toContainText(`for “${name}”`, {
    timeout: 60_000,
  })
  const tile = tileByName(page, name)
  await expect(tile).toBeVisible({ timeout: 60_000 })
  return tile
}

/** Video tiles in view, and how many show a decoded poster. */
const posterCounts = (page: Page) =>
  page.evaluate(() => {
    // The damaged file never gets a poster.
    const tiles = [...document.querySelectorAll('[data-testid="tile"][data-kind="video"]')].filter(
      (t) => t.getAttribute("aria-label") !== "zz_broken.mp4",
    )
    const loaded = tiles.filter((t) => {
      const img = t.querySelector("img")
      return !!img && img.complete && img.naturalWidth > 0
    })
    return { videos: tiles.length, posters: loaded.length }
  })

/** From the start of every load: showing a folder reloads the page. */
async function instrument(page: Page): Promise<void> {
  await atEveryLoad(page, () => {
    const w = window as unknown as { __m: { readyItems: number; longTasks: number[] } }
    w.__m = { readyItems: 0, longTasks: [] }
    // The preload's API appears a moment after the document starts.
    const listen = (): void => {
      if (!window.panelyth) return void setTimeout(listen, 0)
      window.panelyth.onEvent("preview.ready", (p) => {
        w.__m.readyItems += p.items.length
      })
    }
    listen()
    new PerformanceObserver((l) =>
      l.getEntries().forEach((e) => w.__m.longTasks.push(e.duration)),
    ).observe({
      type: "longtask",
    })
  })
}
const metrics = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __m: { readyItems: number; longTasks: number[] } }).__m,
  )

/** The frameless media window (ADR-0033). */
async function mediaPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const page = app.windows().find((p) => p.url().includes("media.html"))
    if (page) return page
    if (Date.now() > deadline) throw new Error("media window not found")
    await new Promise((r) => setTimeout(r, 25))
  }
}

test.describe("video playback + media preview (Stage 06)", () => {
  test.skip(!hasFfmpeg(), "ffmpeg/ffprobe not installed")

  test("video posters are generated without blocking, then reused after a restart", async () => {
    test.setTimeout(240_000)
    const videos = copyOfVideos()
    const cache = join(mkdtempSync(join(tmpdir(), "panelyth-media-cache-")), "cache")
    const env = { PANELYTH_TEST_DIALOG_PATH: videos, PANELYTH_CACHE_DIR: cache }

    const first = await launchApp(env)
    let coldMs: number
    let visible: number
    try {
      await waitForReady(first.page)
      await instrument(first.page)
      const t0 = Date.now()
      await showDialogFolder(first.page)
      await expect
        .poll(
          async () => {
            const c = await posterCounts(first.page)
            return c.videos >= 8 && c.posters === c.videos
          },
          { timeout: 120_000, intervals: [50] },
        )
        .toBe(true)
      coldMs = Date.now() - t0
      visible = (await posterCounts(first.page)).posters
      const m = await metrics(first.page)
      expect(m.longTasks.filter((d) => d > 50)).toEqual([])
    } finally {
      await first.app.close()
    }

    const second = await launchApp(env)
    try {
      await waitForReady(second.page)
      await instrument(second.page)
      const t0 = Date.now()
      await showDialogFolder(second.page)
      await expect
        .poll(async () => (await posterCounts(second.page)).posters, {
          timeout: 30_000,
          intervals: [50],
        })
        .toBeGreaterThanOrEqual(visible)
      const warmMs = Date.now() - t0
      // Cached posters come attached to the page: nothing was generated.
      expect((await metrics(second.page)).readyItems).toBe(0)
      const result = {
        test: "posters",
        source: "1080p H.264, 8 s",
        visiblePosters: visible,
        coldAllPostersMs: coldMs,
        warmAllPostersMs: warmMs,
      }
      writeResult(result)
      test.info().annotations.push({ type: "metrics", description: JSON.stringify(result) })
    } finally {
      await second.app.close()
    }
  })

  test("plays in the preview pane from a token URL; seek, volume and browsing stay responsive", async () => {
    test.setTimeout(180_000)
    const { app, page } = await launchApp({ PANELYTH_TEST_DIALOG_PATH: copyOfVideos() })
    try {
      await waitForReady(page)
      await showDialogFolder(page)
      const tile = tileByName(page, "clip_03.mp4")
      await expect(tile).toBeVisible({ timeout: 60_000 })
      await instrument(page)

      // Click → player ready with the original's first frame decodable.
      const t0 = Date.now()
      await tile.click()
      const player = page.getByTestId("video-player")
      await expect(player).toHaveAttribute("data-state", "ready", { timeout: 10_000 })
      const playingId = await page.getByTestId("preview-pane").getAttribute("data-entry-id")
      const video = page.getByTestId("video-element")
      await expect
        .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { intervals: [20] })
        .toBeGreaterThanOrEqual(1)
      const selectToMetadataMs = Date.now() - t0
      expect(await video.evaluate((v: HTMLVideoElement) => v.currentSrc)).toMatch(
        /^panelyth-media:\/\/m\/[0-9a-f]{32}$/,
      )
      await expect(page.getByTestId("video-time")).toHaveText("0:00 / 0:08")
      await expect(page.getByTestId("preview-details")).toContainText("1920 × 1080")

      await page
        .getByRole("toolbar", { name: "Playback controls" })
        .getByRole("button", { name: "Play" })
        .click()
      await expect(player).toHaveAttribute("data-state", "playing")
      await expect
        .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 5_000 })
        .toBeGreaterThan(0.3)

      // Seek (HTTP Range: no full read) and keyboard volume.
      const seekT0 = Date.now()
      await page.getByTestId("video-seek").fill("6")
      await expect
        .poll(() => video.evaluate((v: HTMLVideoElement) => (v.seeking ? -1 : v.currentTime)), {
          intervals: [10],
        })
        .toBeGreaterThanOrEqual(6)
      const seekMs = Date.now() - seekT0
      await player.focus()
      await page.keyboard.press("m")
      expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true)

      // Browsing while it plays: walk the tiles with the keyboard.
      await page.getByTestId("tile-view").focus()
      for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowRight")
      await page.waitForTimeout(400)
      // The pane followed the settled selection; the first video stopped and was released.
      await expect(page.getByTestId("preview-pane")).not.toHaveAttribute(
        "data-entry-id",
        playingId!,
      )
      const m = await metrics(page)
      const result = {
        test: "playback",
        source: "1080p H.264 + AAC",
        selectToMetadataMs,
        seekMs,
        longTasksOver50: m.longTasks.filter((d) => d > 50).length,
      }
      writeResult(result)
      test.info().annotations.push({ type: "metrics", description: JSON.stringify(result) })
      expect(result.longTasksOver50).toBe(0)
    } finally {
      await app.close()
    }
  })

  test("Enter plays a video; full screen is allowed for the player only", async () => {
    test.setTimeout(120_000)
    const { app, page } = await launchApp({ PANELYTH_TEST_DIALOG_PATH: copyOfVideos() })
    try {
      await waitForReady(page)
      await showDialogFolder(page)
      const tile = await findTile(page, "web.webm")
      await tile.click()
      await page.getByTestId("tile-view").press("Enter")
      const player = page.getByTestId("video-player")
      await expect(player).toHaveAttribute("data-state", "playing", { timeout: 10_000 })
      await expect(page.getByTestId("viewer")).toHaveCount(0) // not the image overlay
      await page.getByRole("button", { name: "Full screen" }).click()
      await expect
        .poll(() => page.evaluate(() => document.fullscreenElement?.getAttribute("data-testid")))
        .toBe("video-player")
      // The player binds Esc once it has seen the change itself (its button
      // says so); a key sent in the frame before that is nobody's.
      await expect(page.getByRole("button", { name: "Exit full screen" })).toBeVisible()
      await page.keyboard.press("Escape")
      await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull()
    } finally {
      await app.close()
    }
  })

  test("double-clicking a video tile plays it in the media window; Esc closes it", async () => {
    test.setTimeout(120_000)
    const { app, page } = await launchApp({ PANELYTH_TEST_DIALOG_PATH: copyOfVideos() })
    try {
      await waitForReady(page)
      await showDialogFolder(page)
      const tile = await findTile(page, "web.webm")
      const t0 = Date.now()
      await tile.dblclick()
      // The frameless media window (ADR-0033) took over from the in-page
      // full screen: the file fills a window of its own.
      const media = await mediaPage(app)
      const viewer = media.getByTestId("media-viewer")
      await expect(viewer).toHaveAttribute("aria-label", "Media viewer: web.webm", {
        timeout: 15_000,
      })
      const player = media.getByTestId("video-player")
      await expect(player).toHaveAttribute("data-state", "playing", { timeout: 10_000 })
      const dblclickToPlayingMs = Date.now() - t0
      await expect(page.getByTestId("viewer")).toHaveCount(0)
      // The window closes under the key press, which then has no page to return to.
      await viewer.press("Escape").catch(() => undefined)
      await expect
        .poll(() => app.windows().filter((p) => p.url().includes("media.html")).length)
        .toBe(0)
      await expect(tile).toHaveAttribute("aria-selected", "true")
      writeResult({ test: "dblclick-media-window", dblclickToPlayingMs })
    } finally {
      await app.close()
    }
  })

  test("unsupported and damaged videos say why and offer a way out", async () => {
    test.setTimeout(120_000)
    const { app, page } = await launchApp({ PANELYTH_TEST_DIALOG_PATH: copyOfVideos() })
    try {
      await waitForReady(page)
      await showDialogFolder(page)
      const legacy = await findTile(page, "legacy.mkv")
      await legacy.click()
      const player = page.getByTestId("video-player")
      // Chromium either rejects the file at once or plays its audio with no
      // picture (detected on loadedmetadata); both end in the unsupported state.
      const play = page
        .getByRole("toolbar", { name: "Playback controls" })
        .getByRole("button", { name: "Play" })
      await expect(player).not.toHaveAttribute("data-state", "loading", { timeout: 10_000 })
      if (await play.isEnabled()) await play.click()
      await expect(player).toHaveAttribute("data-problem", "unsupported", { timeout: 10_000 })
      await expect(player).toContainText("MPEG-4 Part 2 video isn't supported")
      await player.getByRole("button", { name: "Open with default app" }).click()
      const log = await app.evaluate(
        () =>
          (globalThis as unknown as { __panelythShellLog: { action: string; value: string }[] })
            .__panelythShellLog,
      )
      expect(log.at(-1)).toMatchObject({ action: "open" })
      expect(log.at(-1)!.value).toMatch(/legacy\.mkv$/)

      await (await findTile(page, "zz_broken.mp4")).click()
      await expect(player).toHaveAttribute("data-problem", "damaged", { timeout: 10_000 })
      await expect(player).toContainText("This video is damaged")
    } finally {
      await app.close()
    }
  })
})
