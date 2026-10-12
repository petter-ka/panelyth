// The editor's effects end to end (Stage 14): obscure a region, stamp a
// logo picked through main's dialog, add a text watermark and a frame, save
// without loss and read the pixels back; then open the saved picture again.
// A 24 MP picture follows the effect sliders within the frame budget.
//
// The picture is a BMP with a known pattern and the logo a PNG written here,
// so every checked pixel has an exact expected value.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { crc32, deflateSync } from "node:zlib"
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

/** A 24-bit BMP. */
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

function readBmp(path: string): { width: number; height: number; at(x: number, y: number): Rgb } {
  const b = readFileSync(path)
  expect(b.subarray(0, 2).toString("latin1")).toBe("BM")
  const offset = b.readUInt32LE(10)
  const width = b.readInt32LE(18)
  const signed = b.readInt32LE(22)
  const height = Math.abs(signed)
  const bytes = b.readUInt16LE(28) / 8
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

/** An 8-bit RGB PNG of one color. */
function png(width: number, height: number, color: Rgb): Buffer {
  const chunk = (type: string, body: Buffer): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, "latin1")
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0)
    return Buffer.concat([head, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(color, y * (width * 3 + 1) + 1 + x * 3)
  }
  return Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

const panel = (page: Page) => page.getByTestId("tool-panel")

/** Types a value into the number field of a slider and commits it. */
async function setNumber(page: Page, name: string, value: number): Promise<void> {
  const field = panel(page).getByRole("textbox", { name, exact: true })
  await field.fill(String(value))
  await field.press("Enter")
}

// Busy in every direction, so any blur or block changes it.
const pattern = (x: number, y: number): Rgb => [
  (x * 37) % 256,
  (y * 53) % 256,
  (x * 11 + y * 7) % 256,
]

test.describe("image editor: effects (Stage 14)", () => {
  test("obscures a region, stamps a picked logo and text, frames the picture and saves it", async () => {
    test.setTimeout(120_000)
    const root = mkdtempSync(join(tmpdir(), "panelyth-effects-"))
    const dir = join(root, "pictures")
    mkdirSync(dir)
    writeFileSync(join(dir, "scene.bmp"), bmp(400, 300, pattern))
    // The logo lives elsewhere: only main's dialog names it.
    const logo = join(root, "logo.png")
    writeFileSync(logo, png(100, 50, [255, 0, 0]))
    const { app, page } = await launchApp({ PANELYTH_TEST_ASSET_PATH: logo })
    try {
      await openViewerIn(page, dir)
      await editFirstTile(page)
      await expect(size(page)).toHaveText("400 × 300")

      // E shows the effects; Obscure is there once opened, with its region on the picture.
      await page.keyboard.press("e")
      await expect(panel(page)).toHaveAttribute("data-group", "effects")
      await openTool(page, "effects", "obscure")
      await expect(page.getByTestId("stack-item")).toHaveCount(1)
      await expect(page.getByTestId("obscure-note")).toContainText("cannot be brought back")
      const region = page.getByTestId("obscure-region")
      await expect(region).toBeVisible()
      await panel(page).getByRole("radio", { name: "Pixelate" }).click()
      await setNumber(page, "Strength", 100)
      // The region by numbers: the left 30 % to 60 %, the top 40 % to 80 %.
      await setNumber(page, "Left", 30)
      await setNumber(page, "Top", 40)
      await setNumber(page, "Width", 30)
      await setNumber(page, "Height", 40)
      // The keyboard moves it by a picture pixel: back and forth changes nothing.
      await region.focus()
      await page.keyboard.press("ArrowRight")
      await page.keyboard.press("ArrowLeft")
      await framePainted(page)

      // A logo: main's dialog (canned here) gives an id and a thumbnail, never the path.
      await openTool(page, "effects", "watermark")
      await expect(panel(page).getByTestId("watermark-text")).toHaveValue("© {year} {name}")
      await panel(page).getByRole("radio", { name: "Picture" }).click()
      await expect(panel(page).getByTestId("asset-name")).toHaveText("logo.png")
      const thumb = panel(page).getByTestId("asset-picker").locator("img")
      await expect(thumb).toHaveAttribute("src", /^panelyth-media:\/\/m\/[0-9a-f]{32}$/)
      await expect
        .poll(() => thumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth))
        .toBe(100)
      // Nothing in the page names where the logo is: its name, never its path.
      const leaked = await page.evaluate(
        (names) => names.some((name) => document.documentElement.outerHTML.includes(name)),
        [logo, logo.replaceAll("\\", "/"), "PANELYTH_TEST_ASSET_PATH"],
      )
      expect(leaked).toBe(false)
      await panel(page).getByRole("radio", { name: "Top left" }).click()
      await setNumber(page, "Opacity", 100)
      await setNumber(page, "Size", 20)
      await setNumber(page, "Distance from the edge", 3)

      // A second watermark, text with a token, bottom right.
      await page.locator('button[data-tool="watermark"]').click()
      await page.locator('button[data-tool="watermark"]').click()
      await expect(page.getByTestId("stack-item")).toHaveCount(3)
      const text = panel(page).getByTestId("watermark-text")
      await text.fill("")
      await panel(page).getByRole("button", { name: "File name" }).click()
      await expect(text).toHaveValue("{name}")
      await setNumber(page, "Opacity", 100)
      await setNumber(page, "Size", 12)
      const fonts = panel(page).getByRole("combobox", { name: "Font" })
      await expect(fonts.locator("option").nth(1)).toHaveText("Go Mono")

      // A frame of 5 % of the shorter edge: 15 px on every side.
      await openTool(page, "effects", "border")
      const frameMs = await timedFrame(page, () => setNumber(page, "Width", 5))
      await expect(size(page)).toHaveText("430 × 330")
      await expect(page.getByTestId("stack-item")).toHaveCount(4)

      // Save without loss and read it back.
      await page.getByTestId("save-more").click()
      await page.getByRole("menuitem", { name: /Save options/ }).click()
      const options = page.getByTestId("save-options")
      await options.getByRole("combobox", { name: "Format" }).selectOption("bmp")
      await options.getByRole("button", { name: "Done" }).click()
      await page.getByTestId("save-main").click()
      await expect(page.getByTestId("save-done")).toHaveText("Saved as scene (edited).bmp", {
        timeout: 30_000,
      })
      const saved = readBmp(join(dir, "scene (edited).bmp"))
      expect([saved.width, saved.height]).toEqual([430, 330])
      // The frame is white; the picture sits 15 px in.
      expect(saved.at(2, 2)).toEqual([255, 255, 255])
      expect(saved.at(427, 327)).toEqual([255, 255, 255])
      const inPicture = (x: number, y: number): Rgb => saved.at(x + 15, y + 15)
      // Outside the region the pixels are the source's, exactly.
      for (const [x, y] of [
        [200, 20],
        [20, 150],
        [300, 150],
        [200, 280],
        [110, 115],
      ] as const) {
        expect(inPicture(x, y), `(${x},${y}) outside the region`).toEqual(pattern(x, y))
      }
      // Inside (120..240 × 120..240) they are blocks: neighbours are equal, the source is gone.
      let changed = 0
      for (let y = 130; y < 230; y += 10) {
        for (let x = 130; x < 230; x += 10) {
          if (inPicture(x, y).join() !== pattern(x, y).join()) changed++
        }
      }
      expect(changed).toBeGreaterThanOrEqual(95)
      expect(inPicture(150, 150)).toEqual(inPicture(151, 151))
      // The logo: 20 % of 300 px is 60 × 30, 9 px from the top left, fully red.
      expect(inPicture(9 + 30, 9 + 15)).toEqual([255, 0, 0])
      expect(inPicture(9 + 2, 9 + 2)).toEqual([255, 0, 0])
      expect(inPicture(9 + 62, 9 + 15)).toEqual(pattern(71, 24))
      // The text is white, bottom right: "scene" in a 36 px line, 9 px from the edge.
      let white = 0
      for (let y = 300 - 9 - 36; y < 300 - 9; y++) {
        for (let x = 250; x < 391; x++) {
          if (inPicture(x, y).join() === "255,255,255") white++
        }
      }
      expect(white).toBeGreaterThan(200)
      // The original is untouched.
      expect(readBmp(join(dir, "scene.bmp")).at(150, 150)).toEqual(pattern(150, 150))

      // The saved picture opens in the editor like any other.
      // (The Save button is disabled while it saves and loses the focus: the key still closes.)
      await page.keyboard.press("Escape")
      await expect(editor(page)).toHaveCount(0)
      const copy = page.locator('[data-testid="tile"][aria-label="scene (edited).bmp"]')
      await expect(copy).toBeVisible({ timeout: 15_000 })
      await copy.click({ button: "right" })
      await page.getByTestId("menu-edit").click()
      await expect(editor(page)).toHaveAttribute("data-status", "ready", { timeout: 20_000 })
      await expect(size(page)).toHaveText("430 × 330")
      await expect(page.getByTestId("stack-item")).toHaveCount(0)
      writeResult({ test: "editor-effects", borderFrameMs: frameMs }, 14)
    } finally {
      await app.close()
    }
  })

  test("a file that is not a picture is refused with a reason", async () => {
    test.setTimeout(90_000)
    const root = mkdtempSync(join(tmpdir(), "panelyth-effects-"))
    const dir = join(root, "pictures")
    mkdirSync(dir)
    writeFileSync(join(dir, "scene.bmp"), bmp(200, 150, pattern))
    const notes = join(root, "notes.png")
    writeFileSync(notes, "only named like a picture")
    const { app, page } = await launchApp({ PANELYTH_TEST_ASSET_PATH: notes })
    try {
      await openViewerIn(page, dir)
      await editFirstTile(page)
      await openTool(page, "effects", "frameMask")
      await expect(page.getByTestId("stack-item")).toHaveCount(1)
      await panel(page).getByRole("combobox", { name: "Shape" }).selectOption("custom")
      await expect(page.getByText(/This file can't be used/)).toBeVisible()
      // The mask is what it was; nothing was registered.
      await expect(panel(page).getByRole("combobox", { name: "Shape" })).toHaveValue("rounded")
      await expect(panel(page).getByTestId("asset-picker")).toHaveCount(0)
    } finally {
      await app.close()
    }
  })

  test("a 24 MP picture follows the effect sliders within the frame budget", async () => {
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
      const result: Record<string, number | string> = { test: "editor-effects-24mp" }
      const longest: number[] = []
      const cases: [string, string, string][] = [
        ["obscure", "obscure", "Strength"],
        ["watermark", "watermark", "Size"],
        ["lens", "lens", "Amount"],
        ["bump", "bump", "Depth"],
        ["sketch", "sketch", "Detail"],
        ["oil", "oil", "Brush size"],
        ["frameMask", "frameMask", "Feather"],
        ["border", "border", "Width"],
      ]
      for (const [id, tool, slider] of cases) {
        await openTool(page, "effects", tool)
        await framePainted(page)
        await watch(page)
        await dragSlider(page, slider, 40)
        const settleMs = await timedFrame(page, () => page.mouse.up())
        const seen = await watched(page)
        result[`${id}Paints`] = seen.paints
        result[`${id}GapP95Ms`] = Math.round(seen.p95)
        result[`${id}SettleMs`] = settleMs
        longest.push(...seen.longTasks)
        expect(seen.paints, `${id}: frames while dragging`).toBeGreaterThan(5)
        expectWithinBudget(seen.p95, 80, `${id}: frame interval while dragging, 24 MP, p95 (ms)`)
      }
      result.longTasksOver50 = longest.filter((d) => d > 50).length
      result.maxLongTaskMs = Math.round(Math.max(0, ...longest))
      writeResult(result, 14)
      test.info().annotations.push({ type: "metrics", description: JSON.stringify(result) })
      expect(longest.filter((d) => d > 50)).toEqual([])
    } finally {
      await app.close()
    }
  })
})
