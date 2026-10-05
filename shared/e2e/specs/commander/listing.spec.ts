import { execFileSync } from "node:child_process"
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { commanderPage, launchApp, repoRoot, shellState, waitForReady } from "../../launch"

// Stage C01: panels and listing, and the shared context part 1
// (docs/commander/stages/C01-panels-and-listing.md; scenarios 1-4, 16 and 18
// of docs/commander/TESTING.md). Measurements go to stage-C01-…-e2e-listing.

type Side = "left" | "right"

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(repoRoot, "shared", "bench", "results", `stage-C01-${date}-e2e-listing.jsonl`)
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

/** A small mixed folder: two subfolders, images, a text file and a hidden file. */
function mixedFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "fastview-c01-"))
  mkdirSync(join(root, "alpha"))
  mkdirSync(join(root, "beta"))
  writeFileSync(join(root, "alpha", "inner.txt"), "x")
  for (const name of ["a1.jpg", "a2.jpg", "a3.png"]) writeFileSync(join(root, name), "")
  writeFileSync(join(root, "notes.txt"), "hello")
  const hidden = join(root, process.platform === "win32" ? "secret.txt" : ".secret.txt")
  writeFileSync(hidden, "")
  if (process.platform === "win32") execFileSync("attrib", ["+h", hidden])
  return root
}

function folderOf(files: number): string {
  const root = mkdtempSync(join(tmpdir(), `fastview-c01-${files}-`))
  for (let i = 0; i < files; i++)
    writeFileSync(join(root, `f${String(i).padStart(5, "0")}.txt`), "")
  return root
}

/** Launches with the commander enabled; reuses profile dirs when given. */
async function launch(start: "viewer" | "commander" | "", dirs: Record<string, string> = {}) {
  const launched = await launchApp({
    FASTVIEW_COMMANDER: "1",
    FASTVIEW_START_APP: start,
    ...dirs,
  })
  await waitForReady(launched.page)
  return launched
}

/**
 * Navigates a panel through its path bar and returns the time from Enter
 * to the first entry row painted with the new folder (in-page clock).
 */
async function goTo(c: Page, side: Side, path: string): Promise<number> {
  await c.getByTestId(`path-${side}`).click()
  await c.getByRole("textbox", { name: "Path" }).fill(path)
  return c.evaluate(
    ({ side, path }) => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Path"]')!
      const t0 = performance.now()
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      return new Promise<number>((resolve, reject) => {
        const tick = (): void => {
          const shown = document.querySelector(`[data-testid="path-${side}"]`)?.textContent ?? ""
          const grid = document.querySelector(`[data-testid="grid-${side}"]`)
          if (shown.toLowerCase() === path.toLowerCase() && grid?.querySelector("[data-id]")) {
            resolve(performance.now() - t0)
          } else if (performance.now() - t0 > 30_000) reject(new Error(`no rows for ${path}`))
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    },
    { side, path },
  )
}

/** Puts the cursor on the row whose name cell starts with `name`. */
async function cursorTo(c: Page, side: Side, name: string): Promise<void> {
  const grid = c.getByTestId(`grid-${side}`)
  await grid.locator("[data-id]", { hasText: name }).first().click()
  await expect(grid.locator("[data-cursor=true]")).toContainText(name)
}

interface ScrollResult {
  frames: number
  p95FrameMs: number
  maxFrameGapMs: number
  longTasks: number
  longTaskMaxMs: number
  maxMountedRows: number
}

/** Scrolls a panel's body for `ms`, counting frames, long tasks and mounted rows. */
function scrollPanel(c: Page, side: Side, ms: number, pxPerFrame: number): Promise<ScrollResult> {
  return c.evaluate(
    async ({ side, ms, pxPerFrame }) => {
      const grid = document.querySelector<HTMLElement>(`[data-testid="grid-${side}"]`)!
      const body = grid.children[1] as HTMLElement
      const long: number[] = []
      const po = new PerformanceObserver((l) =>
        l.getEntries().forEach((e) => long.push(e.duration)),
      )
      po.observe({ type: "longtask" })
      const gaps: number[] = []
      let maxRows = 0
      await new Promise<void>((resolve) => {
        const start = performance.now()
        let last = start
        const tick = (t: number): void => {
          gaps.push(t - last)
          last = t
          maxRows = Math.max(maxRows, grid.querySelectorAll("[data-row]").length)
          body.scrollTop += pxPerFrame
          if (t - start < ms) requestAnimationFrame(tick)
          else resolve()
        }
        requestAnimationFrame(tick)
      })
      await new Promise((r) => setTimeout(r, 300))
      po.disconnect()
      const sorted = gaps.slice(1).sort((a, b) => a - b)
      return {
        frames: sorted.length,
        p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
        maxFrameGapMs: Math.round(sorted.at(-1) ?? 0),
        longTasks: long.length,
        longTaskMaxMs: Math.round(Math.max(0, ...long)),
        maxMountedRows: maxRows,
      }
    },
    { side, ms, pxPerFrame },
  )
}

const visibleRows = (c: Page, side: Side) =>
  c.evaluate((side) => {
    const grid = document.querySelector<HTMLElement>(`[data-testid="grid-${side}"]`)!
    const body = grid.children[1] as HTMLElement
    const row = grid.querySelector<HTMLElement>("[data-row]")
    return Math.ceil(body.clientHeight / (row?.offsetHeight || 22))
  }, side)

async function commanderOf(app: ElectronApplication): Promise<Page> {
  const c = await commanderPage(app)
  await expect(c.getByTestId("sidecar-status")).toHaveAttribute("data-state", "ready", {
    timeout: 15_000,
  })
  return c
}

test.describe("commander listing (Stage C01)", () => {
  test("starts in the home folder, lists every entry with columns and the .. row", async () => {
    const root = mixedFolder()
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      // Scenario 1 (first run): both panels open the home folder.
      await expect(c.getByTestId("path-left")).not.toHaveText("No folder open", { timeout: 15_000 })
      await expect(c.getByTestId("path-right")).toHaveText(
        (await c.getByTestId("path-left").innerText()).trim(),
      )
      await goTo(c, "left", root)
      const grid = c.getByTestId("grid-left")
      await expect(grid.locator("[data-row]").first()).toContainText("..")
      // Every entry of the all scope; hidden ones only after Ctrl+H.
      await expect(grid.locator("[data-id]")).toHaveCount(6)
      await expect(grid.locator("[data-id]").nth(0)).toContainText("alpha")
      await expect(grid.locator("[data-id]").nth(0)).toContainText("<DIR>")
      await expect(grid.locator("[data-id]", { hasText: "notes" })).toContainText("txt")
      await expect(grid.locator("[data-id]", { hasText: "notes" })).toContainText("5")
      await expect(c.getByTestId("status-left")).toContainText("6 entries")
      await expect(c.getByTestId("free-left")).toContainText("free")
      await grid.focus()
      await c.keyboard.press("Control+h")
      await expect(grid.locator("[data-id]")).toHaveCount(7)
      await expect(grid.locator("[data-id]", { hasText: "secret" })).toHaveClass(/text-muted/)
      await c.keyboard.press("Control+h")
      await expect(grid.locator("[data-id]")).toHaveCount(6)

      // Enter, then Backspace back with the cursor on the folder just left.
      await c.keyboard.press("Home")
      await c.keyboard.press("ArrowDown")
      await expect(grid.locator("[data-cursor=true]")).toContainText("alpha")
      await c.keyboard.press("Enter")
      await expect(c.getByTestId("path-left")).toHaveText(join(root, "alpha"))
      await expect(grid.locator("[data-id]")).toHaveCount(1)
      await c.keyboard.press("Backspace")
      await expect(c.getByTestId("path-left")).toHaveText(root)
      await expect(grid.locator("[data-cursor=true]")).toContainText("alpha")
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("sorts in Go by each column and back; folders stay first", async () => {
    const root = mixedFolder()
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", root)
      const grid = c.getByTestId("grid-left")
      const names = () => grid.locator("[data-id]").allInnerTexts()
      const header = (name: string) => grid.getByRole("button", { name: new RegExp(`^${name}`) })
      for (const column of ["Size", "Ext", "Date", "Attr", "Name"]) {
        await header(column).click()
        await expect(
          grid.getByRole("columnheader", { name: new RegExp(`^${column}`) }),
        ).toHaveAttribute("aria-sort", "ascending")
        const rows = await names()
        expect(rows.slice(0, 2).sort(), column).toEqual([
          expect.stringContaining("alpha"),
          expect.stringContaining("beta"),
        ])
      }
      // Again reverses; folders stay first.
      await header("Name").click()
      await expect(grid.getByRole("columnheader", { name: /^Name/ })).toHaveAttribute(
        "aria-sort",
        "descending",
      )
      expect((await names())[0]).toContain("beta")
      expect((await names())[2]).toContain("notes")
      // Ctrl+F6 sorts by size; again reverses.
      await grid.focus()
      await c.keyboard.press("Control+F6")
      await c.keyboard.press("Control+F6")
      await expect(grid.getByRole("columnheader", { name: /^Size/ })).toHaveAttribute(
        "aria-sort",
        "descending",
      )
      await expect(grid.locator("[data-id]").nth(2)).toContainText("notes")
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("resizes columns and restores folders, sorts and widths after a restart", async () => {
    const root = mixedFolder()
    const profile = mkdtempSync(join(tmpdir(), "fastview-e2e-profile-"))
    const dirs = {
      FASTVIEW_CONFIG_DIR: join(profile, "config"),
      FASTVIEW_USER_DATA_DIR: join(profile, "user-data"),
    }
    try {
      let { app } = await launch("commander", dirs)
      let c = await commanderOf(app)
      await goTo(c, "right", root)
      const grid = c.getByTestId("grid-right")
      await grid.getByRole("button", { name: /^Size/ }).click()
      const handle = grid.getByTestId("resize-ext")
      const box = (await handle.boundingBox())!
      await c.mouse.move(box.x + 2, box.y + 5)
      await c.mouse.down()
      await c.mouse.move(box.x + 42, box.y + 5, { steps: 4 })
      await c.mouse.up()
      const width = await grid.evaluate((el) => el.style.getPropertyValue("--col-ext"))
      expect(width).not.toBe("64px")
      await c.waitForTimeout(800) // the panels setting is written after a quiet period
      await app.close()

      ;({ app } = await launch("commander", dirs))
      c = await commanderOf(app)
      await expect(c.getByTestId("path-right")).toHaveText(root, { timeout: 15_000 })
      const restored = c.getByTestId("grid-right")
      await expect(restored.getByRole("columnheader", { name: /^Size/ })).toHaveAttribute(
        "aria-sort",
        "ascending",
      )
      expect(await restored.evaluate((el) => el.style.getPropertyValue("--col-ext"))).toBe(width)
      await app.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(profile, { recursive: true, force: true })
    }
  })

  test("shows not found, inline path errors and an empty folder", async () => {
    const root = mixedFolder()
    const empty = mkdtempSync(join(tmpdir(), "fastview-c01-empty-"))
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      // The path bar shows errors inline and keeps the listing.
      await goTo(c, "left", root)
      await c.getByTestId("path-left").click()
      await c.getByRole("textbox", { name: "Path" }).fill(join(root, "missing"))
      await c.keyboard.press("Enter")
      await expect(c.getByRole("alert")).toContainText("doesn't exist")
      await c.keyboard.press("Escape")
      await expect(c.getByTestId("grid-left").locator("[data-id]")).toHaveCount(6)

      // A folder deleted under the panel: refresh shows "not found" (scenario 16).
      const doomed = join(root, "beta")
      await c.getByTestId("grid-left").locator("[data-id]", { hasText: "beta" }).dblclick()
      await expect(c.getByTestId("path-left")).toHaveText(doomed)
      rmSync(doomed, { recursive: true })
      await c.getByTestId("grid-left").focus()
      await c.keyboard.press("Control+r")
      await expect(c.getByTestId("error-left")).toHaveAttribute("data-kind", "notFound")
      await c.getByTestId("error-left").getByRole("button", { name: "Back" }).click()
      await expect(c.getByTestId("error-left")).toHaveCount(0)

      // Empty folder state.
      await c.getByTestId("path-right").click()
      await c.getByRole("textbox", { name: "Path" }).fill(empty)
      await c.keyboard.press("Enter")
      await expect(c.getByTestId("panel-right")).toContainText("This folder is empty")
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test("lists 100k entries in one panel while the other stays responsive; bounded rows", async () => {
    test.setTimeout(240_000)
    const fx = ensureFixture("flat-100k", { files: 100_000, nonMediaEvery: 10 })
    const small = folderOf(1000)
    const other = folderOf(1000)
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      // Folder enter budgets: 1k uncached, 1k cached (listed before), 100k first rows.
      const uncached1kMs = await goTo(c, "left", small)
      await goTo(c, "left", other)
      const cached1k: number[] = []
      for (let i = 0; i < 5; i++) {
        cached1k.push(await goTo(c, "left", i % 2 ? other : small))
      }

      // Scenario 2: the right panel answers keys while the left lists 100k.
      await goTo(c, "right", small)
      await c.getByTestId("path-left").click()
      await c.getByRole("textbox", { name: "Path" }).fill(fx.root)
      const responsiveness = await c.evaluate(async (path) => {
        const input = document.querySelector<HTMLInputElement>('input[aria-label="Path"]')!
        const long: number[] = []
        const po = new PerformanceObserver((l) =>
          l.getEntries().forEach((e) => long.push(e.duration)),
        )
        po.observe({ type: "longtask" })
        const t0 = performance.now()
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
        const left = document.querySelector(`[data-testid="grid-left"]`)!
        const right = document.querySelector<HTMLElement>(`[data-testid="grid-right"]`)!
        let firstRowsMs = 0
        while (!firstRowsMs) {
          await new Promise(requestAnimationFrame)
          const shown = document.querySelector(`[data-testid="path-left"]`)?.textContent ?? ""
          if (shown.toLowerCase() === path.toLowerCase() && left.querySelector("[data-id]")) {
            firstRowsMs = performance.now() - t0
          }
          if (performance.now() - t0 > 30_000) throw new Error("100k rows never painted")
        }
        // Keys in the right panel while the left one streams in.
        right.focus()
        const keyMs: number[] = []
        for (let i = 0; i < 20; i++) {
          const before = right.querySelector("[data-cursor=true]")?.getAttribute("data-row")
          const k0 = performance.now()
          right.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
          while (right.querySelector("[data-cursor=true]")?.getAttribute("data-row") === before) {
            await new Promise(requestAnimationFrame)
          }
          keyMs.push(performance.now() - k0)
        }
        po.disconnect()
        keyMs.sort((a, b) => a - b)
        return {
          firstRowsMs: Math.round(firstRowsMs),
          keyP95Ms: Math.round(keyMs[Math.floor(keyMs.length * 0.95)]!),
          keyMaxMs: Math.round(keyMs.at(-1)!),
          longTasks: long.length,
          longTaskMaxMs: Math.round(Math.max(0, ...long)),
        }
      }, fx.root)
      await expect(c.getByTestId("status-left")).toContainText("100,000 entries", {
        timeout: 120_000,
      })

      // Scenario 3: scroll the 100k listing; mounted rows stay bounded.
      const visible = await visibleRows(c, "left")
      const scrollLeft = await scrollPanel(c, "left", 2500, 600)
      expect(scrollLeft.maxMountedRows).toBeLessThanOrEqual(visible + 2 * 12 + 2)
      await goTo(c, "right", fx.root)
      const scrollRight = await scrollPanel(c, "right", 2500, 600)
      expect(scrollRight.maxMountedRows).toBeLessThanOrEqual(visible + 2 * 12 + 2)

      // Sort change on 100k → first page.
      const sortMs = await c.evaluate(async () => {
        const grid = document.querySelector<HTMLElement>(`[data-testid="grid-left"]`)!
        const button = [...grid.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
          b.textContent?.startsWith("Size"),
        )!
        const first = () => grid.querySelector("[data-id]")?.getAttribute("data-id")
        const before = first()
        const t0 = performance.now()
        button.click()
        while (first() === before || !grid.querySelector("[aria-sort=ascending]")) {
          await new Promise(requestAnimationFrame)
          if (performance.now() - t0 > 30_000) throw new Error("sort never painted")
        }
        return Math.round(performance.now() - t0)
      })

      const cachedSorted = [...cached1k].sort((a, b) => a - b)
      const result = {
        test: "listing-100k",
        uncached1kMs: Math.round(uncached1kMs),
        cached1kP95Ms: Math.round(cachedSorted.at(-1)!),
        cached1kMedianMs: Math.round(cachedSorted[2]!),
        ...Object.fromEntries(
          Object.entries(responsiveness).map(([k, v]) => [`enter100k_${k}`, v]),
        ),
        scrollLeft,
        scrollRight,
        visibleRows: visible,
        sort100kMs: sortMs,
      }
      writeResult(result)
      expect(result.cached1kP95Ms).toBeLessThan(150) // budget 50 ms on the reference machine
      expect(responsiveness.firstRowsMs).toBeLessThan(1000) // budget 300 ms
      expect(responsiveness.keyP95Ms).toBeLessThan(100)
    } finally {
      await app.close()
      rmSync(small, { recursive: true, force: true })
      rmSync(other, { recursive: true, force: true })
    }
  })
})

test.describe("switching with the shared context (Stage C01)", () => {
  const selectedTile = (page: Page) => page.locator('[data-testid="tile"][aria-selected="true"]')
  const tile = (page: Page, name: string) =>
    page.locator(`[data-testid="tile"][aria-label="${name}"]`)
  const viewerUp = (page: Page) =>
    page.getByRole("toolbar", { name: "Navigation" }).getByRole("button", { name: /^Up/ })
  const baseName = (path: string) => basename(path)

  test("carries the folder and the entry under the cursor both ways", async () => {
    const root = mixedFolder()
    const { app, page } = await launch("viewer")
    try {
      await page.getByTestId("app-switch").click()
      const c = await commanderOf(app)

      // Commander → viewer: the viewer opens the folder and selects the cursor entry.
      await goTo(c, "left", root)
      await cursorTo(c, "left", "a2")
      const c0 = Date.now()
      await c.getByTestId("app-switch").click()
      await expect(selectedTile(page)).toHaveAttribute("aria-label", "a2.jpg")
      const commanderToViewerMs = Date.now() - c0
      expect(await shellState(app)).toMatchObject({ active: "viewer" })
      await expect(page.getByTestId("folder-name")).toHaveText(baseName(root))

      // Same folder: nothing moves in the commander (its cursor stays on a2).
      await tile(page, "a1.jpg").click()
      await page.getByTestId("app-switch").click()
      await expect.poll(() => shellState(app)).toMatchObject({ active: "commander" })
      await expect(c.getByTestId("grid-left").locator("[data-cursor=true]")).toContainText("a2")

      // A non-media cursor entry selects nothing in the viewer; the folder still carries.
      await goTo(c, "left", join(root, "alpha"))
      await cursorTo(c, "left", "inner")
      await c.getByTestId("app-switch").click()
      await expect.poll(() => shellState(app)).toMatchObject({ active: "viewer" })
      await expect(page.getByTestId("folder-name")).toHaveText("alpha")
      await expect(selectedTile(page)).toHaveCount(0)

      // Viewer → commander after the viewer moved: the active panel follows, with the cursor
      // on the viewer's selected tile; the inactive panel stays.
      await viewerUp(page).click()
      await expect(page.getByTestId("folder-name")).toHaveText(baseName(root))
      await tile(page, "a3.png").click()
      const t0 = Date.now()
      await page.getByTestId("app-switch").click()
      await expect(c.getByTestId("path-left")).toHaveText(root)
      await expect(c.getByTestId("grid-left").locator("[data-cursor=true]")).toContainText("a3")
      writeResult({
        test: "switch-with-folder-change",
        commanderToViewerMs,
        viewerToCommanderMs: Date.now() - t0,
      })
      await expect(c.getByTestId("path-right")).not.toHaveText(root)
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a folder deleted between switches shows not found", async () => {
    const root = mixedFolder()
    const { app, page } = await launch("viewer")
    try {
      await page.getByTestId("app-switch").click()
      const c = await commanderOf(app)
      await goTo(c, "left", root)
      await c.getByTestId("app-switch").click()
      await expect(page.getByTestId("folder-name")).toHaveText(baseName(root))
      // The viewer opens beta; it is deleted before the switch.
      await tile(page, "beta").dblclick()
      await expect(page.getByTestId("folder-name")).toHaveText("beta")
      rmSync(join(root, "beta"), { recursive: true })
      await page.getByTestId("app-switch").click()
      await expect(c.getByTestId("error-left")).toHaveAttribute("data-kind", "notFound")
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a restart opens the last used app in the last folder", async () => {
    const root = mixedFolder()
    const profile = mkdtempSync(join(tmpdir(), "fastview-e2e-profile-"))
    const dirs = {
      FASTVIEW_CONFIG_DIR: join(profile, "config"),
      FASTVIEW_USER_DATA_DIR: join(profile, "user-data"),
    }
    try {
      let { app, page } = await launch("", dirs)
      expect(await shellState(app)).toMatchObject({ active: "viewer" })
      await page.getByTestId("app-switch").click()
      let c = await commanderOf(app)
      await goTo(c, "left", root)
      await c.waitForTimeout(1500) // the context and the panels are written after quiet periods
      await app.close()
      ;({ app, page } = await launch("", dirs))
      await expect
        .poll(() => shellState(app), { timeout: 10_000 })
        .toMatchObject({
          active: "commander",
        })
      c = await commanderOf(app)
      await expect(c.getByTestId("path-left")).toHaveText(root, { timeout: 15_000 })
      await app.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(profile, { recursive: true, force: true })
    }
  })
})

/** The commander bundle (with @tanstack/react-table), recorded per run. */
test("records the commander bundle size", () => {
  const assets = join(repoRoot, "commander", "renderer", "dist", "assets")
  const js = readdirSync(assets).filter((f) => f.endsWith(".js"))
  const bytes = js.reduce((n, f) => n + statSync(join(assets, f)).size, 0)
  writeResult({ test: "bundle", jsFiles: js.length, jsBytes: bytes })
  expect(bytes).toBeGreaterThan(0)
})
