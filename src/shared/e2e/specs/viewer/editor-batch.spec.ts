// Batch mode of the editor end to end (Stage 16, ADR-0036): a recipe built
// on samples runs over 200 selected pictures into a folder picked through
// main's dialog, with names from a template, while the page stays
// responsive; a running batch is cancelled without leaving partial files;
// originals are replaced through the trash; a batch is undone, and only its
// own files go.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { launchApp } from "../../launch"
import { editor, framePainted, openTool, openViewerIn, writeResult } from "./editorHelpers"

/** The size a JPEG says it has (its first frame header). */
function jpegSize(path: string): { width: number; height: number; whole: boolean } {
  const b = readFileSync(path)
  const whole = b[0] === 0xff && b[1] === 0xd8 && b.at(-2) === 0xff && b.at(-1) === 0xd9
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) break
    const marker = b[i + 1]!
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7), whole }
    }
    i += 2 + b.readUInt16BE(i + 2)
  }
  return { width: 0, height: 0, whole }
}

/** A folder of `count` real 640 × 480 JPEGs, with a video and a folder among them. */
function photos(count: number): { dir: string; names: string[] } {
  const fx = ensureFixture(`batch-${count}`, {
    files: 0,
    images: { count, width: 640, height: 480 },
  })
  const dir = join(mkdtempSync(join(tmpdir(), "panelyth-batch-")), "photos")
  cpSync(fx.root, dir, { recursive: true })
  const names = readdirSync(dir)
    .filter((n) => n.endsWith(".jpg"))
    .sort()
  expect(names).toHaveLength(count)
  writeFileSync(join(dir, "clip.mp4"), "not a picture")
  mkdirSync(join(dir, "album"))
  return { dir, names }
}

const jobs = (page: Page) => page.getByTestId("jobs-panel").getByTestId("job")
/** What a folder shows: the fixture's hidden marker file is not part of it. */
const visible = (dir: string): string[] =>
  readdirSync(dir)
    .filter((n) => !n.startsWith("."))
    .sort()
const partials = (dir: string): string[] =>
  readdirSync(dir).filter((n) => n.includes(".panelyth-partial"))

/** Selects everything in the open folder and opens the batch editor from the batch bar. */
async function editAll(page: Page): Promise<void> {
  await page.locator('[data-testid="tile"][data-kind="image"]').first().click()
  await page.keyboard.press("Control+a")
  await page.getByTestId("batch-bar").getByRole("button", { name: "Edit…" }).click()
  await expect(editor(page)).toHaveAttribute("data-status", "ready", { timeout: 20_000 })
  await expect(editor(page)).toHaveAttribute("data-batch", "true")
  await framePainted(page)
}

/** Long tasks and frame gaps of the page from now on (the tile view behind the jobs panel). */
const instrument = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __lt: number[]; __gaps: number[] }
    w.__lt = []
    w.__gaps = []
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__lt.push(e.duration))).observe({
      type: "longtask",
    })
    let last = performance.now()
    const tick = (now: number): void => {
      w.__gaps.push(now - last)
      last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

test.describe("image editor: batch mode (Stage 16)", () => {
  test("a recipe runs over 200 pictures into a chosen folder while the page stays responsive", async () => {
    test.setTimeout(300_000)
    const { dir, names } = photos(200)
    const out = join(mkdtempSync(join(tmpdir(), "panelyth-batch-out-")), "Web export")
    mkdirSync(out)
    const { app, page } = await launchApp({ PANELYTH_TEST_BATCH_FOLDER: out })
    try {
      await openViewerIn(page, dir)
      await editAll(page)
      // The folder and the video are left out, and said so.
      await expect(page.getByTestId("batch-title")).toHaveText("Edit 200 pictures")
      await expect(page.getByTestId("batch-summary").first()).toContainText("2 skipped")
      await expect(page.getByTestId("batch-strip").getByRole("option")).toHaveCount(12)

      // The free-hand tools are out of a recipe, with the reason.
      await page.locator('button[data-group="retouch"]').click()
      await expect(page.locator('button[data-tool="draw"]')).toBeDisabled()
      await expect(page.getByTestId("tool-single-only").first()).toContainText(
        "One picture at a time",
      )

      // A built-in recipe, then a watermark on top; judged on another sample.
      await page.getByRole("button", { name: "Recipes…" }).click()
      await page
        .getByTestId("batch-recipes")
        .getByRole("button", { name: "Use Thumbnail, 256 px square" })
        .click()
      await expect(page.getByTestId("stack-item")).toHaveCount(1)
      await expect(page.getByTestId("editor-size")).toHaveText("256 × 256")
      await openTool(page, "effects", "watermark")
      await expect(page.getByTestId("stack-item")).toHaveCount(2)
      await framePainted(page)
      const samples = page.getByTestId("batch-strip").getByRole("option")
      await samples.nth(5).click()
      await expect(samples.nth(5)).toHaveAttribute("aria-selected", "true")
      await expect(editor(page)).toHaveAttribute("data-status", "ready")
      await framePainted(page)
      await expect(page.getByTestId("stack-item")).toHaveCount(2)
      await expect(page.getByTestId("editor-size")).toHaveText("256 × 256")

      // The output: a folder from main's dialog (canned here), names from a template.
      await page.getByTestId("batch-output-open").click()
      const output = page.getByTestId("batch-output")
      await output.getByRole("radio", { name: /In one folder/ }).click()
      await expect(output.getByTestId("batch-folder")).toHaveText("Web export")
      await output.getByTestId("batch-template").fill("{n:3}-{name}")
      await expect(output.getByTestId("batch-names")).toContainText(
        `001-${names[0]!.replace(".jpg", "")}.jpg`,
      )
      // The page knows the folder's name, never where it is.
      const leaked = await page.evaluate(
        (paths) => paths.some((p) => document.documentElement.outerHTML.includes(p)),
        [out, out.replaceAll("\\", "/"), "PANELYTH_TEST_BATCH_FOLDER"],
      )
      expect(leaked).toBe(false)

      await instrument(page)
      const t0 = Date.now()
      await output.getByTestId("batch-run-dialog").click()
      // One job; the editor is gone and the tile view is back.
      await expect(editor(page)).toHaveCount(0)
      await expect(jobs(page)).toHaveCount(1)
      await expect(page.getByTestId("jobs-panel")).toContainText("Editing 200 pictures")
      // Scrolling the tile view while the batch runs.
      const view = page.getByTestId("tile-view")
      await view.hover()
      for (let i = 0; i < 12; i++) {
        await page.mouse.wheel(0, i % 2 === 0 ? 600 : -600)
        await page.waitForTimeout(50)
      }
      await expect(jobs(page)).toHaveAttribute("data-state", "completed", { timeout: 180_000 })
      const jobMs = Date.now() - t0
      const seen = await page.evaluate(() => {
        const w = window as unknown as { __lt: number[]; __gaps: number[] }
        return { longTasks: w.__lt, gaps: w.__gaps }
      })

      // 200 files, named by the template, each a whole 256 × 256 JPEG.
      const written = readdirSync(out).sort()
      expect(written).toHaveLength(200)
      expect(written[0]).toBe(`001-${names[0]}`)
      expect(written[199]).toBe(`200-${names[199]}`)
      expect(partials(out)).toEqual([])
      for (const name of [written[0]!, written[57]!, written[199]!]) {
        expect(jpegSize(join(out, name)), name).toEqual({ width: 256, height: 256, whole: true })
      }
      // The originals are as they were; nothing was written beside them.
      expect(visible(dir)).toHaveLength(202)
      expect(jpegSize(join(dir, names[0]!))).toMatchObject({ width: 640, height: 480 })
      await expect(jobs(page)).toContainText("200 of 202")
      await expect(jobs(page)).toContainText("2 skipped")

      const gaps = seen.gaps.slice().sort((a, b) => a - b)
      const result = {
        test: "batch-200",
        pictures: 200,
        jobMs,
        picturesPerSec: Math.round((200 / jobMs) * 10_000) / 10,
        longTaskMaxMs: Math.round(Math.max(0, ...seen.longTasks)),
        longTasksOver50: seen.longTasks.filter((d) => d > 50).length,
        frameGapP95Ms: Math.round(gaps[Math.floor(gaps.length * 0.95)] ?? 0),
      }
      writeResult(result, 16)
      test.info().annotations.push({ type: "metrics", description: JSON.stringify(result) })
      expect(seen.longTasks.filter((d) => d > 50)).toEqual([])
    } finally {
      await app.close()
    }
  })

  test("a running batch is cancelled without partial files", async () => {
    test.setTimeout(300_000)
    const { dir } = photos(200)
    const out = join(mkdtempSync(join(tmpdir(), "panelyth-batch-out-")), "Slow")
    mkdirSync(out)
    const { app, page } = await launchApp({ PANELYTH_TEST_BATCH_FOLDER: out })
    try {
      await openViewerIn(page, dir)
      await editAll(page)
      // A slow recipe, so the cancel lands while pictures are being worked on.
      await openTool(page, "effects", "oil")
      await openTool(page, "detail", "denoise")
      await page.getByTestId("batch-output-open").click()
      const output = page.getByTestId("batch-output")
      await output.getByRole("radio", { name: /In one folder/ }).click()
      await expect(output.getByTestId("batch-folder")).toHaveText("Slow")
      await output.getByRole("combobox", { name: "Format" }).selectOption("png")
      await output.getByTestId("batch-run-dialog").click()
      await expect(jobs(page)).toHaveCount(1)
      // Some pictures are done, most are not.
      await expect.poll(() => readdirSync(out).length, { timeout: 120_000 }).toBeGreaterThan(2)
      const t0 = Date.now()
      await jobs(page).getByRole("button", { name: "Cancel" }).click()
      await expect(jobs(page)).toHaveAttribute("data-state", "cancelled", { timeout: 30_000 })
      const cancelMs = Date.now() - t0
      const left = readdirSync(out)
      expect(partials(out)).toEqual([])
      expect(left.length).toBeGreaterThan(0)
      expect(left.length).toBeLessThan(200)
      // What is there is whole.
      for (const name of left) {
        const b = readFileSync(join(out, name))
        expect(b.subarray(1, 4).toString("latin1"), name).toBe("PNG")
        expect(b.subarray(-8, -4).toString("latin1"), name).toBe("IEND")
      }
      writeResult({ test: "batch-cancel", cancelMs, finishedBeforeCancel: left.length }, 16)
      expect(cancelMs).toBeLessThan(5_000)
    } finally {
      await app.close()
    }
  })

  test("originals are replaced through the trash, and a batch is undone", async () => {
    test.setTimeout(180_000)
    const { dir, names } = photos(6)
    const { app, page } = await launchApp()
    try {
      await openViewerIn(page, dir)
      const before = Object.fromEntries(names.map((n) => [n, statSync(join(dir, n)).size]))

      // Next to the originals: "-edited" copies, which Undo this batch takes away again.
      await editAll(page)
      await expect(page.getByTestId("batch-title")).toHaveText("Edit 6 pictures")
      await openTool(page, "color", "negative")
      await page.keyboard.press("Control+Enter")
      await expect(editor(page)).toHaveCount(0)
      await expect(jobs(page)).toHaveAttribute("data-state", "completed", { timeout: 60_000 })
      const edited = names.map((n) => n.replace(".jpg", "-edited.jpg"))
      for (const name of edited) expect(existsSync(join(dir, name)), name).toBe(true)
      // The results show up in the folder that is open.
      await expect(page.getByTestId("folder-summary")).toHaveText(/^14 items/, { timeout: 30_000 })

      await jobs(page).getByTestId("job-undo-batch").click()
      await expect(jobs(page)).toHaveCount(2)
      await expect(jobs(page).nth(1)).toHaveAttribute("data-state", "completed", {
        timeout: 60_000,
      })
      await expect(page.getByTestId("jobs-panel")).toContainText("Removing 6 edited pictures")
      for (const name of edited) expect(existsSync(join(dir, name)), name).toBe(false)
      for (const name of names) expect(statSync(join(dir, name)).size).toBe(before[name])
      // A batch is undone once.
      await expect(jobs(page).first().getByTestId("job-undo-batch")).toHaveCount(0)
      await expect(page.getByTestId("folder-summary")).toHaveText(/^8 items/, { timeout: 30_000 })

      // Replace: asked first; each original goes to the trash and the result takes its name.
      await page.getByRole("button", { name: "Clear finished" }).click()
      await editAll(page)
      await page.getByRole("button", { name: "Recipes…" }).click()
      await page
        .getByTestId("batch-recipes")
        .getByRole("button", { name: "Use Thumbnail, 256 px square" })
        .click()
      await page.getByTestId("batch-output-open").click()
      const output = page.getByTestId("batch-output")
      await output.getByRole("radio", { name: /Replace the originals/ }).click()
      await expect(output.getByTestId("batch-names")).toContainText(names[0]!)
      await output.getByTestId("batch-run-dialog").click()
      const confirm = page.getByTestId("batch-confirm-replace")
      await expect(page.getByRole("dialog", { name: "Replace 6 pictures?" })).toBeVisible()
      await confirm.getByRole("button", { name: "Replace the originals" }).click()
      await expect(editor(page)).toHaveCount(0)
      await expect(jobs(page)).toHaveAttribute("data-state", "completed", { timeout: 60_000 })
      expect(visible(dir)).toEqual([...names, "album", "clip.mp4"].sort())
      for (const name of names) {
        expect(jpegSize(join(dir, name)), name).toEqual({ width: 256, height: 256, whole: true })
      }
      expect(partials(dir)).toEqual([])
    } finally {
      await app.close()
    }
  })
})
