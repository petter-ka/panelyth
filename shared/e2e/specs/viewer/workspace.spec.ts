import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { launchApp, repoRoot, waitForReady } from "../../launch"

// Stage 05: navigation, lazy tree, index-backed search, pane resize,
// workspace persistence, multi-selection (docs/viewer/stages/05-filesystem-ux.md).

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(repoRoot, "shared", "bench", "results", `stage-05-${date}-e2e-workspace.jsonl`)
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

const nav = (page: Page) => page.getByRole("toolbar", { name: "Navigation" })

async function openVia(dialogPath: string, env: Record<string, string> = {}) {
  const launched = await launchApp({ FASTVIEW_TEST_DIALOG_PATH: dialogPath, ...env })
  await waitForReady(launched.page)
  await nav(launched.page).getByRole("button", { name: "Open folder…" }).click()
  return launched
}

const folderPath = (page: Page) =>
  page.getByTestId("breadcrumb").locator('[aria-current="page"]').getAttribute("title")

const shellLog = (app: ElectronApplication) =>
  app.evaluate(
    () =>
      (globalThis as { __fastviewShellLog?: { action: string; value: string }[] })
        .__fastviewShellLog ?? [],
  )

/** Collects long tasks in the renderer until `stop` resolves. */
async function watchLongTasks(page: Page): Promise<() => Promise<number[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { __long: number[]; __po: PerformanceObserver }
    w.__long = []
    w.__po = new PerformanceObserver((l) =>
      l.getEntries().forEach((e) => w.__long.push(e.duration)),
    )
    w.__po.observe({ type: "longtask" })
  })
  return () =>
    page.evaluate(() => {
      const w = window as unknown as { __long: number[]; __po: PerformanceObserver }
      w.__po.disconnect()
      return w.__long.map(Math.round)
    })
}

test.describe("navigation", () => {
  test("tiles, breadcrumb, back/forward/up by mouse and keyboard", async () => {
    const fx = ensureFixture("tree-small", { files: 20, depth: 2, fanout: 3, nonMediaEvery: 10 })
    const { app, page } = await openVia(fx.root)
    try {
      await expect(page.getByTestId("tile").first()).toBeVisible()
      expect(await folderPath(page)).toBe(fx.root)
      // Into a folder tile, then back out with the breadcrumb.
      await page.getByRole("gridcell", { name: "folder 1" }).dblclick()
      await expect.poll(() => folderPath(page)).toBe(join(fx.root, "folder 1"))
      await page
        .getByTestId("breadcrumb")
        .getByRole("button", { name: basename(fx.root), exact: true })
        .click()
      await expect.poll(() => folderPath(page)).toBe(fx.root)
      // Alt+Left / Alt+Right walk the history; Backspace goes up.
      await page.keyboard.press("Alt+ArrowLeft")
      await expect.poll(() => folderPath(page)).toBe(join(fx.root, "folder 1"))
      await page.keyboard.press("Alt+ArrowRight")
      await expect.poll(() => folderPath(page)).toBe(fx.root)
      await page.getByTestId("tile-view").focus()
      await page.keyboard.press("Backspace")
      await expect.poll(() => folderPath(page)).toBe(dirname(fx.root))
    } finally {
      await app.close()
    }
  })
})

test.describe("sidebar tree", () => {
  test("a folder with 10,000 subfolders expands lazily without freezing", async () => {
    test.setTimeout(180_000)
    const base = join(tmpdir(), "fastview-fixtures", "subdirs-10k")
    const many = join(base, "many")
    if (!existsSync(join(base, ".done"))) {
      for (let i = 0; i < 10_000; i++)
        mkdirSync(join(many, `dir ${i}`, i % 10 === 0 ? "child" : ""), { recursive: true })
      writeFileSync(join(base, ".done"), "")
    }
    const { app, page } = await openVia(base)
    try {
      const tree = page.getByTestId("sidebar-list")
      // The open folder is revealed (ancestors expanded, itself not: the tree stays lazy).
      const opened = tree.locator('[data-testid="tree-node"][aria-label="subdirs-10k"]')
      await expect(opened).toHaveAttribute("aria-selected", "true", { timeout: 15_000 })
      await opened.getByRole("button", { name: "Expand subdirs-10k" }).click()
      const node = tree.locator('[data-testid="tree-node"][aria-label="many"]')
      await expect(node).toBeVisible()
      const stop = await watchLongTasks(page)
      const started = Date.now()
      await node.getByRole("button", { name: "Expand many" }).click()
      await expect(tree.locator('[data-testid="tree-node"][aria-label="dir 0"]')).toBeVisible({
        timeout: 15_000,
      })
      const expandMs = Date.now() - started
      // Scroll through the whole expanded list.
      await tree.evaluate(async (el) => {
        for (let i = 0; i < 40; i++) {
          el.scrollTop += 6000
          await new Promise(requestAnimationFrame)
        }
      })
      const long = await stop()
      const mounted = await tree.locator('[data-testid="tree-node"]').count()
      writeResult({
        test: "tree-expand-10k",
        expandMs,
        longTasks: long.length,
        longTaskMaxMs: Math.max(0, ...long),
        mountedRows: mounted,
      })
      expect(mounted).toBeLessThan(200) // virtualized, never 10k rows
      expect(Math.max(0, ...long)).toBeLessThan(200)
    } finally {
      await app.close()
    }
  })
})

test.describe("search and sort", () => {
  test("search in a 100,000-file folder is index-backed and fast", async () => {
    test.setTimeout(240_000)
    const fx = ensureFixture("flat-100k", { files: 100_000, nonMediaEvery: 10 })
    const { app, page } = await openVia(fx.root)
    try {
      await expect(page.getByTestId("folder-summary")).toHaveText(/^[\d,.\s]+items/, {
        timeout: 120_000,
      })
      const input = page.getByRole("searchbox", { name: "Search file names" })
      const samples: number[] = []
      for (const term of ["4242", "IMG_9", "nothing-matches", "12"]) {
        await input.fill("")
        await expect(page.getByTestId("folder-summary")).toHaveText(/^[\d,.\s]+items/)
        const started = await page.evaluate(() => performance.now())
        await input.fill(term)
        await page.waitForFunction(
          (t) =>
            document
              .querySelector('[data-testid="folder-summary"]')
              ?.textContent?.includes(`“${t}”`),
          term,
        )
        // First page of results painted.
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="folder-summary"]')
              ?.textContent?.startsWith("0 results") ||
            document.querySelector('[data-testid="tile"]:not([data-kind="loading"])') !== null,
        )
        samples.push(Math.round((await page.evaluate(() => performance.now())) - started))
      }
      const sorted = [...samples].sort((a, b) => a - b)
      writeResult({
        test: "search-100k",
        samplesMs: samples,
        p50Ms: sorted[Math.floor(sorted.length / 2)],
        debounceMs: 200,
      })
      // Includes the 200 ms input debounce.
      expect(Math.max(...samples)).toBeLessThan(700)

      // Sort by size, largest first (multi-key via the menu).
      await page.getByRole("button", { name: "Sort" }).click()
      await page
        .getByRole("group", { name: "Sort by" })
        .getByRole("menuitemradio", { name: "Size" })
        .click()
      await page.getByRole("button", { name: "Sort" }).click()
      await page.getByRole("menuitemradio", { name: "Largest first" }).click()
      await expect(page.getByRole("button", { name: "Sort" })).toContainText("Size")
    } finally {
      await app.close()
    }
  })
})

test.describe("workspace", () => {
  test("pane resize is smooth and the workspace survives a restart", async () => {
    test.setTimeout(120_000)
    const fx = ensureFixture("flat-10k", { files: 10_000, nonMediaEvery: 10 })
    const config = mkdtempSync(join(tmpdir(), "fastview-e2e-config-"))
    const first = await openVia(fx.root, {
      FASTVIEW_CONFIG_DIR: config,
      FASTVIEW_USER_DATA_DIR: mkdtempSync(join(tmpdir(), "fastview-e2e-ud-")),
    })
    let sidebarWidth!: number
    try {
      const { page } = first
      await first.app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]!
        win.unmaximize()
        win.setContentSize(1440, 900)
      })
      await expect(page.getByTestId("tile").first()).toBeVisible()
      const perRowBefore = Number(await page.getByTestId("tile-view").getAttribute("data-per-row"))
      const sep = page.locator("#sidebar-separator")
      const box = (await sep.boundingBox())!
      const stop = await watchLongTasks(page)
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      for (let i = 1; i <= 30; i++) await page.mouse.move(box.x + i * 8, box.y + box.height / 2)
      await page.mouse.up()
      const long = await stop()
      const perRowAfter = Number(await page.getByTestId("tile-view").getAttribute("data-per-row"))
      sidebarWidth = Math.round(
        (await page.getByRole("navigation", { name: "Locations" }).boundingBox())!.width,
      )
      writeResult({
        test: "pane-resize",
        steps: 30,
        longTasks: long.length,
        longTaskMaxMs: Math.max(0, ...long),
        perRowBefore,
        perRowAfter,
      })
      expect(long.filter((d) => d > 100)).toHaveLength(0)
      expect(perRowAfter).toBeLessThan(perRowBefore)

      await page.getByRole("button", { name: "Large tiles" }).click()
      await page.getByRole("button", { name: "Sort" }).click()
      await page
        .getByRole("group", { name: "Sort by" })
        .getByRole("menuitemradio", { name: "Date modified" })
        .click()
      await page.waitForTimeout(800) // debounced save
    } finally {
      await first.app.close()
    }

    // New Electron profile (empty localStorage): only library.db remembers.
    const second = await launchApp({
      FASTVIEW_CONFIG_DIR: config,
      FASTVIEW_USER_DATA_DIR: mkdtempSync(join(tmpdir(), "fastview-e2e-ud-")),
    })
    try {
      const { page } = second
      await waitForReady(page)
      await expect(page.getByRole("button", { name: "Large tiles" })).toHaveAttribute(
        "aria-pressed",
        "true",
      )
      await expect(page.getByRole("button", { name: "Sort" })).toContainText("Date modified")
      await expect
        .poll(async () =>
          Math.round(
            (await page.getByRole("navigation", { name: "Locations" }).boundingBox())!.width,
          ),
        )
        .toBeGreaterThan(sidebarWidth - 8)
      // Recent folders came back too.
      await expect(
        page.getByTestId("sidebar-list").getByRole("treeitem", { name: "flat-10k" }).first(),
      ).toBeVisible()
    } finally {
      await second.app.close()
    }
  })

  test("multi-selection: count, size, copy paths and properties", async () => {
    const fx = ensureFixture("flat-5k", { files: 5_000, nonMediaEvery: 10 })
    const { app, page } = await openVia(fx.root)
    try {
      await expect(page.getByTestId("tile").first()).toBeVisible()
      const tiles = page.getByTestId("tile")
      await tiles.nth(0).click()
      await tiles.nth(4).click({ modifiers: ["Shift"] })
      await tiles.nth(6).click({ modifiers: ["ControlOrMeta"] })
      await expect(page.getByTestId("selection-summary")).toHaveText(/^6 selected, /)

      await page.getByTestId("tile-view").press("ControlOrMeta+a")
      await expect(page.getByTestId("selection-summary")).toContainText(/^[\d,.\s]+selected/)
      await tiles.nth(2).click({ button: "right" })
      await page.getByRole("menuitem", { name: "Copy paths" }).click()
      await expect
        .poll(async () => (await shellLog(app)).filter((e) => e.action === "clipboard").length)
        .toBe(1)
      const copied = (await shellLog(app))
        .find((e) => e.action === "clipboard")!
        .value.split(/\r?\n/)
      expect(copied.length).toBeGreaterThan(4000)
      expect(copied[0]!.startsWith(fx.root)).toBe(true)

      await tiles.nth(3).click()
      await page.keyboard.press("Alt+Enter")
      const dialog = page.getByRole("dialog")
      await expect(dialog.getByTestId("props-path")).toHaveText(
        new RegExp(`^${fx.root.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`),
      )
      await page.keyboard.press("Escape")

      await tiles.nth(3).click({ button: "right" })
      await page.getByRole("menuitem", { name: "Show in file manager" }).click()
      await expect
        .poll(async () => (await shellLog(app)).some((e) => e.action === "reveal"))
        .toBe(true)
    } finally {
      await app.close()
    }
  })
})
