import AxeBuilder from "@axe-core/playwright"
import { appendFileSync, rmSync } from "node:fs"
import { basename, join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { expectWithinBudget, repoRoot, shellState } from "../../launch"
import { commanderOf, cursorTo, goTo, launch, mixedFolder } from "./helpers"

// Stage C02: keyboard, marks and quick search, and the shared context part 2
// (docs/commander/stages/C02-keyboard-marks-quick-search.md; scenarios 5, 6
// and 18 of docs/commander/TESTING.md). Measurements: stage-C02-…-e2e-marks.

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(repoRoot, "shared", "bench", "results", `stage-C02-${date}-e2e-marks.jsonl`)
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

const grid = (c: Page) => c.getByTestId("grid-left")
/** Names of the marked rows (their first cell; the • gutter is not a cell). */
const marked = (c: Page) =>
  grid(c)
    .locator("[data-marked=true]")
    .evaluateAll((rows) =>
      rows.map((r) => r.querySelector("[role=gridcell]")?.textContent?.trim() ?? ""),
    )
const status = (c: Page) => c.getByTestId("status-left")

test.describe("marks and quick search (Stage C02)", () => {
  test("marks with keys, mouse and masks; the status line agrees with Go", async () => {
    const root = mixedFolder()
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", root)
      await grid(c).focus()
      // Rows: .., alpha, beta, a1.jpg, a2.jpg, a3.png, notes.txt
      await c.keyboard.press("ArrowDown")
      await c.keyboard.press("Insert") // alpha, cursor to beta
      await c.keyboard.press("Space") // beta (a folder: its size is calculated)
      await expect(status(c)).toContainText("2 of 6 marked")
      await expect(grid(c).locator("[data-id]", { hasText: "beta" })).not.toContainText("<DIR>")
      await c.keyboard.press("ArrowDown")
      await c.keyboard.press("Shift+ArrowDown")
      await c.keyboard.press("Shift+ArrowDown")
      await expect(status(c)).toContainText("5 of 6 marked")
      // The marked size comes from Go: notes.txt (5 B) is not marked yet.
      await c.keyboard.press("NumpadMultiply") // invert: notes.txt only
      await expect(status(c)).toContainText("1 of 6 marked · 5 B of")
      await c.keyboard.press("Control+a")
      await expect(status(c)).toContainText("6 of 6 marked")
      await c.keyboard.press("Control+NumpadSubtract")
      await expect(status(c)).toContainText("6 entries")
      // Num+ with a mask: files only.
      await c.keyboard.press("NumpadAdd")
      await c.getByRole("textbox", { name: "Mask" }).fill("*.jpg;*.txt|a2.*")
      await c.keyboard.press("Enter")
      await expect.poll(() => marked(c)).toEqual(["a1", "notes"])
      // Closing the dialog gives the keys back to the panel.
      await expect(grid(c)).toBeFocused()
      await c.keyboard.press("NumpadSubtract")
      await c.getByRole("textbox", { name: "Mask" }).fill("*.txt")
      await c.keyboard.press("Enter")
      await expect.poll(() => marked(c)).toEqual(["a1"])
      // Ctrl+click toggles; Alt+Num+ marks the cursor's extension.
      await grid(c)
        .locator("[data-id]", { hasText: "a1" })
        .click({ modifiers: ["ControlOrMeta"] }) // Ctrl+click is a right-click on macOS
      await expect.poll(() => marked(c)).toEqual([])
      await cursorTo(c, "left", "a2")
      await c.keyboard.press("Alt+NumpadAdd")
      await expect.poll(() => marked(c)).toEqual(["a1", "a2"])
      // Screen readers: marks are aria-selected rows of a multi-select grid.
      await expect(grid(c)).toHaveAttribute("aria-multiselectable", "true")
      await expect(grid(c).locator("[aria-selected=true]")).toHaveCount(2)
      // Legacy mode runs inside the page: Electron cannot open the helper page axe wants.
      const axe = await new AxeBuilder({ page: c })
        .setLegacyMode()
        .include('[data-testid="grid-left"]')
        .analyze()
      expect(axe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([])
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("quick search: prefix, substring and wildcards; ↓ for the next match", async () => {
    const root = mixedFolder()
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", root)
      await grid(c).focus()
      await c.keyboard.type("a2")
      await expect(c.getByTestId("quicksearch-left")).toContainText("a2")
      await expect(grid(c).locator("[data-cursor=true]")).toContainText("a2")
      await c.keyboard.press("Escape")
      await expect(c.getByTestId("quicksearch-left")).toHaveCount(0)
      await c.keyboard.type("ote") // substring
      await expect(grid(c).locator("[data-cursor=true]")).toContainText("notes")
      await c.keyboard.press("Escape")
      await c.keyboard.type("a*png") // wildcard
      await expect(grid(c).locator("[data-cursor=true]")).toContainText("a3")
      await c.keyboard.press("Escape")
      await c.keyboard.press("Home")
      await c.keyboard.type("a")
      await expect(grid(c).locator("[data-cursor=true]")).toContainText("alpha")
      await c.keyboard.press("ArrowDown")
      await expect(grid(c).locator("[data-cursor=true]")).toContainText("a1")
      await c.keyboard.press("ArrowUp")
      await expect(grid(c).locator("[data-cursor=true]")).toContainText("alpha")
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("root, history, open in the other panel and swap", async () => {
    const root = mixedFolder()
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", root)
      await grid(c).focus()
      await cursorTo(c, "left", "alpha")
      await c.keyboard.press("Control+ArrowRight")
      await expect(c.getByTestId("path-right")).toHaveText(join(root, "alpha"))
      await c.keyboard.press("Enter")
      await expect(c.getByTestId("path-left")).toHaveText(join(root, "alpha"))
      await c.keyboard.press("Alt+ArrowLeft")
      await expect(c.getByTestId("path-left")).toHaveText(root)
      await c.keyboard.press("Alt+ArrowRight")
      await expect(c.getByTestId("path-left")).toHaveText(join(root, "alpha"))
      await c.keyboard.press("Control+Backslash")
      await expect(c.getByTestId("path-left")).toHaveText(/^([A-Za-z]:\\|\/)$/)
      await c.keyboard.press("Control+u")
      await expect(c.getByTestId("path-right")).toHaveText(/^([A-Za-z]:\\|\/)$/)
      await expect(c.getByTestId("path-left")).toHaveText(join(root, "alpha"))
      // F1 lists the keys; a remapped key works at once.
      await c.keyboard.press("F1")
      const help = c.getByTestId("shortcuts")
      await expect(help.locator('[data-action="mark.invert"]')).toContainText("Num*")
      await help.getByRole("button", { name: "Change shortcut for Invert marks" }).click()
      await c.keyboard.press("Control+i")
      await expect(help.locator('[data-action="mark.invert"]')).toContainText(
        process.platform === "darwin" ? "⌘I" : "Ctrl+I",
      )
      await c.keyboard.press("Escape")
      await grid(c).focus()
      await c.keyboard.press("Control+i")
      await expect(status(c)).toContainText("1 of 1 marked")
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test.describe("switching with marks (Stage C02)", () => {
  const selectedTiles = (page: Page) =>
    page
      .locator('[data-testid="tile"][aria-selected="true"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))

  test("marks and the selection carry over both ways; the viewer drops what it can't show", async () => {
    const root = mixedFolder()
    const { app, page } = await launch("viewer")
    try {
      await page.getByTestId("app-switch").click()
      const c = await commanderOf(app)
      await goTo(c, "left", root)
      await grid(c).focus()
      await c.keyboard.press("Control+a") // folders, images and notes.txt
      await c.getByTestId("app-switch").click()
      await expect.poll(() => shellState(app)).toMatchObject({ active: "viewer" })
      await expect(page.getByTestId("folder-name")).toHaveText(basename(root))
      // notes.txt is not shown by the viewer, so it is not selected there.
      await expect
        .poll(() => selectedTiles(page))
        .toEqual(["alpha", "beta", "a1.jpg", "a2.jpg", "a3.png"])

      // Viewer → commander: a two-tile selection becomes two marks.
      await page.locator('[data-testid="tile"][aria-label="a1.jpg"]').click()
      await page
        .locator('[data-testid="tile"][aria-label="a3.png"]')
        .click({ modifiers: ["ControlOrMeta"] }) // Ctrl+click is a right-click on macOS
      await page.getByTestId("app-switch").click()
      await expect.poll(() => shellState(app)).toMatchObject({ active: "commander" })
      await expect.poll(() => marked(c)).toEqual(["a1", "a3"])
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("each carry-over option can be switched off; a too large selection is not carried", async () => {
    test.setTimeout(180_000)
    const fx = ensureFixture("flat-100k", { files: 100_000, nonMediaEvery: 10 })
    const root = mixedFolder()
    const { app, page } = await launch("viewer")
    try {
      await page.getByTestId("app-switch").click()
      const c = await commanderOf(app)
      await goTo(c, "left", fx.root)
      // Ctrl+A marks what is listed; wait until all of it is.
      await expect(status(c)).toContainText("100,000 entries", { timeout: 120_000 })
      await grid(c).focus()
      await c.keyboard.press("Control+a")
      await expect(status(c)).toContainText("100,000 of 100,000 marked")
      await c.getByTestId("app-switch").click()
      await expect(page.getByText("The selection is too large to carry over")).toBeVisible()

      // Selection carry-over of ~10,000 entries (9,900 images).
      await page.getByTestId("app-switch").click()
      await expect.poll(() => shellState(app)).toMatchObject({ active: "commander" })
      await grid(c).focus()
      await c.keyboard.press("Control+NumpadSubtract")
      await c.keyboard.press("NumpadAdd")
      await c.getByRole("textbox", { name: "Mask" }).fill("IMG_1????.*;IMG_2???.*")
      await c.keyboard.press("Enter")
      await expect(status(c)).toContainText("9,900 of 100,000 marked")
      const t0 = Date.now()
      await c.getByTestId("app-switch").click()
      await expect(page.getByTestId("selection-summary")).toHaveText("9,900 selected", {
        timeout: 10_000,
      })
      writeResult({ test: "carry-selection", entries: 9900, commanderToViewerMs: Date.now() - t0 })

      // Settings → General: carrying the folder off.
      await page.getByRole("button", { name: "Settings" }).click()
      await page.getByRole("tab", { name: "General" }).click()
      await page.getByRole("switch", { name: "The folder" }).click()
      await page.keyboard.press("Escape")
      await page.getByTestId("app-switch").click()
      await expect.poll(() => shellState(app)).toMatchObject({ active: "commander" })
      await goTo(c, "left", root)
      await c.getByTestId("app-switch").click()
      await expect.poll(() => shellState(app)).toMatchObject({ active: "viewer" })
      await page.waitForTimeout(500)
      await expect(page.getByTestId("folder-name")).not.toHaveText(basename(root))
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

test.describe("C02 benchmarks", () => {
  test("held arrow, quick search, mark all and invert on 100k; folder sizes of tree-50k", async () => {
    test.setTimeout(300_000)
    const fx = ensureFixture("flat-100k", { files: 100_000, nonMediaEvery: 10 })
    const tree = ensureFixture("tree-50k", { files: 200, depth: 3, fanout: 6, nonMediaEvery: 10 })
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", fx.root)
      await expect(status(c)).toContainText("100,000 entries", { timeout: 120_000 })
      await grid(c).focus()

      // Held arrow: one key per frame for 3 s.
      const held = await c.evaluate(async () => {
        const g = document.querySelector<HTMLElement>('[data-testid="grid-left"]')!
        const long: number[] = []
        const po = new PerformanceObserver((l) =>
          l.getEntries().forEach((e) => long.push(e.duration)),
        )
        po.observe({ type: "longtask" })
        const gaps: number[] = []
        let last = performance.now()
        const end = last + 3000
        while (performance.now() < end) {
          g.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
          await new Promise(requestAnimationFrame)
          const t = performance.now()
          gaps.push(t - last)
          last = t
        }
        po.disconnect()
        gaps.sort((a, b) => a - b)
        return {
          keys: gaps.length,
          p95FrameMs: Math.round(gaps[Math.floor(gaps.length * 0.95)]!),
          maxFrameGapMs: Math.round(gaps.at(-1)!),
          longTasks: long.length,
          cursorRow: Number(g.querySelector("[data-cursor=true]")?.getAttribute("data-row")),
        }
      })

      // Quick search: keystroke → cursor on the match (prefixes spread over the folder).
      const search = await c.evaluate(async () => {
        const g = document.querySelector<HTMLElement>('[data-testid="grid-left"]')!
        const cursorId = () => g.querySelector("[data-cursor=true]")?.getAttribute("data-row")
        const times: number[] = []
        for (const word of ["IMG_9", "IMG_45", "IMG_123", "notes_77", "IMG_1", "IMG_88"]) {
          g.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
          for (const ch of word) {
            const before = cursorId()
            const t0 = performance.now()
            g.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }))
            const end = t0 + 2000
            while (cursorId() === before && performance.now() < end) {
              await new Promise(requestAnimationFrame)
            }
            if (cursorId() !== before) times.push(performance.now() - t0)
          }
        }
        g.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
        times.sort((a, b) => a - b)
        return {
          samples: times.length,
          all: times.map(Math.round),
          p50Ms: Math.round(times[Math.floor(times.length / 2)]!),
          p95Ms: Math.round(times[Math.floor(times.length * 0.95)]!),
          maxMs: Math.round(times.at(-1)!),
        }
      })

      // Mark all and invert: key → status line updated.
      const markMs = async (key: string, text: string): Promise<number> => {
        const t0 = Date.now()
        await c.keyboard.press(key)
        await expect(status(c)).toContainText(text)
        return Date.now() - t0
      }
      const markAllMs = await markMs("Control+a", "100,000 of 100,000 marked")
      const invertMs = await markMs("NumpadMultiply", "100,000 entries")
      const invertBackMs = await markMs("NumpadMultiply", "100,000 of 100,000 marked")

      // Folder sizes of tree-50k (Go's job timestamps).
      await goTo(c, "right", tree.root)
      const sizes = await c.evaluate(async () => {
        const api = window.fastview as unknown as {
          onEvent(
            ch: string,
            l: (p: {
              kind: string
              state: string
              startedMs: number
              finishedMs: number
              done: number
            }) => void,
          ): () => void
        }
        const g = document.querySelector<HTMLElement>('[data-testid="grid-right"]')!
        g.focus()
        return new Promise<{ ms: number; folders: number }>((resolve) => {
          const off = api.onEvent("job.progress", (p) => {
            if (p.kind === "dirSize" && p.state === "completed") {
              off()
              resolve({ ms: p.finishedMs - p.startedMs, folders: p.done })
            }
          })
          g.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              altKey: true,
              shiftKey: true,
              bubbles: true,
            }),
          )
        })
      })
      const treeFiles = tree.expected.Media + tree.expected.NonMedia
      const result = {
        test: "c02-benchmarks",
        held,
        quickSearch: search,
        markAllMs,
        invertMs,
        invertBackMs,
        folderSizes: {
          ...sizes,
          files: treeFiles,
          filesPerSecond: Math.round(treeFiles / (sizes.ms / 1000)),
        },
      }
      writeResult(result)
      expectWithinBudget(held.longTasks, 1, "C02 held arrow, long tasks")
      expectWithinBudget(
        search.p95Ms,
        100,
        "C02 quick search p95 (ms; budget 50 on the reference machine)",
      )
    } finally {
      await app.close()
    }
  })
})
