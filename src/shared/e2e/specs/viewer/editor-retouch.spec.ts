// Draw and retouch end to end (Stage 15): a brush stroke and a text, a
// cloned patch, a healed blemish and fixed red eyes, each checked in the
// pixels of the saved file; undo and redo through all of them; and on a
// 24 MP picture the ink that follows the pointer.
//
// The picture is a BMP written here: skin tone with a blue square to clone,
// a dark blemish to heal and three red pupils (a pair and a single one).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { expectWithinBudget, launchApp } from "../../launch"
import {
  editFirstTile,
  framePainted,
  openTool,
  openViewerIn,
  size,
  timedFrame,
  watch,
  watched,
  writeResult,
} from "./editorHelpers"

type Rgb = [number, number, number]

function bmp(width: number, height: number, pixel: (x: number, y: number) => Rgb): Buffer {
  const row = Math.ceil((width * 3) / 4) * 4
  const out = Buffer.alloc(54 + row * height)
  out.write("BM", 0, "latin1")
  out.writeUInt32LE(out.length, 2)
  out.writeUInt32LE(54, 10)
  out.writeUInt32LE(40, 14)
  out.writeInt32LE(width, 18)
  out.writeInt32LE(height, 22)
  out.writeUInt16LE(1, 26)
  out.writeUInt16LE(24, 28)
  out.writeUInt32LE(row * height, 34)
  for (let y = 0; y < height; y++) {
    const at = 54 + (height - 1 - y) * row
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y)
      out[at + x * 3] = b
      out[at + x * 3 + 1] = g
      out[at + x * 3 + 2] = r
    }
  }
  return out
}

function readBmp(path: string): { at(x: number, y: number): Rgb } {
  const b = readFileSync(path)
  const offset = b.readUInt32LE(10)
  const width = b.readInt32LE(18)
  const signed = b.readInt32LE(22)
  const height = Math.abs(signed)
  const bytes = b.readUInt16LE(28) / 8
  const row = Math.ceil((width * bytes) / 4) * 4
  return {
    at(x, y) {
      const line = signed > 0 ? height - 1 - y : y
      const i = offset + line * row + x * bytes
      return [b[i + 2]!, b[i + 1]!, b[i]!]
    },
  }
}

const SKIN: Rgb = [214, 168, 140]
const BLUE: Rgb = [30, 60, 200]
const PUPILS: [number, number][] = [
  [150, 150],
  [260, 150],
  [100, 262],
]

/** Skin, a blue square at 40..80 × 200..240, a dark blemish at (300, 100) and three red pupils. */
function scene(x: number, y: number): Rgb {
  if (x >= 40 && x < 80 && y >= 200 && y < 240) return BLUE
  if (Math.hypot(x - 300, y - 100) <= 5) return [70, 50, 40]
  for (const [cx, cy] of PUPILS) if (Math.hypot(x - cx, y - cy) <= 8) return [215, 40, 45]
  return SKIN
}

const panel = (page: Page) => page.getByTestId("tool-panel")

async function setNumber(page: Page, name: string, value: number): Promise<void> {
  const field = panel(page).getByRole("textbox", { name, exact: true })
  await field.fill(String(value))
  await field.press("Enter")
}

/** A point of the 400 × 300 picture as a point on the screen. */
async function onPicture(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = (await page.getByTestId("paint-overlay").boundingBox())!
  return { x: box.x + (x / 400) * box.width, y: box.y + (y / 300) * box.height }
}

async function dragOnPicture(
  page: Page,
  from: [number, number],
  to: [number, number],
): Promise<void> {
  const a = await onPicture(page, from[0], from[1])
  const b = await onPicture(page, to[0], to[1])
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 })
  await page.mouse.move(b.x, b.y, { steps: 4 })
  await page.mouse.up()
}

async function clickOnPicture(page: Page, x: number, y: number): Promise<void> {
  const p = await onPicture(page, x, y)
  await page.mouse.click(p.x, p.y)
}

/** Whether the canvas of the stroke in progress has ink on it (it is our own drawing, not the picture). */
const hasInk = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid="paint-ink"]')
    const data = c?.getContext("2d")?.getImageData(0, 0, c.width, c.height).data
    if (!data) return false
    for (let i = 3; i < data.length; i += 4 * 97) if (data[i]! > 0) return true
    return false
  })

test.describe("image editor: draw and retouch (Stage 15)", () => {
  test("draws, clones, heals and fixes red eyes; the saved pixels show each of them", async () => {
    test.setTimeout(120_000)
    const dir = join(mkdtempSync(join(tmpdir(), "panelyth-retouch-")), "pictures")
    mkdirSync(dir)
    writeFileSync(join(dir, "portrait.bmp"), bmp(400, 300, scene))
    const { app, page } = await launchApp()
    try {
      await openViewerIn(page, dir)
      await editFirstTile(page)
      await expect(size(page)).toHaveText("400 × 300")
      const stack = page.getByTestId("stack-item")

      // R shows the group; Draw puts its pointer on the picture.
      await page.keyboard.press("r")
      await openTool(page, "retouch", "draw")
      await expect(page.getByTestId("paint-overlay")).toBeVisible()
      await setNumber(page, "Size", 4)
      await setNumber(page, "Hardness", 100)

      // A stroke: the ink is on the picture with the pointer, before Go has answered.
      const a = await onPicture(page, 100, 60)
      const b = await onPicture(page, 300, 60)
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      await page.mouse.move((a.x + b.x) / 2, a.y, { steps: 3 })
      expect(await hasInk(page)).toBe(true)
      await page.mouse.move(b.x, b.y, { steps: 3 })
      await timedFrame(page, () => page.mouse.up())
      await expect(stack).toHaveCount(1)
      await expect(panel(page).getByTestId("draw-count")).toHaveText("Strokes in this drawing: 1")
      // Go's frame has the stroke now: the ink drawn here is gone.
      await expect.poll(() => hasInk(page)).toBe(false)

      // A text, placed with a click. It joins the same drawing.
      await panel(page).getByRole("radio", { name: "Text" }).click()
      await panel(page).getByTestId("draw-text").fill("Hi")
      await setNumber(page, "Size", 10)
      await clickOnPicture(page, 180, 15)
      await expect(panel(page).getByTestId("draw-count")).toHaveText("Strokes in this drawing: 2")
      await expect(stack).toHaveCount(1)

      // Clone: Alt and a click on the blue square, then a short stroke on the skin.
      await openTool(page, "retouch", "clone")
      await setNumber(page, "Size", 10)
      await setNumber(page, "Hardness", 100)
      await clickOnPicture(page, 330, 220)
      await expect(page.getByText(/Hold Alt and click where to copy from first/)).toBeVisible()
      await expect(stack).toHaveCount(1)
      await page.keyboard.down("Alt")
      await clickOnPicture(page, 60, 220)
      await page.keyboard.up("Alt")
      await expect(panel(page).getByTestId("paint-source-state")).toContainText("The source is set")
      await dragOnPicture(page, [330, 220], [336, 220])
      await expect(stack).toHaveCount(2)

      // Heal: a click on the blemish.
      await openTool(page, "retouch", "heal")
      await setNumber(page, "Size", 8)
      await clickOnPicture(page, 300, 100)
      await expect(stack).toHaveCount(3)

      // Red-eye: Auto finds the pair, a click fixes the single one.
      await openTool(page, "retouch", "redeye")
      await panel(page).getByRole("button", { name: "Fix red eyes automatically" }).click()
      await expect(page.getByText("Red eyes fixed: 2")).toBeVisible()
      await expect(stack).toHaveCount(5)
      await clickOnPicture(page, PUPILS[2]![0], PUPILS[2]![1])
      await expect(stack).toHaveCount(6)
      await framePainted(page)

      // Undo and redo through every stroke: two of the drawing, clone, heal, the pair, the single eye.
      await page.getByTestId("paint-overlay").focus()
      for (let i = 0; i < 6; i++) await page.keyboard.press("Control+Z")
      await expect(stack).toHaveCount(0)
      await expect(page.getByTestId("editor-unsaved")).toHaveCount(0)
      for (let i = 0; i < 6; i++) await page.keyboard.press("Control+Shift+Z")
      await expect(stack).toHaveCount(6)

      // Save without loss and read the pixels back.
      await page.getByTestId("save-more").click()
      await page.getByRole("menuitem", { name: /Save options/ }).click()
      const options = page.getByTestId("save-options")
      await options.getByRole("combobox", { name: "Format" }).selectOption("bmp")
      await options.getByRole("button", { name: "Done" }).click()
      await page.getByTestId("save-main").click()
      await expect(page.getByTestId("save-done")).toHaveText("Saved as portrait (edited).bmp", {
        timeout: 30_000,
      })
      const saved = readBmp(join(dir, "portrait (edited).bmp"))
      // The stroke: 12 px wide along y = 60, in the brush's color; skin above and below it.
      for (const x of [110, 200, 290])
        expect(saved.at(x, 60), `stroke at ${x}`).toEqual([255, 59, 48])
      expect(saved.at(200, 51)).toEqual(SKIN)
      expect(saved.at(200, 69)).toEqual(SKIN)
      expect(saved.at(80, 60)).toEqual(SKIN)
      // The text: ink of the brush's color where "Hi" was put (a 30 px line from y = 15).
      let ink = 0
      for (let y = 15; y < 50; y++) {
        for (let x = 180; x < 240; x++) if (saved.at(x, y).join() === "255,59,48") ink++
      }
      expect(ink).toBeGreaterThan(60)
      // The clone: the blue square's pixels where the stroke went.
      expect(saved.at(330, 220)).toEqual(BLUE)
      expect(saved.at(336, 225)).toEqual(BLUE)
      expect(saved.at(330, 190)).toEqual(SKIN)
      // The blemish is skin again, to within a few levels.
      const healed = saved.at(300, 100)
      for (let c = 0; c < 3; c++)
        expect(Math.abs(healed[c]! - SKIN[c]!), `healed ${healed}`).toBeLessThan(14)
      // The pupils are dark, not red.
      for (const [cx, cy] of PUPILS) {
        const p = saved.at(cx, cy)
        expect(p[0], `pupil at ${cx},${cy}: ${p}`).toBeLessThan(90)
        expect(p[0]).toBeLessThanOrEqual(Math.max(p[1], p[2]) + 30)
      }
      // Everything else is untouched, and so is the original.
      expect(saved.at(20, 20)).toEqual(SKIN)
      expect(saved.at(60, 220)).toEqual(BLUE)
      expect(readBmp(join(dir, "portrait.bmp")).at(300, 100)).toEqual([70, 50, 40])
    } finally {
      await app.close()
    }
  })

  test("on a 24 MP picture ink follows the pointer and Go's frames follow the ink", async () => {
    test.setTimeout(180_000)
    const fx = ensureFixture("editor-24mp", {
      files: 0,
      images: { count: 2, width: 6000, height: 4000 },
    })
    const { app, page } = await launchApp()
    try {
      await openViewerIn(page, fx.root)
      await editFirstTile(page)
      await expect(size(page)).toHaveText("6,000 × 4,000")
      await openTool(page, "retouch", "draw")
      await framePainted(page)
      const box = (await page.getByTestId("paint-overlay").boundingBox())!
      // How long after a pointer event the ink is on its canvas, measured in the
      // page: a listener on the window runs after the editor's own, in the same task.
      await page.evaluate(() => {
        const w = window as unknown as { __ink: number[] }
        w.__ink = []
        window.addEventListener("pointermove", (e) => {
          if (e.buttons !== 1) return
          const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="paint-ink"]')
          if (!canvas) return
          const r = canvas.getBoundingClientRect()
          const x = Math.round(((e.clientX - r.left) / r.width) * canvas.width)
          const y = Math.round(((e.clientY - r.top) / r.height) * canvas.height)
          const a = canvas.getContext("2d")!.getImageData(x, y, 1, 1).data[3]!
          w.__ink.push(a > 0 ? performance.now() - e.timeStamp : -1)
        })
      })
      await watch(page)
      const y = box.y + box.height / 2
      await page.mouse.move(box.x + box.width * 0.1, y)
      await page.mouse.down()
      const moves = 80
      for (let i = 1; i <= moves; i++) {
        await page.mouse.move(
          box.x + box.width * (0.1 + (0.8 * i) / moves),
          y + Math.sin(i / 6) * box.height * 0.2,
        )
        await page.waitForTimeout(16)
      }
      const settleMs = await timedFrame(page, () => page.mouse.up())
      const seen = await watched(page)
      const ink = await page.evaluate(() => (window as unknown as { __ink: number[] }).__ink)
      const drawn = ink.filter((v) => v >= 0)
      const inkMax = Math.max(0, ...drawn)
      // A second and a third stroke: the drawing grows, a frame costs the same.
      for (let s = 1; s <= 2; s++) {
        await page.mouse.move(box.x + box.width * 0.1, y + s * 30)
        await page.mouse.down()
        await page.mouse.move(box.x + box.width * 0.9, y + s * 30, { steps: 20 })
        await timedFrame(page, () => page.mouse.up())
      }
      await expect(page.getByTestId("draw-count")).toHaveText("Strokes in this drawing: 3")
      const result = {
        test: "editor-draw-24mp",
        pointerMoves: moves,
        inkSeen: drawn.length,
        inkMaxMs: Math.round(inkMax * 10) / 10,
        framePaints: seen.paints,
        frameGapP95Ms: Math.round(seen.p95),
        settleMs,
        longTasksOver50: seen.longTasks.filter((d) => d > 50).length,
        maxLongTaskMs: Math.round(Math.max(0, ...seen.longTasks)),
      }
      writeResult(result, 15)
      test.info().annotations.push({ type: "metrics", description: JSON.stringify(result) })
      // The ink is there in the task of the pointer event, every time.
      expect(drawn.length).toBe(ink.length)
      expect(drawn.length).toBeGreaterThan(moves / 2)
      expectWithinBudget(inkMax, 33, "pointer move to ink visible (ms)")
      // Go's frames follow at the editor's usual pace.
      expect(seen.paints).toBeGreaterThan(10)
      expectWithinBudget(seen.p95, 80, "frame interval while a stroke is drawn, 24 MP, p95 (ms)")
      expect(seen.longTasks.filter((d) => d > 50)).toEqual([])
    } finally {
      await app.close()
    }
  })
})
