import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { repoRoot } from "../../launch"
import { commanderOf, goTo, launch, type Side } from "./helpers"

// Stage C06: find files, branch view and quick filter
// (docs/commander/stages/C06-find-and-branch-view.md; scenario 12 of
// docs/commander/TESTING.md). Measurements go to stage-C06-…-e2e-find.

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(repoRoot, "shared", "bench", "results", `stage-C06-${date}-e2e-find.jsonl`)
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

/** docs/{readme,deep/notes,deep/wide}.txt, src/main.go, img.jpg and a binary file. */
function findTree(): string {
  const root = mkdtempSync(join(tmpdir(), "fastview-c06-"))
  mkdirSync(join(root, "docs", "deep"), { recursive: true })
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "docs", "readme.txt"), "hello world")
  writeFileSync(join(root, "docs", "deep", "notes.txt"), "Hello Find")
  // UTF-16 LE with a byte order mark.
  writeFileSync(
    join(root, "docs", "deep", "wide.txt"),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a needle here", "utf16le")]),
  )
  writeFileSync(join(root, "src", "main.go"), "package main // needle")
  writeFileSync(join(root, "img.jpg"), "")
  writeFileSync(join(root, "bin.dat"), Buffer.from("needle\0\0\0binary\0", "latin1"))
  return root
}

const grid = (c: Page, side: Side = "left") => c.getByTestId(`grid-${side}`)

async function startSearch(c: Page, mask: string, text = ""): Promise<void> {
  const d = c.getByTestId("find-dialog")
  await d.getByLabel("Search for").fill(mask)
  await d.getByLabel("Find text").fill(text)
  await d.getByRole("button", { name: "Start search" }).click()
  await expect(c.getByTestId("find-status")).toContainText("Done", { timeout: 30_000 })
}

/**
 * Presses a chord on the panel grid and returns the time until `done`
 * holds in the page (in-page clock, polled per frame).
 */
async function timeKey(
  c: Page,
  init: { key: string; ctrlKey?: boolean },
  done: string,
): Promise<number> {
  return c.evaluate(
    ({ init, done }) => {
      const g = document.querySelector<HTMLElement>('[data-testid="grid-left"]')!
      const check = new Function(`return (${done})`) as () => boolean
      const t0 = performance.now()
      g.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }))
      return new Promise<number>((resolve, reject) => {
        const tick = (): void => {
          if (check()) resolve(performance.now() - t0)
          else if (performance.now() - t0 > 60_000) reject(new Error(`timed out: ${done}`))
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    },
    { init, done },
  )
}

test.describe("find files, branch view, quick filter (Stage C06)", () => {
  test("scenario 12: find by name and content, feed to panel and copy, branch view", async () => {
    test.setTimeout(120_000)
    const root = findTree()
    const dst = mkdtempSync(join(tmpdir(), "fastview-c06-dst-"))
    // goTo waits for a row.
    writeFileSync(join(dst, "keep.txt"), "")
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "right", dst)
      await goTo(c, "left", root)
      await grid(c).focus()

      // By name: every .txt below, with the folder shown.
      await c.keyboard.press("Alt+F7")
      await expect(c.getByTestId("find-dialog").getByLabel("Search in")).toHaveValue(root)
      await startSearch(c, "*.txt")
      await expect(c.getByRole("option")).toHaveCount(3)
      await expect(c.getByRole("listbox", { name: "Search results" })).toContainText("notes.txt")

      // By content: UTF-8 and UTF-16 hits; the binary file is skipped.
      await c.getByRole("button", { name: "New search" }).click()
      await startSearch(c, "*", "needle")
      await expect(c.getByRole("option")).toHaveCount(2)
      const list = c.getByRole("listbox", { name: "Search results" })
      await expect(list).toContainText("wide.txt")
      await expect(list).toContainText("main.go")
      await expect(list).not.toContainText("bin.dat")

      // Feed to panel, mark everything, copy to the other panel.
      await c.getByRole("button", { name: "Feed to panel" }).click()
      await expect(c.getByTestId("location-left")).toContainText("Search results")
      await expect(grid(c).locator("[data-id]")).toHaveCount(2)
      await grid(c).focus()
      await c.keyboard.press("Control+a")
      await c.keyboard.press("F5")
      await expect(c.getByTestId("copy-dialog")).toBeVisible()
      await c.getByTestId("copy-dialog").getByLabel("Destination").fill(dst)
      await c.keyboard.press("Enter")
      await expect.poll(() => existsSync(join(dst, "main.go")), { timeout: 30_000 }).toBe(true)
      await expect.poll(() => existsSync(join(dst, "wide.txt")), { timeout: 30_000 }).toBe(true)

      // Back to the folder, then the branch view: every file below.
      await grid(c).focus()
      await c.keyboard.press("Backspace")
      await expect(c.getByTestId("location-left")).toHaveCount(0)
      await c.keyboard.press("Control+b")
      await expect(c.getByTestId("location-left")).toHaveText("Branch view")
      await expect(grid(c).locator("[data-id]")).toHaveCount(6)
      await expect(grid(c)).toContainText("deep")
      await c.keyboard.press("Control+b")
      await expect(c.getByTestId("location-left")).toHaveCount(0)

      // Quick filter: folders stay, files match the mask.
      await c.keyboard.press("Control+s")
      await c.getByLabel("Quick filter").fill("*.jpg")
      await c.keyboard.press("Enter")
      await expect(c.getByTestId("filter-left")).toContainText("*.jpg")
      await expect(grid(c).locator("[data-id]")).toHaveCount(3)
      await c.getByTestId("filter-left").click()
      await expect(grid(c).locator("[data-id]")).toHaveCount(4)
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
      rmSync(dst, { recursive: true, force: true })
    }
  })
})

test.describe("C06 benchmarks", () => {
  test("branch view of tree-50k, quick filter on 100k, find by name in the app", async () => {
    test.setTimeout(600_000)
    const flat = ensureFixture("flat-100k", { files: 100_000, nonMediaEvery: 10 })
    const tree = ensureFixture("tree-50k", { files: 200, depth: 3, fanout: 6, nonMediaEvery: 10 })
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)

      // Quick filter on 100k: keystroke to the first filtered page (no rescan).
      await goTo(c, "left", flat.root)
      await expect(c.getByTestId("status-left")).toContainText("100,000 entries", {
        timeout: 120_000,
      })
      await grid(c).focus()
      await c.keyboard.press("Control+s")
      const filterMs = await c.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('input[aria-label="Quick filter"]')!
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
        setter.call(input, "IMG_12*")
        const t0 = performance.now()
        input.dispatchEvent(new Event("input", { bubbles: true }))
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
        return new Promise<number>((resolve, reject) => {
          const tick = (): void => {
            const rows = [...document.querySelectorAll('[data-testid="grid-left"] [data-id]')]
            // The name cell (the extension is a column of its own).
            const matches = (r: Element): boolean =>
              /^IMG_12/.test(r.querySelector('[data-column="name"]')?.textContent ?? "")
            if (rows.length > 0 && rows.every(matches)) resolve(performance.now() - t0)
            else if (performance.now() - t0 > 30_000)
              reject(
                new Error(
                  `filter timed out: ${rows
                    .slice(0, 3)
                    .map((r) =>
                      [...r.querySelectorAll("[data-column]")]
                        .map((x) => `${x.getAttribute("data-column")}=${x.textContent}`)
                        .join(","),
                    )
                    .join(
                      " | ",
                    )} chip=${document.querySelector('[data-testid="filter-left"]')?.textContent}`,
                ),
              )
            else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
      })
      await c.getByTestId("filter-left").click()

      // Branch view of tree-50k: Ctrl+B to the first page of files (cold, then warm).
      await goTo(c, "left", tree.root)
      await grid(c).focus()
      const branchDone = `document.querySelector('[data-testid="location-left"]') && document.querySelectorAll('[data-testid="grid-left"] [data-id]').length > 0`
      const branchColdMs = await timeKey(c, { key: "b", ctrlKey: true }, branchDone)
      await expect(c.getByTestId("status-left")).toContainText("entries", { timeout: 120_000 })
      await c.keyboard.press("Control+b")
      await expect(c.getByTestId("location-left")).toHaveCount(0)
      const branchWarmMs = await timeKey(c, { key: "b", ctrlKey: true }, branchDone)
      await c.keyboard.press("Control+b")

      // Find by name over tree-50k: Start to the first result row, and to Done.
      await grid(c).focus()
      await c.keyboard.press("Alt+F7")
      const d = c.getByTestId("find-dialog")
      await d.getByLabel("Search for").fill("*.jpg")
      const findMs = await c.evaluate(() => {
        const start = [...document.querySelectorAll("button")].find(
          (b) => b.textContent === "Start search",
        )!
        const t0 = performance.now()
        start.click()
        let first = -1
        return new Promise<{ firstResultMs: number; doneMs: number }>((resolve, reject) => {
          const tick = (): void => {
            const now = performance.now() - t0
            if (first < 0 && document.querySelector('[role="option"] span')) first = now
            const status = document.querySelector('[data-testid="find-status"]')?.textContent ?? ""
            if (/^Done/.test(status)) resolve({ firstResultMs: first, doneMs: now })
            else if (now > 120_000) reject(new Error("find timed out"))
            else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
      })
      const status = await c.getByTestId("find-status").innerText()
      // The list converges on Go's count once the last refresh arrives.
      const found = Number(/([\d,]+) found/.exec(status)![1]!.replace(/,/g, ""))
      expect(found).toBeGreaterThan(10_000)
      await expect
        .poll(() =>
          c.evaluate(() =>
            Math.round(
              document.querySelector('[role="listbox"] > div')!.getBoundingClientRect().height / 22,
            ),
          ),
        )
        .toBe(found)
      await c.keyboard.press("Escape")

      const result = {
        test: "c06-bench",
        quickFilter100kMs: Math.round(filterMs),
        branchTree50kColdMs: Math.round(branchColdMs),
        branchTree50kWarmMs: Math.round(branchWarmMs),
        findTree50k: { ...findMs, status },
      }
      writeResult(result)
      // Budgets: docs/commander/PERFORMANCE.md.
      expect(filterMs).toBeLessThan(300)
      expect(findMs.firstResultMs).toBeGreaterThanOrEqual(0)
      expect(findMs.firstResultMs).toBeLessThan(300)
    } finally {
      await app.close()
    }
  })
})
