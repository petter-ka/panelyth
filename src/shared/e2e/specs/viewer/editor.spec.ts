// The image editor end to end (Stage 12, ADR-0035): open from a tile, edit
// with the geometry tools, undo and redo, the info panels, save a copy and
// check the file on disk, the prompt for unsaved changes, and the hand-off
// from the commander's media overlay.
//
// Replace-through-trash is confirmed up to its dialog and cancelled: an e2e
// run leaves the recycle bin alone (the Go tests cover the replace path and
// its failures with an injected trash).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import {
  commanderEnv,
  commanderPage,
  expectWithinBudget,
  launchApp,
  shellState,
  waitForReady,
} from "../../launch"
import { goTo } from "../commander/helpers"
import {
  editFirstTile,
  editor,
  framePainted,
  openTool,
  openViewerIn,
  pictures,
  size,
  timedFrame,
  watch,
  writeResult,
} from "./editorHelpers"

/** Width, height and EXIF facts of a JPEG on disk. */
function inspectJpeg(path: string): {
  width: number
  height: number
  orientation: number
  make: string
} {
  const b = readFileSync(path)
  let width = 0
  let height = 0
  let orientation = 0
  let make = ""
  for (let i = 2; i + 4 <= b.length;) {
    const marker = b[i + 1]!
    const size = b.readUInt16BE(i + 2)
    if (marker === 0xda) break
    if (marker >= 0xc0 && marker <= 0xc2) {
      height = b.readUInt16BE(i + 5)
      width = b.readUInt16BE(i + 7)
    }
    if (marker === 0xe1 && b.subarray(i + 4, i + 10).toString("latin1") === "Exif\0\0") {
      const t = b.subarray(i + 10, i + 2 + size)
      const le = t.subarray(0, 2).toString("latin1") === "II"
      const u16 = (o: number): number => (le ? t.readUInt16LE(o) : t.readUInt16BE(o))
      const u32 = (o: number): number => (le ? t.readUInt32LE(o) : t.readUInt32BE(o))
      const ifd = u32(4)
      for (let k = 0; k < u16(ifd); k++) {
        const e = ifd + 2 + k * 12
        if (u16(e) === 0x0112) orientation = u16(e + 8)
        if (u16(e) === 0x010f) {
          const at = u32(e + 8)
          make = t
            .subarray(at, at + u32(e + 4))
            .toString("latin1")
            .replace(/\0+$/, "")
        }
      }
    }
    i += 2 + size
  }
  return { width, height, orientation, make }
}

test.describe("image editor (Stage 12)", () => {
  test("edits a picture with the geometry tools and saves a copy that opens right", async () => {
    test.setTimeout(120_000)
    const { dir, first } = pictures()
    const { app, page } = await launchApp()
    try {
      await openViewerIn(page, dir)
      const opened = await editFirstTile(page)
      // Orientation 6: the 640×480 file is shown upright.
      await expect(page.getByTestId("editor-name")).toHaveText(first)
      await expect(size(page)).toHaveText("480 × 640")
      await expect(page.getByTestId("editor-unsaved")).toHaveCount(0)

      // The info panels: the histogram from the render pass, the EXIF tags from Go.
      await expect(page.getByTestId("editor-histogram")).toBeVisible()
      await expect(page.getByTestId("exif")).toContainText("E2E Cam")
      await page.getByRole("tab", { name: "File" }).click()
      await expect(page.getByTestId("editor-file")).toContainText("480 × 640 pixels")
      await expect(page.getByTestId("editor-file")).toContainText("about")

      // A quarter turn, then undo and redo with the keyboard.
      await openTool(page, "geometry", "rotate")
      const turnMs = await timedFrame(page, () =>
        page.getByTestId("tool-panel").getByRole("button", { name: "Right", exact: true }).click(),
      )
      await expect(size(page)).toHaveText("640 × 480")
      await expect(page.getByTestId("editor-unsaved")).toBeVisible()
      await page.keyboard.press("Control+Z")
      await expect(size(page)).toHaveText("480 × 640")
      await page.keyboard.press("Control+Shift+Z")
      await expect(size(page)).toHaveText("640 × 480")

      // Drag the angle slider: drafts while it moves, the full frame when it rests.
      await watch(page)
      const slider = page.getByRole("slider", { name: "Angle" })
      const box = (await slider.boundingBox())!
      const y = box.y + box.height / 2
      await page.mouse.move(box.x + box.width / 2, y)
      await page.mouse.down()
      const dragStart = Date.now()
      for (let i = 1; i <= 40; i++) {
        await page.mouse.move(box.x + box.width / 2 + i * 1.5, y)
        await page.waitForTimeout(16)
      }
      const dragMs = Date.now() - dragStart
      const settleMs = await timedFrame(page, () => page.mouse.up())
      const { paints, longTasks } = await page.evaluate(() => {
        const w = window as unknown as { __paints: number[]; __lt: number[] }
        return { paints: w.__paints, longTasks: w.__lt }
      })
      const gaps = paints
        .slice(1)
        .map((t, i) => t - paints[i]!)
        .sort((a, b) => a - b)
      const p95 = gaps[Math.min(Math.floor(gaps.length * 0.95), gaps.length - 1)] ?? 0
      expect(paints.length).toBeGreaterThan(5)
      await expect(page.getByTestId("stack-item")).toHaveCount(2)
      // One undo takes the whole drag back.
      await page.keyboard.press("Control+Z")
      await expect(page.getByTestId("stack-item")).toHaveCount(1)

      // Crop to a square with the keyboard: find the tool, lock 1:1, Enter.
      await page.keyboard.press("/")
      await page.getByRole("searchbox", { name: "Find a tool" }).fill("crop")
      await page.keyboard.press("Enter")
      await expect(page.getByTestId("crop-overlay")).toBeVisible()
      await page.getByTestId("tool-panel").getByRole("button", { name: "1:1", exact: true }).click()
      await page.getByTestId("crop-box").focus()
      await page.keyboard.press("Enter")
      await expect(size(page)).toHaveText("480 × 480")

      // Resize to half.
      await openTool(page, "geometry", "resize")
      await page.getByRole("combobox", { name: "Resize by" }).selectOption("percent")
      const width = page.getByTestId("tool-panel").getByRole("textbox", { name: "Width" })
      await width.fill("50")
      await width.press("Enter")
      await expect(size(page)).toHaveText("240 × 240")
      await framePainted(page)

      // Replace asks first, with Cancel focused; it is cancelled here.
      await page.getByTestId("save-more").click()
      await page.getByRole("menuitem", { name: /Replace original/ }).click()
      await expect(page.getByTestId("confirm-replace")).toBeVisible()
      await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused()
      await page.keyboard.press("Enter")
      await expect(page.getByTestId("confirm-replace")).toHaveCount(0)

      // Save a copy: a job; the editor stays open and says where it went.
      const t0 = Date.now()
      await page.getByTestId("save-main").click()
      await expect(page.getByTestId("save-done")).toBeVisible({ timeout: 30_000 })
      const saveMs = Date.now() - t0
      const copy = first.replace(/\.jpg$/, " (edited).jpg")
      await expect(page.getByTestId("save-done")).toHaveText(`Saved as ${copy}`)
      await expect(page.getByTestId("editor-unsaved")).toHaveCount(0)
      // On disk: the edited size, upright pixels with orientation 1, the maker kept.
      expect(inspectJpeg(join(dir, copy))).toEqual({
        width: 240,
        height: 240,
        orientation: 1,
        make: "E2E Cam",
      })
      // The original is untouched.
      expect(inspectJpeg(join(dir, first))).toMatchObject({
        width: 640,
        height: 480,
        orientation: 6,
      })
      // "Show in folder" goes through main, by job id.
      await page.getByRole("button", { name: "Show in folder" }).click()
      await expect
        .poll(() =>
          app.evaluate(() =>
            (
              globalThis as unknown as { __panelythShellLog: { action: string; value: string }[] }
            ).__panelythShellLog.filter((e) => e.action === "reveal"),
          ),
        )
        .toHaveLength(1)

      // Another change, then Esc: the prompt, with Cancel focused; Don't save closes.
      await openTool(page, "geometry", "flip")
      await page.getByTestId("tool-panel").getByRole("button", { name: "Horizontal" }).click()
      await page.keyboard.press("Escape")
      await expect(page.getByTestId("unsaved-prompt")).toBeVisible()
      await expect(
        page.getByTestId("unsaved-prompt").getByRole("button", { name: "Cancel" }),
      ).toBeFocused()
      await page.getByRole("button", { name: "Don't save" }).click()
      await expect(editor(page)).toHaveCount(0)
      // The saved copy is a tile now.
      await expect(page.locator(`[data-testid="tile"][aria-label="${copy}"]`)).toBeVisible({
        timeout: 15_000,
      })

      const result = {
        test: "editor",
        firstFrameMs: opened.firstFrameMs,
        readyMs: opened.readyMs,
        quarterTurnMs: turnMs,
        dragMs,
        dragPaints: paints.length,
        dragPaintGapP95Ms: Math.round(p95),
        dragSettleMs: settleMs,
        longTasksOver50: longTasks.filter((d) => d > 50).length,
        maxLongTaskMs: Math.round(Math.max(0, ...longTasks)),
        saveMs,
      }
      writeResult(result)
      test.info().annotations.push({ type: "metrics", description: JSON.stringify(result) })
      expectWithinBudget(opened.firstFrameMs, 100, "Edit pressed to first frame (ms)")
      expectWithinBudget(p95, 80, "frame interval while dragging, p95 (ms)")
      expect(longTasks.filter((d) => d > 50)).toEqual([])
    } finally {
      await app.close()
    }
  })

  test("a 24 MP picture opens and follows a dragged slider within budget", async () => {
    test.setTimeout(180_000)
    const fx = ensureFixture("editor-24mp", {
      files: 0,
      images: { count: 2, width: 6000, height: 4000 },
    })
    const { app, page } = await launchApp()
    try {
      await openViewerIn(page, fx.root)
      const opened = await editFirstTile(page)
      await expect(size(page)).toHaveText("6,000 × 4,000")
      await openTool(page, "geometry", "rotate")
      await watch(page)
      const slider = page.getByRole("slider", { name: "Angle" })
      const box = (await slider.boundingBox())!
      const y = box.y + box.height / 2
      await page.mouse.move(box.x + box.width / 2, y)
      await page.mouse.down()
      for (let i = 1; i <= 60; i++) {
        await page.mouse.move(box.x + box.width / 2 + i, y)
        await page.waitForTimeout(16)
      }
      const settleMs = await timedFrame(page, () => page.mouse.up())
      const { paints, longTasks } = await page.evaluate(() => {
        const w = window as unknown as { __paints: number[]; __lt: number[] }
        return { paints: w.__paints, longTasks: w.__lt }
      })
      const gaps = paints
        .slice(1)
        .map((t, i) => t - paints[i]!)
        .sort((a, b) => a - b)
      const p95 = gaps[Math.min(Math.floor(gaps.length * 0.95), gaps.length - 1)] ?? 0
      const frame = await page.evaluate(() => {
        const img = document.querySelector<HTMLImageElement>('[data-testid="editor-frame"]')!
        return { w: img.naturalWidth, h: img.naturalHeight }
      })
      const result = {
        test: "editor-24mp",
        firstFrameMs: opened.firstFrameMs,
        readyMs: opened.readyMs,
        dragPaints: paints.length,
        dragPaintGapP95Ms: Math.round(p95),
        dragSettleMs: settleMs,
        finalFrame: `${frame.w}x${frame.h}`,
        longTasksOver50: longTasks.filter((d) => d > 50).length,
        maxLongTaskMs: Math.round(Math.max(0, ...longTasks)),
      }
      writeResult(result)
      test.info().annotations.push({ type: "metrics", description: JSON.stringify(result) })
      expectWithinBudget(opened.firstFrameMs, 100, "Edit pressed to first frame, 24 MP (ms)")
      expectWithinBudget(opened.readyMs, 1000, "edit.open ready, 24 MP (ms)")
      expectWithinBudget(p95, 80, "frame interval while dragging, 24 MP, p95 (ms)")
      expect(longTasks.filter((d) => d > 50)).toEqual([])
    } finally {
      await app.close()
    }
  })

  test("the commander's Edit lands in the viewer's editor; the commander itself cannot edit", async () => {
    test.setTimeout(90_000)
    const { dir, first } = pictures()
    const { app, page: first_ } = await launchApp(commanderEnv("commander"))
    try {
      await waitForReady(first_)
      const c = await commanderPage(app)
      // With the commander shown first, the first window may be either view.
      const page = app.windows().find((p) => !p.url().startsWith("app://commander"))!
      await expect(c.getByTestId("panel-left")).toBeVisible()
      await goTo(c, "left", dir)
      // The commander's profile has no edit method at all (ADR-0027).
      const refused = await c.evaluate(async () => {
        const api = window.panelyth as unknown as Record<string, unknown>
        return "edit" in api
      })
      expect(refused).toBe(false)
      // Enter on the picture opens the media window; its Edit hands the
      // picture to the viewer's editor in the main window.
      const base = first.replace(/\.jpg$/, "")
      await c.getByTestId("grid-left").getByRole("gridcell", { name: base, exact: true }).click()
      await c.keyboard.press("Enter")
      const media = await mediaPage(app)
      await expect(media.getByTestId("media-viewer")).toBeVisible({ timeout: 15_000 })
      await media.getByTestId("media-edit").click()
      await expect(editor(page)).toHaveAttribute("data-status", "ready", { timeout: 20_000 })
      await expect(page.getByTestId("editor-name")).toHaveText(first)
      await framePainted(page)
      await expect.poll(() => shellState(app)).toMatchObject({ active: "viewer" })
      // The media window is done.
      await expect
        .poll(() => app.windows().filter((p) => p.url().includes("media.html")).length)
        .toBe(0)
      await page.keyboard.press("Escape")
      await expect(editor(page)).toHaveCount(0)
    } finally {
      await app.close()
    }
  })
})

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
