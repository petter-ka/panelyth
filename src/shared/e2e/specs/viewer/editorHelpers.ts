// What the editor specs share: fixtures, opening the editor from a tile and
// waiting for frames (Stage 12), and opening a tool through the rail's groups
// (Stage 13).
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { repoRoot, waitForReady } from "../../launch"

/** Appends a line to the stage's e2e results. */
export function writeResult(result: object, stage = 12): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(
    repoRoot,
    "src",
    "shared",
    "bench",
    "results",
    `stage-${stage}-${date}-e2e-editor.jsonl`,
  )
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

/** A little-endian EXIF block: the maker, and orientation 6 (the picture lies on its side). */
function exifSegment(): Buffer {
  const make = Buffer.from("E2E Cam\0", "latin1")
  const tiff = Buffer.alloc(8 + 2 + 2 * 12 + 4 + make.length)
  tiff.write("II", 0, "latin1")
  tiff.writeUInt16LE(42, 2)
  tiff.writeUInt32LE(8, 4)
  tiff.writeUInt16LE(2, 8)
  // Make: ASCII, 8 bytes, at the end.
  tiff.writeUInt16LE(0x010f, 10)
  tiff.writeUInt16LE(2, 12)
  tiff.writeUInt32LE(make.length, 14)
  tiff.writeUInt32LE(38, 18)
  // Orientation: SHORT 6.
  tiff.writeUInt16LE(0x0112, 22)
  tiff.writeUInt16LE(3, 24)
  tiff.writeUInt32LE(1, 26)
  tiff.writeUInt16LE(6, 30)
  make.copy(tiff, 38)
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff])
  const head = Buffer.from([0xff, 0xe1, 0, 0])
  head.writeUInt16BE(body.length + 2, 2)
  return Buffer.concat([head, body])
}

/** A folder with a few real pictures; the first one gets EXIF with orientation 6. */
export function pictures(): { dir: string; first: string } {
  const fx = ensureFixture("editor-640", {
    files: 0,
    images: { count: 6, width: 640, height: 480 },
  })
  const dir = join(mkdtempSync(join(tmpdir(), "panelyth-editor-")), "photos")
  cpSync(fx.root, dir, { recursive: true })
  const first = readdirSync(dir)
    .filter((n) => n.endsWith(".jpg"))
    .sort()[0]!
  const jpeg = readFileSync(join(dir, first))
  writeFileSync(
    join(dir, first),
    Buffer.concat([jpeg.subarray(0, 2), exifSegment(), jpeg.subarray(2)]),
  )
  return { dir, first }
}

/** The viewer opens the folder named in its settings at start. */
export async function openViewerIn(page: Page, dir: string): Promise<void> {
  await waitForReady(page)
  await page.evaluate(async (folder) => {
    await window.panelyth!.library.setSetting("viewer", {
      v: 1,
      startupFolder: "specified",
      specifiedFolder: folder,
    })
  }, dir)
  await page.reload()
  await expect(page.locator('[data-testid="tile"][data-kind="image"]').first()).toBeVisible({
    timeout: 60_000,
  })
}

export const editor = (page: Page) => page.getByTestId("editor")

/** The newest frame is on screen: loaded, and the one the store asked for last. */
export const framePainted = (page: Page) =>
  page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLElement>('[data-testid="editor-canvas"]')
    const img = document.querySelector<HTMLImageElement>('[data-testid="editor-frame"]')
    return (
      !!canvas &&
      !!img &&
      canvas.dataset.frame !== "" &&
      img.src === canvas.dataset.frame &&
      img.complete &&
      img.naturalWidth > 0
    )
  })

/** Runs an action and waits for a frame newer than the one shown before it; returns the ms. */
export async function timedFrame(page: Page, action: () => Promise<void>): Promise<number> {
  const before = await page.getByTestId("editor-canvas").getAttribute("data-frame")
  const t0 = Date.now()
  await action()
  await page.waitForFunction((old) => {
    const canvas = document.querySelector<HTMLElement>('[data-testid="editor-canvas"]')
    const img = document.querySelector<HTMLImageElement>('[data-testid="editor-frame"]')
    return (
      !!canvas &&
      !!img &&
      canvas.dataset.frame !== old &&
      img.src === canvas.dataset.frame &&
      img.complete &&
      img.naturalWidth > 0
    )
  }, before)
  return Date.now() - t0
}

/** Records when frames are painted and long tasks, from now on. */
export const watch = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as {
      __paints: number[]
      __lt: number[]
      __watching?: { disconnect(): void }[]
    }
    // A second watch starts over: the first one's observers stop counting.
    w.__watching?.forEach((o) => o.disconnect())
    const paints: number[] = (w.__paints = [])
    const tasks: number[] = (w.__lt = [])
    const seen = new Set<string>()
    const check = (): void => {
      const img = document.querySelector<HTMLImageElement>('[data-testid="editor-frame"]')
      if (img && img.complete && img.naturalWidth > 0 && !seen.has(img.src)) {
        seen.add(img.src)
        paints.push(performance.now())
      }
    }
    check()
    const frames = new MutationObserver(check)
    frames.observe(document.querySelector('[data-testid="editor-canvas"]')!, {
      subtree: true,
      childList: true,
      attributes: true,
    })
    const long = new PerformanceObserver((l) =>
      l.getEntries().forEach((e) => tasks.push(e.duration)),
    )
    long.observe({ type: "longtask" })
    w.__watching = [frames, long]
  })

export const size = (page: Page) => page.getByTestId("editor-size")

/**
 * Opens the editor from the tile menu. The first frame is measured in the
 * page, from the click on "Edit…" to a painted picture (whatever preview is
 * cached), so the driver's own delays are not counted.
 */
export async function editFirstTile(
  page: Page,
): Promise<{ firstFrameMs: number; readyMs: number }> {
  await page.locator('[data-testid="tile"][data-kind="image"]').first().click({ button: "right" })
  await page.getByTestId("menu-edit").waitFor()
  await page.evaluate(() => {
    const w = window as unknown as { __edit: { click: number; frame: number } }
    w.__edit = { click: 0, frame: 0 }
    document.addEventListener(
      "click",
      (e) => {
        if ((e.target as Element).closest('[data-testid="menu-edit"]'))
          w.__edit.click = performance.now()
      },
      { capture: true, once: true },
    )
    const painted = (): boolean => {
      const img = document.querySelector<HTMLImageElement>(
        '[data-testid="editor-placeholder"], [data-testid="editor-frame"]',
      )
      return !!img && img.complete && img.naturalWidth > 0
    }
    const tick = (): void => {
      if (painted()) w.__edit.frame = performance.now()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const t0 = Date.now()
  await page.getByTestId("menu-edit").click()
  await expect(editor(page)).toHaveAttribute("data-status", "ready", { timeout: 20_000 })
  await framePainted(page)
  const readyMs = Date.now() - t0
  const timing = await page.evaluate(
    () => (window as unknown as { __edit: { click: number; frame: number } }).__edit,
  )
  return { firstFrameMs: Math.round(timing.frame - timing.click), readyMs }
}

export type ToolGroup = "adjust" | "color" | "detail" | "effects" | "retouch" | "geometry" | "looks"

/** Opens a tool as a user does: its group in the rail, then its header in the panel. */
export async function openTool(page: Page, group: ToolGroup, tool: string): Promise<void> {
  await page.locator(`button[data-group="${group}"]`).click()
  const header = page.locator(`button[data-tool="${tool}"]`)
  if ((await header.getAttribute("aria-expanded")) !== "true") await header.click()
  await expect(header).toHaveAttribute("aria-expanded", "true")
}

/**
 * Drags a slider's thumb to the right, one pointer move per 16 ms, and leaves
 * the button down. Each move is far enough to change the value (a move that
 * changes nothing asks for no frame, and the gap between frames would then
 * measure the hand, not the pipeline). Returns the ms the drag took.
 */
export async function dragSlider(page: Page, name: string, steps: number): Promise<number> {
  const slider = page.getByTestId("tool-panel").getByRole("slider", { name })
  const box = (await slider.boundingBox())!
  const values = await slider.evaluate((el: HTMLInputElement) => {
    return (Number(el.max) - Number(el.min)) / (Number(el.step) || 1)
  })
  const stepPx = Math.max(1.5, (box.width / values) * 1.1)
  const from = box.x + box.width * 0.2
  const count = Math.min(steps, Math.floor((box.width * 0.75) / stepPx))
  const y = box.y + box.height / 2
  await page.mouse.move(from, y)
  await page.mouse.down()
  const start = Date.now()
  for (let i = 1; i <= count; i++) {
    await page.mouse.move(from + i * stepPx, y)
    await page.waitForTimeout(16)
  }
  return Date.now() - start
}

/** What `watch` recorded: the paints' 95th percentile gap and the long tasks. */
export async function watched(
  page: Page,
): Promise<{ paints: number; p95: number; longTasks: number[] }> {
  const { paints, longTasks } = await page.evaluate(() => {
    const w = window as unknown as { __paints: number[]; __lt: number[] }
    return { paints: w.__paints, longTasks: w.__lt }
  })
  const gaps = paints
    .slice(1)
    .map((t, i) => t - paints[i]!)
    .sort((a, b) => a - b)
  const p95 = gaps[Math.min(Math.floor(gaps.length * 0.95), gaps.length - 1)] ?? 0
  return { paints: paints.length, p95, longTasks }
}
