import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { expectWithinBudget, repoRoot } from "../../launch"
import { commanderOf, goTo, launch } from "./helpers"

// Stage C07: archives (docs/commander/stages/C07-archives.md; scenario 13 of
// docs/commander/TESTING.md). Measurements go to stage-C07-…-e2e-archives.

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(repoRoot, "shared", "bench", "results", `stage-C07-${date}-e2e-archives.jsonl`)
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

const grid = (c: Page) => c.getByTestId("grid-left")
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The left panel's row of an entry: its name and extension cells match exactly. */
function row(c: Page, name: string, dir = false) {
  const dot = dir ? -1 : name.lastIndexOf(".")
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot + 1)] : [name, ""]
  const cell = (n: number, text: string) =>
    c.locator(`[role=gridcell]:nth-child(${n})`, { hasText: new RegExp(`^${escape(text)}$`) })
  return grid(c)
    .locator("[data-id]")
    .filter({ has: cell(2, base) })
    .filter({ has: cell(3, ext) })
}

async function cursorTo(c: Page, name: string, dir = false): Promise<void> {
  const r = row(c, name, dir)
  await r.click()
  const id = await r.getAttribute("data-id")
  await expect(grid(c).locator("[data-cursor=true]")).toHaveAttribute("data-id", id!)
}

/** The archive samples, a loose file to pack, in a folder of their own. */
function sampleFolder(): string {
  const fixture = ensureFixture("archives-c07", { files: 0, archives: { samples: true } })
  const root = mkdtempSync(join(tmpdir(), "panelyth-c07-"))
  for (const name of ["set.zip", "set.tar.gz", "slip.zip"])
    cpSync(join(fixture.root, name), join(root, name))
  writeFileSync(join(root, "loose.txt"), "pack me\n")
  return root
}

test.describe("archives (Stage C07)", () => {
  test("scenario 13: enter zip and tar.gz, extract, pack, test; refuse a zip-slip archive", async () => {
    test.setTimeout(120_000)
    const root = sampleFolder()
    const dst = mkdtempSync(join(tmpdir(), "panelyth-c07-dst-"))
    writeFileSync(join(dst, "keep.txt"), "") // goTo waits for a row
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "right", dst)
      await goTo(c, "left", root)

      // Enter the zip, a folder inside it, and view a file (F3).
      await cursorTo(c, "set.zip")
      await c.keyboard.press("Enter")
      await expect(c.getByTestId("path-left")).toHaveText(join(root, "set.zip"))
      await expect(row(c, "docs", true)).toBeVisible()
      await expect(row(c, "notes.txt")).toBeVisible()
      await cursorTo(c, "docs", true)
      await c.keyboard.press("Enter")
      await expect(c.getByTestId("path-left")).toHaveText(join(root, "set.zip", "docs"))
      await cursorTo(c, "readme.txt")
      await c.keyboard.press("F3")
      await expect(c.getByTestId("lister")).toContainText("read me first")
      await c.keyboard.press("Escape")
      await expect(c.getByTestId("lister")).toHaveCount(0)
      // Closing the lister gives the panel its focus back (keys go nowhere before).
      await expect(grid(c)).toBeFocused()

      // Archives are read-only.
      await c.keyboard.press("F8")
      await expect(c.getByTestId("files-notice")).toContainText("read-only")
      await expect(c.getByTestId("delete-dialog")).toHaveCount(0)

      // Back to the root (cursor on docs), copy docs out with F5.
      await c.keyboard.press("Backspace")
      await expect(grid(c).locator("[data-cursor=true]")).toContainText("docs")
      await c.keyboard.press("F5")
      await expect(c.getByRole("dialog")).toContainText("out of the archive")
      await c.keyboard.press("Enter")
      await expect
        .poll(() => existsSync(join(dst, "docs", "sub", "deep.txt")), { timeout: 30_000 })
        .toBe(true)
      expect(readFileSync(join(dst, "docs", "sub", "deep.txt"), "utf8")).toBe("deep inside\n")

      // Leave the archive: the cursor is on it. Then the tar.gz.
      await grid(c).focus()
      await c.keyboard.press("Backspace")
      await expect(c.getByTestId("path-left")).toHaveText(root)
      await expect(grid(c).locator("[data-cursor=true]")).toContainText("set")
      await cursorTo(c, "set.tar.gz")
      await c.keyboard.press("Enter")
      await expect(c.getByTestId("path-left")).toHaveText(join(root, "set.tar.gz"))
      await expect(row(c, "notes.txt")).toBeVisible()
      await c.keyboard.press("Backspace")
      await expect(c.getByTestId("path-left")).toHaveText(root)

      // Pack a file into the other panel's folder (Alt+F5).
      await cursorTo(c, "loose.txt")
      await c.keyboard.press("Alt+F5")
      await expect(c.getByTestId("pack-dialog").getByLabel("Archive name")).toHaveValue("loose.zip")
      await c.keyboard.press("Enter")
      await expect.poll(() => existsSync(join(dst, "loose.zip")), { timeout: 30_000 }).toBe(true)

      // Test the zip (Alt+Shift+F9).
      await grid(c).focus()
      await cursorTo(c, "set.zip")
      await c.keyboard.press("Alt+Shift+F9")
      await expect(c.getByTestId("files-notice")).toContainText("1 archive tested: no errors", {
        timeout: 30_000,
      })

      // The zip-slip archive: its unsafe entry is not listed, and unpacking
      // it (each into its own folder) writes only the safe one.
      await cursorTo(c, "slip.zip")
      await c.keyboard.press("Enter")
      await expect(row(c, "good.txt")).toBeVisible()
      await expect(grid(c).locator("[data-id]")).toHaveCount(1)
      await c.keyboard.press("Backspace")
      await cursorTo(c, "slip.zip")
      await c.keyboard.press("Alt+F9")
      const unpack = c.getByTestId("unpack-dialog")
      await expect(unpack.getByTestId("unpack-size")).toContainText("1 file")
      await unpack.getByLabel(/each archive into its own folder/).check()
      await unpack.getByRole("button", { name: "Unpack" }).click()
      await expect
        .poll(() => existsSync(join(dst, "slip", "good.txt")), { timeout: 30_000 })
        .toBe(true)
      for (const p of [
        join(dst, "escaped.txt"),
        join(dst, "..", "escaped.txt"),
        join(root, "escaped.txt"),
      ]) {
        expect(existsSync(p), p).toBe(false)
      }
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
      rmSync(dst, { recursive: true, force: true })
    }
  })

  test("a 100k-entry zip opens like a folder (benchmark)", async () => {
    test.setTimeout(300_000)
    const fixture = ensureFixture("archive-100k-c07", {
      files: 0,
      archives: { zipEntries: 100_000 },
    })
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", fixture.root)
      await cursorTo(c, "many.zip")
      const ms = await c.evaluate(() => {
        const g = document.querySelector<HTMLElement>('[data-testid="grid-left"]')!
        const t0 = performance.now()
        g.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
        return new Promise<number>((resolve, reject) => {
          const tick = (): void => {
            const path = document.querySelector('[data-testid="path-left"]')?.textContent ?? ""
            if (path.endsWith("many.zip") && g.querySelector("[data-id]"))
              resolve(performance.now() - t0)
            else if (performance.now() - t0 > 60_000) reject(new Error("the archive did not open"))
            else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
      })
      // 100 folders of 1,000 entries each.
      await expect(grid(c).locator("[data-id]").first()).toContainText("folder00")
      await cursorTo(c, "folder01", true)
      await c.keyboard.press("Enter")
      await expect(c.getByTestId("path-left")).toHaveText(
        join(fixture.root, "many.zip", "folder01"),
      )
      writeResult({
        metric: "open 100k-entry zip, Enter → first rows",
        ms: Math.round(ms),
        budgetMs: 1000,
      })
      expectWithinBudget(ms, 1000, "C07 100k-entry zip open (ms)")
    } finally {
      await app.close()
    }
  })
})
