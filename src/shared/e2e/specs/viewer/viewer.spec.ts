import { appendFileSync, cpSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import {
  expectWithinBudget,
  launchApp,
  repoRoot,
  showDialogFolder,
  waitForReady,
} from "../../launch"

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(
    repoRoot,
    "src",
    "shared",
    "bench",
    "results",
    `stage-04-${date}-e2e-viewer.jsonl`,
  )
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

/** A private copy of a real-image fixture (tests may add files to it). */
function copyOf(name: string, images: { count: number; width: number; height: number }): string {
  const fx = ensureFixture(name, { files: 0, images })
  const dir = join(mkdtempSync(join(tmpdir(), "panelyth-viewer-")), "photos")
  cpSync(fx.root, dir, { recursive: true })
  return dir
}

async function openFolderAt(dir: string) {
  const launched = await launchApp({ PANELYTH_TEST_DIALOG_PATH: dir })
  await waitForReady(launched.page)
  await showDialogFolder(launched.page)
  await expect(
    launched.page.locator('[data-testid="tile"][data-kind="image"]').first(),
  ).toBeVisible({
    timeout: 60_000,
  })
  return launched
}

/** Records long tasks from now on. */
const watchLongTasks = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __lt: number[] }
    w.__lt = []
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__lt.push(e.duration))).observe({
      type: "longtask",
    })
  })
const longTasks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __lt: number[] }).__lt)

/** The frameless media window (ADR-0033): a double-click on a tile opens the file there. */
async function mediaPage(app: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const page = app.windows().find((p) => p.url().includes("media.html"))
    if (page) return page
    if (Date.now() > deadline) throw new Error("media window not found")
    await new Promise((r) => setTimeout(r, 25))
  }
}

const mediaWindows = (app: ElectronApplication): number =>
  app.windows().filter((p) => p.url().includes("media.html")).length

interface Opened {
  media: Page
  viewer: Locator
  image: Locator
}

async function openInMediaWindow(app: ElectronApplication, tile: Locator): Promise<Opened> {
  await tile.dblclick()
  const media = await mediaPage(app)
  const viewer = media.getByTestId("media-viewer")
  await expect(viewer).toBeVisible({ timeout: 15_000 })
  return { media, viewer, image: viewer.getByTestId("image-viewer") }
}

/** ms from pressing `key` until the media window shows a decoded layer of a new entry. */
async function timedStep(media: Page, key: string): Promise<{ ms: number; entry: string }> {
  return media.evaluate(
    (k) =>
      new Promise<{ ms: number; entry: string }>((resolve) => {
        const root = (): HTMLElement =>
          document.querySelector<HTMLElement>('[data-testid="media-viewer"]')!
        const before = root().dataset.entryId
        const t0 = performance.now()
        const check = (): boolean => {
          const layer = root().querySelector<HTMLElement>('[data-testid="image-viewer"]')?.dataset
            .layer
          if (root().dataset.entryId !== before && (layer === "fit" || layer === "original")) {
            resolve({ ms: performance.now() - t0, entry: root().dataset.entryId! })
            return true
          }
          return false
        }
        const mo = new MutationObserver(() => check() && mo.disconnect())
        mo.observe(document.body, { subtree: true, attributes: true, childList: true })
        root().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }))
      }),
    key,
  )
}

test.describe("image viewer (Stage 04; in the media window since ADR-0033)", () => {
  test("opens from a tile, steps through images and closes with Esc", async () => {
    test.setTimeout(180_000)
    const { app, page } = await openFolderAt(
      copyOf("images-150", { count: 150, width: 1600, height: 1200 }),
    )
    try {
      const tile = page.locator('[data-testid="tile"][data-kind="image"]').nth(3)
      const name = await tile.getAttribute("aria-label")
      const { viewer, image } = await openInMediaWindow(app, tile)
      await expect(viewer).toHaveAttribute("aria-label", `Media viewer: ${name}`)
      await expect(image).toHaveAttribute("data-layer", "fit", { timeout: 20_000 })

      const first = await viewer.getAttribute("data-entry-id")
      await viewer.press("ArrowRight")
      await expect(viewer).not.toHaveAttribute("data-entry-id", first!)
      const second = await viewer.getAttribute("data-entry-id")
      await viewer.press("ArrowRight")
      await expect(viewer).not.toHaveAttribute("data-entry-id", second!)
      await expect(viewer).not.toHaveAttribute("aria-label", `Media viewer: ${name}`)
      await viewer.press("ArrowLeft")
      await expect(viewer).toHaveAttribute("data-entry-id", second!)

      // The window closes under the key press, which then has no page to return to.
      await viewer.press("Escape").catch(() => undefined)
      await expect.poll(() => mediaWindows(app)).toBe(0)
      // The folder is as it was left: the tile that was opened is selected.
      await expect(tile).toHaveAttribute("aria-selected", "true")
    } finally {
      await app.close()
    }
  })

  test("changing to the next image", async () => {
    test.setTimeout(240_000)
    const { app, page } = await openFolderAt(
      copyOf("images-12mp-120", { count: 120, width: 4000, height: 3000 }),
    )
    try {
      const { media, image } = await openInMediaWindow(
        app,
        page.locator('[data-testid="tile"][data-kind="image"]').first(),
      )
      await expect(image).toHaveAttribute("data-layer", "fit", { timeout: 30_000 })
      const steps: number[] = []
      for (let i = 0; i < 6; i++) {
        await media.waitForTimeout(700) // like a person looking
        steps.push((await timedStep(media, "ArrowRight")).ms)
      }
      const sorted = [...steps].sort((a, b) => a - b)
      const result = {
        test: "step-latency-media-window",
        source: "12 MP JPEG",
        stepP50Ms: Math.round(sorted[Math.floor(sorted.length / 2)]!),
        stepMaxMs: Math.round(sorted.at(-1)!),
      }
      writeResult(result)
      test.info().annotations.push({ type: "metrics", description: JSON.stringify(result) })
      // The media window asks for the picture it shows and nothing ahead of
      // it, so a step waits for one fit preview (docs/shared/stages/P04,
      // "Open": the 100 ms of a prefetched step is not met there).
      expectWithinBudget(result.stepMaxMs, 1_000, "media window: step to the next 12 MP image")
    } finally {
      await app.close()
    }
  })

  test("1:1 loads the original only when needed", async () => {
    test.setTimeout(240_000)
    const { app, page } = await openFolderAt(
      copyOf("images-12mp-120", { count: 120, width: 4000, height: 3000 }),
    )
    try {
      const { media, viewer, image } = await openInMediaWindow(
        app,
        page.locator('[data-testid="tile"][data-kind="image"]').first(),
      )
      await expect(image).toHaveAttribute("data-layer", "fit", { timeout: 30_000 })
      await expect(media.getByTestId("viewer-original-layer")).toHaveCount(0) // fit needs no original
      await viewer.press("1")
      await expect(image).toHaveAttribute("data-layer", "original", { timeout: 20_000 })
      const natural = await media
        .getByTestId("viewer-original-layer")
        .evaluate((img: HTMLImageElement) => ({ w: img.naturalWidth, src: img.src }))
      expect(natural.w).toBe(4000)
      expect(natural.src).toMatch(/^panelyth-media:\/\/m\/[0-9a-f]{32}$/)
      await expect(image).toHaveAttribute("data-zoom", "1.0000")
    } finally {
      await app.close()
    }
  })

  test("a 48 MP original decodes without freezing the renderer", async () => {
    test.setTimeout(300_000)
    const { app, page } = await openFolderAt(
      copyOf("images-48mp-3", { count: 3, width: 8000, height: 6000 }),
    )
    try {
      const t0 = Date.now()
      const { media, viewer, image } = await openInMediaWindow(
        app,
        page.locator('[data-testid="tile"][data-kind="image"]').first(),
      )
      await expect(image).toHaveAttribute("data-layer", "fit", { timeout: 60_000 })
      const fitMs = Date.now() - t0
      await watchLongTasks(media)
      const t1 = Date.now()
      await viewer.press("1")
      await expect(image).toHaveAttribute("data-layer", "original", { timeout: 60_000 })
      const originalMs = Date.now() - t1
      // Pan around the 100 % image while it is displayed.
      const box = (await image.boundingBox())!
      await media.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await media.mouse.down()
      await media.mouse.move(box.x + 100, box.y + 100, { steps: 20 })
      await media.mouse.up()
      const lt = await longTasks(media)
      const result = {
        test: "large-decode",
        source: "48 MP JPEG",
        openToFitMs: fitMs,
        oneToOneToOriginalMs: originalMs,
        longTasks: lt.length,
        longTaskMaxMs: Math.round(Math.max(0, ...lt)),
      }
      writeResult(result)
      test.info().annotations.push({ type: "metrics", description: JSON.stringify(result) })
      expect(result.longTaskMaxMs).toBeLessThan(100)
    } finally {
      await app.close()
    }
  })

  test("a corrupt image shows an error and navigation continues", async () => {
    test.setTimeout(180_000)
    const dir = copyOf("images-150", { count: 150, width: 1600, height: 1200 })
    writeFileSync(join(dir, "aaa-broken.jpg"), "this is not a jpeg") // sorts first
    const { app, page } = await openFolderAt(dir)
    try {
      const broken = page.locator('[data-testid="tile"][aria-label="aaa-broken.jpg"]')
      await broken.dblclick()
      await expect(
        page.getByTestId("viewer").getByText("This image can't be displayed"),
      ).toBeVisible({ timeout: 20_000 })
      await expect(page.getByRole("button", { name: "Try again" })).toBeVisible()
      await page.getByTestId("viewer").press("ArrowRight")
      await expect(page.getByTestId("viewer-name")).not.toHaveText("aaa-broken.jpg")
      await expect(page.getByTestId("viewer").getByTestId("image-viewer")).toHaveAttribute(
        "data-layer",
        "fit",
        {
          timeout: 20_000,
        },
      )
    } finally {
      await app.close()
    }
  })
})
