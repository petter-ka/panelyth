import { appendFileSync, cpSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { launchApp, repoRoot, waitForReady } from "../../launch"

const toolbarOpen = (page: Page) =>
  page.getByRole("toolbar", { name: "Navigation" }).getByRole("button", { name: "Open folder…" })

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
  await toolbarOpen(launched.page).click()
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

/** ms from pressing `key` until the viewer shows a decoded layer of a new entry. */
async function timedStep(page: Page, key: string): Promise<{ ms: number; entry: string }> {
  return page.evaluate(
    (k) =>
      new Promise<{ ms: number; entry: string }>((resolve) => {
        const viewer = document.querySelector<HTMLElement>('[data-testid="viewer"]')!
        const before = viewer.dataset.entryId
        const t0 = performance.now()
        const check = (): boolean => {
          const v = document.querySelector<HTMLElement>('[data-testid="viewer"]')!
          const layer = document.querySelector<HTMLElement>(
            '[data-testid="viewer"] [data-testid="image-viewer"]',
          )?.dataset.layer
          if (v.dataset.entryId !== before && (layer === "fit" || layer === "original")) {
            resolve({ ms: performance.now() - t0, entry: v.dataset.entryId! })
            return true
          }
          return false
        }
        const mo = new MutationObserver(() => check() && mo.disconnect())
        mo.observe(document.body, { subtree: true, attributes: true, childList: true })
        viewer.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }))
      }),
    key,
  )
}

test.describe("image viewer (Stage 04)", () => {
  test("opens from a tile, steps through images and returns to the selected tile", async () => {
    test.setTimeout(180_000)
    const { app, page } = await openFolderAt(
      copyOf("images-150", { count: 150, width: 1600, height: 1200 }),
    )
    try {
      const tile = page.locator('[data-testid="tile"][data-kind="image"]').nth(3)
      const name = await tile.getAttribute("aria-label")
      await tile.dblclick()
      const viewer = page.getByTestId("viewer")
      await expect(viewer).toBeVisible()
      await expect(page.getByTestId("viewer-name")).toHaveText(name!)
      await expect(page.getByTestId("viewer").getByTestId("image-viewer")).toHaveAttribute(
        "data-layer",
        "fit",
        {
          timeout: 20_000,
        },
      )

      await viewer.press("ArrowRight")
      await viewer.press("ArrowRight")
      const shown = await viewer.getAttribute("data-index")
      await viewer.press("Escape")
      await expect(viewer).toHaveCount(0)
      const selected = page.locator(`#tile-${shown}`)
      await expect(selected).toBeVisible()
      await expect(selected).toHaveAttribute("aria-selected", "true")
      await expect(page.getByTestId("tile-view")).toBeFocused()
    } finally {
      await app.close()
    }
  })

  test("changing to a prefetched image is immediate", async () => {
    test.setTimeout(240_000)
    const { app, page } = await openFolderAt(
      copyOf("images-12mp-120", { count: 120, width: 4000, height: 3000 }),
    )
    try {
      await page.locator('[data-testid="tile"][data-kind="image"]').first().dblclick()
      await expect(page.getByTestId("viewer").getByTestId("image-viewer")).toHaveAttribute(
        "data-layer",
        "fit",
        {
          timeout: 30_000,
        },
      )
      const warm: number[] = []
      for (let i = 0; i < 6; i++) {
        await page.waitForTimeout(700) // give the neighbour prefetch time, like a person looking
        warm.push((await timedStep(page, "ArrowRight")).ms)
      }
      const cold = (await timedStep(page, "End")).ms // not prefetched: generated on demand
      const sorted = [...warm].sort((a, b) => a - b)
      const result = {
        test: "step-latency",
        source: "12 MP JPEG",
        prefetchedP50Ms: Math.round(sorted[Math.floor(sorted.length / 2)]!),
        prefetchedMaxMs: Math.round(sorted.at(-1)!),
        coldJumpMs: Math.round(cold),
      }
      writeResult(result)
      test.info().annotations.push({ type: "metrics", description: JSON.stringify(result) })
      expect(result.prefetchedMaxMs).toBeLessThan(100)
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
      await page.locator('[data-testid="tile"][data-kind="image"]').first().dblclick()
      const iv = page.getByTestId("viewer").getByTestId("image-viewer")
      await expect(iv).toHaveAttribute("data-layer", "fit", { timeout: 30_000 })
      await expect(page.getByTestId("viewer").getByTestId("viewer-original-layer")).toHaveCount(0) // fit needs no original
      await page.getByTestId("viewer").press("1")
      await expect(iv).toHaveAttribute("data-layer", "original", { timeout: 20_000 })
      const natural = await page
        .getByTestId("viewer-original-layer")
        .evaluate((img: HTMLImageElement) => ({ w: img.naturalWidth, src: img.src }))
      expect(natural.w).toBe(4000)
      expect(natural.src).toMatch(/^panelyth-media:\/\/m\/[0-9a-f]{32}$/)
      await expect(page.getByTestId("viewer-zoom")).toHaveText(/^100%$|^\d+%$/)
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
      await watchLongTasks(page)
      const t0 = Date.now()
      await page.locator('[data-testid="tile"][data-kind="image"]').first().dblclick()
      const iv = page.getByTestId("viewer").getByTestId("image-viewer")
      await expect(iv).toHaveAttribute("data-layer", "fit", { timeout: 60_000 })
      const fitMs = Date.now() - t0
      const t1 = Date.now()
      await page.getByTestId("viewer").press("1")
      await expect(iv).toHaveAttribute("data-layer", "original", { timeout: 60_000 })
      const originalMs = Date.now() - t1
      // Pan around the 100 % image while it is displayed.
      const box = (await iv.boundingBox())!
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + 100, box.y + 100, { steps: 20 })
      await page.mouse.up()
      const lt = await longTasks(page)
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
