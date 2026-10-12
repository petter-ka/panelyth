// The editor's color tools end to end (Stage 13): levels and curves change
// the histogram and the saved pixels, the eyedropper's loupe reads the
// picture through Go, Reduce colors saves an indexed PNG, Count colors is
// exact, and a color slider follows the hand on a 24 MP picture.
//
// The pictures are written here as BMP files with known pixels and saved as
// BMP or PNG, so the test can read every value back without a decoder.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inflateSync } from "node:zlib"
import { expect, test, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { expectWithinBudget, launchApp } from "../../launch"
import {
  dragSlider,
  editFirstTile,
  editor,
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

/** A 24-bit BMP of `width` × `height` pixels. */
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
    // Rows are stored bottom up, pixels as blue, green, red.
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

/** Reads an uncompressed 24 or 32 bit BMP. */
function readBmp(path: string): { width: number; height: number; at(x: number, y: number): Rgb } {
  const b = readFileSync(path)
  expect(b.subarray(0, 2).toString("latin1")).toBe("BM")
  const offset = b.readUInt32LE(10)
  const width = b.readInt32LE(18)
  const signed = b.readInt32LE(22)
  const height = Math.abs(signed)
  const bytes = b.readUInt16LE(28) / 8
  expect([3, 4]).toContain(bytes)
  expect(b.readUInt32LE(30)).toBe(0)
  const row = Math.ceil((width * bytes) / 4) * 4
  return {
    width,
    height,
    at(x, y) {
      const line = signed > 0 ? height - 1 - y : y
      const i = offset + line * row + x * bytes
      return [b[i + 2]!, b[i + 1]!, b[i]!]
    },
  }
}

/** The chunks of a PNG and, for an indexed one, its distinct palette indices. */
function readPng(path: string): {
  width: number
  height: number
  colorType: number
  bitDepth: number
  palette: number
  used: number
} {
  const b = readFileSync(path)
  expect(b.subarray(1, 4).toString("latin1")).toBe("PNG")
  let width = 0
  let height = 0
  let colorType = -1
  let bitDepth = 0
  let palette = 0
  const data: Buffer[] = []
  for (let i = 8; i + 8 <= b.length;) {
    const length = b.readUInt32BE(i)
    const type = b.subarray(i + 4, i + 8).toString("latin1")
    const body = b.subarray(i + 8, i + 8 + length)
    if (type === "IHDR") {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body[8]!
      colorType = body[9]!
    }
    if (type === "PLTE") palette = length / 3
    if (type === "IDAT") data.push(body)
    i += 12 + length
  }
  // Indexed pixels: the palette entries in use. Rows are read where they
  // are stored unfiltered (filter 0), which is how an indexed PNG is written.
  const raw = inflateSync(Buffer.concat(data))
  const used = new Set<number>()
  if (colorType === 3) {
    const stride = Math.ceil((width * bitDepth) / 8) + 1
    const mask = (1 << bitDepth) - 1
    for (let y = 0; y < height; y++) {
      if (raw[y * stride] !== 0) continue
      for (let x = 0; x < width; x++) {
        const bit = x * bitDepth
        const byte = raw[y * stride + 1 + (bit >> 3)]!
        used.add((byte >> (8 - bitDepth - (bit & 7))) & mask)
      }
    }
  }
  return { width, height, colorType, bitDepth, palette, used: used.size }
}

/** A new folder holding one picture. */
function folderWith(name: string, file: Buffer): string {
  const dir = join(mkdtempSync(join(tmpdir(), "panelyth-color-")), "pictures")
  mkdirSync(dir)
  writeFileSync(join(dir, name), file)
  return dir
}

const panel = (page: Page) => page.getByTestId("tool-panel")

/** Types a value into the number field of a slider and commits it. */
async function setNumber(page: Page, name: string, value: number): Promise<void> {
  const field = panel(page).getByRole("textbox", { name, exact: true })
  await field.fill(String(value))
  await field.press("Enter")
}

/** Saves a copy in the given format and returns its path. */
async function saveCopyAs(page: Page, dir: string, stem: string, format: string): Promise<string> {
  await page.getByTestId("save-more").click()
  await page.getByRole("menuitem", { name: /Save options/ }).click()
  const options = page.getByTestId("save-options")
  await options.getByRole("combobox", { name: "Format" }).selectOption(format)
  await options.getByRole("button", { name: "Done" }).click()
  await page.getByTestId("save-main").click()
  await expect(page.getByTestId("save-done")).toBeVisible({ timeout: 30_000 })
  const name = `${stem} (edited).${format}`
  await expect(page.getByTestId("save-done")).toHaveText(`Saved as ${name}`)
  return join(dir, name)
}

test.describe("image editor: color tools (Stage 13)", () => {
  test("levels and curves change the histogram and the saved pixels; the loupe reads the picture", async () => {
    test.setTimeout(120_000)
    // A gray ramp: the value of a pixel is its column.
    const dir = folderWith(
      "ramp.bmp",
      bmp(256, 64, (x) => [x, x, x]),
    )
    const { app, page } = await launchApp()
    try {
      await openViewerIn(page, dir)
      await editFirstTile(page)
      await expect(size(page)).toHaveText("256 × 64")
      // The whole ramp: nothing piles up at the ends.
      await expect(page.getByTestId("clip-low")).toHaveCount(1)
      const summary = () =>
        page.getByTestId("editor-histogram").getByRole("img").getAttribute("aria-label")
      const untouched = await summary()

      // Adjust is the group shown first; Levels draws the histogram it is given.
      await openTool(page, "adjust", "levels")
      await expect(panel(page).getByTestId("before-histogram")).toHaveAttribute(
        "data-ready",
        "true",
      )

      // The eyedropper's loupe shows the value under the pointer, read by Go.
      await page.locator('[data-dropper="white"]').click()
      const overlay = page.getByTestId("picker-overlay")
      await expect(overlay).toBeVisible()
      const box = (await overlay.boundingBox())!
      await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2)
      await expect(page.getByTestId("loupe")).toBeVisible()
      // Three quarters along a ramp of 0..255: about 191, the same in each channel.
      await expect
        .poll(async () => {
          const text = (await page.getByTestId("loupe-rgb").textContent()) ?? ""
          const m = /R (\d+)\s+G (\d+)\s+B (\d+)/.exec(text)
          return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
        })
        .toEqual([expect.closeTo(191, -1), expect.closeTo(191, -1), expect.closeTo(191, -1)])
      const hex = (await page.getByTestId("loupe-hex").textContent())!
      expect(hex).toMatch(/^#([0-9a-f]{2})\1\1$/)
      // Esc puts the eyedropper away; the editor stays, nothing was edited.
      await page.keyboard.press("Escape")
      await expect(overlay).toHaveCount(0)
      await expect(editor(page)).toBeVisible()
      await expect(page.getByTestId("stack-item")).toHaveCount(0)

      // Levels: black at 64, white at 192. A quarter of the ramp clips at each end.
      const levelsMs = await timedFrame(page, () => setNumber(page, "Black point", 64))
      await timedFrame(page, () => setNumber(page, "White point", 192))
      await expect(page.getByTestId("stack-item")).toHaveCount(1)
      await expect(page.getByTestId("clip-low")).toContainText("25")
      await expect(page.getByTestId("clip-high")).toContainText("25")
      expect(await summary()).not.toBe(untouched)

      // Curves with the keyboard alone: find the tool, walk to the first
      // point and lift it by 50. (Tab first: "/" in a number field is text.)
      await page.keyboard.press("Tab")
      await page.keyboard.press("/")
      await page.keyboard.type("curves")
      await page.keyboard.press("Enter")
      await expect(page.locator('button[data-tool="curves"]')).toBeFocused()
      await expect(page.getByTestId("curves")).toHaveAttribute("data-points", "2")
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press("Tab")
        const point = await page.evaluate(
          () => (document.activeElement as HTMLElement | null)?.dataset.point ?? null,
        )
        if (point === "0") break
      }
      await expect(page.locator('[data-testid="curves"] [data-point="0"]')).toBeFocused()
      for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowUp")
      await expect(panel(page).getByRole("textbox", { name: "Output", exact: true })).toHaveValue(
        "50",
      )
      await expect(page.getByTestId("stack-item")).toHaveCount(2)
      await framePainted(page)
      // Lifted blacks: nothing is at zero any more.
      await expect(page.getByTestId("clip-low")).toHaveCount(0)

      // Undo and redo work per step, with the keyboard.
      await page.keyboard.press("Control+Z")
      await expect(panel(page).getByRole("textbox", { name: "Output", exact: true })).toHaveValue(
        "40",
      )
      await page.keyboard.press("Control+Shift+Z")
      await expect(panel(page).getByRole("textbox", { name: "Output", exact: true })).toHaveValue(
        "50",
      )

      // Save without loss and read the pixels back.
      const saved = readBmp(await saveCopyAs(page, dir, "ramp", "bmp"))
      expect([saved.width, saved.height]).toEqual([256, 64])
      const expected = (x: number): number => {
        const levels = Math.min(Math.max((x - 64) / 128, 0), 1) * 255
        return 50 + (levels * 205) / 255
      }
      for (const x of [0, 32, 64, 96, 128, 160, 192, 224, 255]) {
        const [r, g, b] = saved.at(x, 32)
        // Two rounded steps: one level each at most.
        expect(Math.abs(r - expected(x)), `column ${x}`).toBeLessThanOrEqual(2)
        expect([g, b]).toEqual([r, r])
      }
      expect(saved.at(0, 0)[0]).toBe(50)
      expect(saved.at(255, 63)[0]).toBe(255)
      // The original is untouched.
      expect(readBmp(join(dir, "ramp.bmp")).at(128, 10)).toEqual([128, 128, 128])
      writeResult({ test: "editor-levels", levelsFrameMs: levelsMs }, 13)
    } finally {
      await app.close()
    }
  })

  test("counts colors exactly, reduces them to 16 and saves an indexed PNG", async () => {
    test.setTimeout(120_000)
    // Red follows the column, green the row: 128 × 128 different colors.
    const dir = folderWith(
      "colors.bmp",
      bmp(128, 128, (x, y) => [x * 2, y * 2, (x + y) & 0xff]),
    )
    const { app, page } = await launchApp()
    try {
      await openViewerIn(page, dir)
      await editFirstTile(page)
      await page.getByRole("tab", { name: "Colors" }).click()
      const colors = page.getByTestId("editor-colors")
      // Nothing is counted until it is asked for.
      await expect(colors.getByTestId("colors-result")).toHaveCount(0)
      const t0 = Date.now()
      await colors.getByRole("button", { name: "Count colors" }).click()
      await expect(colors.getByTestId("colors-distinct")).toHaveText("16,384")
      const countMs = Date.now() - t0
      await expect(colors.getByTestId("colors-result")).toContainText("128 × 128 pixels")
      expect(await colors.getByTestId("swatches").getByRole("button").count()).toBeGreaterThan(8)

      // Reduce colors is chosen by opening it; the save format follows.
      await openTool(page, "color", "reduceColors")
      await expect(page.getByTestId("stack-item")).toHaveCount(1)
      await expect(panel(page)).toContainText("Saved as PNG")
      await framePainted(page)
      await panel(page).getByRole("button", { name: "Show the palette" }).click()
      const shown = panel(page).getByTestId("swatches").getByRole("button")
      await expect(shown).not.toHaveCount(0)
      expect(await shown.count()).toBeLessThanOrEqual(16)
      // The count of the edited picture is old now, and is 16 when taken again.
      await expect(colors).toContainText("has changed since the last count")
      await colors.getByRole("button", { name: "Count colors" }).click()
      await expect(colors.getByTestId("colors-distinct")).toHaveText(/^\d{1,2}$/)
      const reduced = Number(await colors.getByTestId("colors-distinct").textContent())
      expect(reduced).toBeGreaterThan(8)
      expect(reduced).toBeLessThanOrEqual(16)
      // The original still has all of them.
      await colors.getByRole("radio", { name: "Original" }).click()
      await colors.getByRole("button", { name: "Count colors" }).click()
      await expect(colors.getByTestId("colors-distinct")).toHaveText("16,384")

      // Saved: a palette of at most 16 entries, one byte per pixel.
      await page.getByTestId("save-main").click()
      await expect(page.getByTestId("save-done")).toHaveText("Saved as colors (edited).png", {
        timeout: 30_000,
      })
      const png = readPng(join(dir, "colors (edited).png"))
      expect(png).toMatchObject({ width: 128, height: 128, colorType: 3 })
      expect(png.palette).toBeGreaterThan(1)
      expect(png.palette).toBeLessThanOrEqual(16)
      // Every color the count found is in the file, and no other.
      expect(png.used).toBe(reduced)
      writeResult({ test: "editor-count-colors", countMs }, 13)
    } finally {
      await app.close()
    }
  })

  test("a 24 MP picture follows the color sliders within the Stage 12 budgets", async () => {
    test.setTimeout(240_000)
    const fx = ensureFixture("editor-24mp", {
      files: 0,
      images: { count: 2, width: 6000, height: 4000 },
    })
    const { app, page } = await launchApp()
    try {
      await openViewerIn(page, fx.root)
      await editFirstTile(page)
      await expect(size(page)).toHaveText("6,000 × 4,000")
      const result: Record<string, number | string> = { test: "editor-color-24mp" }
      const longest: number[] = []
      // A fused point chain, a tool with a histogram of its own, and two
      // neighborhood tools (drafts while the slider moves).
      const cases: [string, "adjust" | "detail", string, string][] = [
        ["contrast", "adjust", "lighting", "Contrast"],
        ["saturation", "adjust", "colors", "Saturation"],
        ["levelsBlack", "adjust", "levels", "Black point"],
        ["sharpen", "detail", "sharpen", "Amount"],
        ["blur", "detail", "blur", "Radius"],
        ["denoise", "detail", "denoise", "Luminance noise"],
      ]
      for (const [id, group, tool, slider] of cases) {
        await openTool(page, group, tool)
        await framePainted(page)
        await watch(page)
        await dragSlider(page, slider, 50)
        const settleMs = await timedFrame(page, () => page.mouse.up())
        const seen = await watched(page)
        result[`${id}Paints`] = seen.paints
        result[`${id}GapP95Ms`] = Math.round(seen.p95)
        result[`${id}SettleMs`] = settleMs
        longest.push(...seen.longTasks)
        expect(seen.paints, `${id}: frames while dragging`).toBeGreaterThan(5)
        expectWithinBudget(seen.p95, 80, `${id}: frame interval while dragging, 24 MP, p95 (ms)`)
      }
      // Six tools were dragged: six operations, each one undo step.
      await expect(page.getByTestId("stack-item")).toHaveCount(6)
      // The looks render from the session's proxy, in one batch.
      const looksStart = Date.now()
      await page.locator('button[data-group="looks"]').click()
      await page.waitForFunction(() => {
        const tiles = [...document.querySelectorAll<HTMLImageElement>("[data-look] img")]
        return tiles.length >= 12 && tiles.every((img) => img.complete && img.naturalWidth > 0)
      })
      result.looksMs = Date.now() - looksStart
      result.longTasksOver50 = longest.filter((d) => d > 50).length
      result.maxLongTaskMs = Math.round(Math.max(0, ...longest))
      writeResult(result, 13)
      test.info().annotations.push({ type: "metrics", description: JSON.stringify(result) })
      expect(longest.filter((d) => d > 50)).toEqual([])
    } finally {
      await app.close()
    }
  })
})
