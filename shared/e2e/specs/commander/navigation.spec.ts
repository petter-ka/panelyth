import { appendFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { budgetGate, repoRoot } from "../../launch"
import { commanderOf, folderOf, goTo, launch, mixedFolder, type Side } from "./helpers"

// Stage C03: drives, tabs, hotlist, history and session
// (docs/commander/stages/C03-drives-tabs-hotlist.md; scenario 7 of
// docs/commander/TESTING.md). Measurements: stage-C03-…-e2e-navigation.

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(
    repoRoot,
    "shared",
    "bench",
    "results",
    `stage-C03-${date}-e2e-navigation.jsonl`,
  )
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

const grid = (c: Page, side: Side) => c.getByTestId(`grid-${side}`)
const path = (c: Page, side: Side) => c.getByTestId(`path-${side}`)
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const p95 = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]! * 10) / 10
}

/** The viewer's app view page (the shell's other view, ADR-0031). */
async function viewerOf(app: ElectronApplication): Promise<Page> {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    const page = app.windows().find((w) => w.url().startsWith("app://fastview"))
    if (page) return page
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error("viewer view not found")
}

/** A fresh profile reused across launches (library.db, the Electron profile). */
function profile() {
  const dir = mkdtempSync(join(tmpdir(), "fastview-e2e-profile-"))
  return {
    dir,
    env: {
      FASTVIEW_CONFIG_DIR: join(dir, "config"),
      FASTVIEW_USER_DATA_DIR: join(dir, "user-data"),
    },
  }
}

/** Launch → both panels' listings painted, from the test's clock. */
async function launchAndRestore(env: Record<string, string>) {
  const t0 = Date.now()
  const { app } = await launch("commander", env)
  const c = await commanderOf(app)
  await c.waitForFunction(
    () =>
      ["left", "right"].every(
        (side) =>
          document.querySelector(`[data-testid="grid-${side}"]`)?.querySelector("[data-id]") !==
          null,
      ),
    undefined,
    { polling: "raf", timeout: 15_000 },
  )
  return { app, c, restoreMs: Date.now() - t0 }
}

/**
 * Presses a chord in the panel and returns the time until the panel shows
 * `target` with entry rows painted (in-page clock).
 */
function timeKeyToRows(
  c: Page,
  side: Side,
  init: { key: string; ctrlKey?: boolean; shiftKey?: boolean },
  target: string,
): Promise<number> {
  return c.evaluate(
    ({ side, init, target }) => {
      const grid = document.querySelector<HTMLElement>(`[data-testid="grid-${side}"]`)!
      const t0 = performance.now()
      grid.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true }))
      return new Promise<number>((resolve, reject) => {
        const tick = (): void => {
          const shown = document.querySelector(`[data-testid="path-${side}"]`)?.textContent ?? ""
          const now = document.querySelector(`[data-testid="grid-${side}"]`)
          if (shown.toLowerCase() === target.toLowerCase() && now?.querySelector("[data-id]")) {
            resolve(performance.now() - t0)
          } else if (performance.now() - t0 > 10_000) reject(new Error(`no rows for ${target}`))
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    },
    { side, init, target },
  )
}

test.describe("drives, tabs, hotlist, history and session (Stage C03)", () => {
  test("scenario 7: tabs, drives, hotlist and history survive a restart", async () => {
    test.setTimeout(90_000)
    const root = mixedFolder()
    const alpha = join(root, "alpha")
    const p = profile()
    let app: ElectronApplication | null = null
    try {
      app = (await launch("commander", p.env)).app
      let c = await commanderOf(app)
      await goTo(c, "left", root)
      // A second tab on alpha, in the Brief view; the first tab stays on root.
      await grid(c, "left").focus()
      await c.keyboard.press("Control+t")
      await expect(c.getByTestId("tabs-left").getByRole("tab")).toHaveCount(2)
      await goTo(c, "left", alpha)
      await grid(c, "left").focus()
      await c.keyboard.press("Control+F1")
      await expect(grid(c, "left")).toHaveAttribute("role", "listbox")
      // Hotlist: add alpha.
      await c.keyboard.press("Control+d")
      await c.getByTestId("hotlist-left").getByText("Add the current folder").click()
      // The right panel: a drive from the drive menu (the drive holding root).
      await grid(c, "right").focus()
      await c.keyboard.press("Alt+F2")
      const menu = c.getByTestId("drive-menu-right")
      await expect(menu).toBeVisible()
      const drive = root.slice(0, 3) // "C:\" on Windows
      if (process.platform === "win32") {
        await c.keyboard.press(drive[0]!.toLowerCase())
        await expect(path(c, "right")).toHaveText(drive)
      } else {
        await c.keyboard.press("Escape")
        await goTo(c, "right", "/")
      }
      await c.waitForTimeout(800) // commander.panels is written after a quiet period
      await app.close()
      app = null

      const restored = await launchAndRestore(p.env)
      app = restored.app
      c = restored.c
      writeResult({ test: "session-restore", restoreMs: restored.restoreMs, budgetMs: 1300 })
      await expect(path(c, "left")).toHaveText(alpha)
      await expect(grid(c, "left")).toHaveAttribute("role", "listbox")
      const tabs = c.getByTestId("tabs-left").getByRole("tab")
      await expect(tabs).toHaveCount(2)
      await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true")
      await expect(path(c, "right")).toHaveText(process.platform === "win32" ? drive : "/")
      // History (Alt+↓): alpha then root, newest first.
      await grid(c, "left").focus()
      await c.keyboard.press("Alt+ArrowDown")
      const history = c.getByTestId("history-left").getByRole("menuitem")
      await expect(history.nth(0)).toContainText(alpha)
      await expect(history.nth(1)).toContainText(root)
      await c.keyboard.press("Escape")
      await expect(grid(c, "left")).toBeFocused()
      // The hotlist still has alpha; the first tab still shows root.
      await c.keyboard.press("Control+d")
      await expect(c.getByTestId("hotlist-left")).toContainText(alpha)
      await c.keyboard.press("Escape")
      await c.keyboard.press("Control+Tab")
      await expect(path(c, "left")).toHaveText(root)
      await expect(grid(c, "left")).toHaveAttribute("role", "grid")
    } finally {
      await app?.close()
      rmSync(root, { recursive: true, force: true })
      // The sidecar may still hold library.db for a moment after the app closed.
      rmSync(p.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    }
  })

  test("switch: bookmarks and recent locations are one list in both apps", async () => {
    test.setTimeout(90_000)
    const root = mixedFolder()
    const alpha = join(root, "alpha")
    const p = profile()
    try {
      const { app } = await launch("commander", p.env)
      try {
        // The commander bookmarks alpha and visits root.
        const c = await commanderOf(app)
        await goTo(c, "left", alpha)
        await grid(c, "left").focus()
        await c.keyboard.press("Control+d")
        await c.getByTestId("hotlist-left").getByText("Add the current folder").click()
        await goTo(c, "left", root)
        await grid(c, "left").focus()
        await c.keyboard.press("Control+Shift+m")

        // The viewer shows the bookmark and the commander's recent folder.
        const page = await viewerOf(app)
        const sidebar = page.getByTestId("sidebar-list")
        // The tree reveals the open folder and the list is virtualized: on
        // Linux, "/" lists ~20 folders above /tmp, so the bookmark rows at the
        // top may be scrolled out and unmounted (Stage P04).
        await expect(sidebar.getByRole("treeitem").first()).toBeVisible()
        await sidebar.evaluate((el) => el.scrollTo({ top: 0 }))
        await expect(sidebar.getByRole("treeitem", { name: "alpha" }).first()).toBeVisible()
        await expect(sidebar.getByRole("treeitem", { name: basename(root) }).first()).toBeVisible()

        // The viewer bookmarks root (from its recent entry); the hotlist shows it.
        await sidebar
          .getByRole("treeitem", { name: basename(root) })
          .first()
          .click({ button: "right" })
        await page.getByRole("menuitem", { name: "Add bookmark" }).click()
        await page.getByTestId("app-switch").click()
        await grid(c, "left").focus()
        await c.keyboard.press("Control+d")
        const hotlist = c.getByTestId("hotlist-left")
        await expect(hotlist).toContainText(alpha)
        await expect(hotlist).toContainText(basename(root))
        await c.keyboard.press("Escape")
        // The viewer's folders are in the commander's recent list too.
        await c.keyboard.press("Alt+ArrowDown")
        await expect(c.getByTestId("history-left")).toContainText("Recent (both apps)")
      } finally {
        await app.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
      // The sidecar may still hold library.db for a moment after the app closed.
      rmSync(p.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    }
  })

  test("benchmark: tab switch, parked and reopened", async () => {
    const a = folderOf(1000)
    const b = folderOf(1000)
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", a)
      await grid(c, "left").focus()
      await c.keyboard.press("Control+t")
      await goTo(c, "left", b)
      // Warm: the other tab's session is still parked (within the grace period).
      const warm: number[] = []
      for (let i = 0; i < 20; i++) {
        warm.push(await timeKeyToRows(c, "left", { key: "Tab", ctrlKey: true }, i % 2 ? b : a))
      }
      // Cold: the parked session closed; the tab opens its folder again.
      const cold: number[] = []
      for (let i = 0; i < 6; i++) {
        await c.waitForTimeout(3300)
        cold.push(await timeKeyToRows(c, "left", { key: "Tab", ctrlKey: true }, i % 2 ? b : a))
      }
      writeResult({
        test: "tab-switch-1k",
        warmP95Ms: p95(warm),
        warmMedianMs: Math.round(median(warm) * 10) / 10,
        coldMedianMs: Math.round(median(cold) * 10) / 10,
        coldP95Ms: p95(cold),
        budgetP95Ms: 50,
      })
      expect(p95(warm)).toBeLessThan(budgetGate(50))
      expect(p95(cold)).toBeLessThan(budgetGate(50))
    } finally {
      await app.close()
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  test("benchmark: the drive menu with a dead network drive never blocks", async () => {
    const root = mixedFolder()
    const slow = process.platform === "win32" ? "Q:\\" : "/mnt/fastview-dead-share"
    const { app } = await launch("commander", {
      FASTVIEW_DEV_METHODS: "1",
      FASTVIEW_DEV_SLOW_VOLUME: `${slow}=8000`,
    })
    try {
      const c = await commanderOf(app)
      await goTo(c, "right", root)
      await grid(c, "left").focus()
      const opened = await c.evaluate(() => {
        const g = document.querySelector<HTMLElement>('[data-testid="grid-left"]')!
        const t0 = performance.now()
        g.dispatchEvent(new KeyboardEvent("keydown", { key: "F1", altKey: true, bubbles: true }))
        return new Promise<number>((resolve) => {
          const tick = (): void => {
            if (document.querySelector('[data-testid="drive-menu-left"]'))
              resolve(performance.now() - t0)
            else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
      })
      // Meanwhile the other panel moves at once.
      const cursorMs = await c.evaluate(() => {
        const g = document.querySelector<HTMLElement>('[data-testid="grid-right"]')!
        const before = g.getAttribute("aria-activedescendant")
        const t0 = performance.now()
        g.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
        return new Promise<number>((resolve) => {
          const tick = (): void => {
            if (g.getAttribute("aria-activedescendant") !== before) resolve(performance.now() - t0)
            else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
      })
      // The dead share answers "not ready" after its timeout, not after 8 s.
      const t0 = Date.now()
      const menu = c.getByTestId("drive-menu-left")
      await expect(menu).toContainText("slow share", { timeout: 4000 })
      await expect(menu).toContainText("not ready")
      const listedMs = Date.now() - t0
      writeResult({
        test: "drive-menu-dead-share",
        menuOpenMs: Math.round(opened),
        otherPanelCursorMs: Math.round(cursorMs),
        deadShareListedAfterMs: listedMs,
        shareDelayMs: 8000,
      })
      expect(opened).toBeLessThan(100)
      expect(cursorMs).toBeLessThan(50)
      await c.keyboard.press("Escape")
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
