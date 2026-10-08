import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type ElectronApplication, type Page } from "@playwright/test"
import { commanderPage, launchApp, waitForReady } from "../../launch"

// Helpers of the commander e2e specs (Stages C01, C02).

export type Side = "left" | "right"

/** A small mixed folder: two subfolders, images, a text file and a hidden file. */
export function mixedFolder(): string {
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

export function folderOf(files: number): string {
  const root = mkdtempSync(join(tmpdir(), `fastview-c01-${files}-`))
  for (let i = 0; i < files; i++)
    writeFileSync(join(root, `f${String(i).padStart(5, "0")}.txt`), "")
  return root
}

/** Launches with the commander enabled; reuses profile dirs when given. */
export async function launch(
  start: "viewer" | "commander" | "",
  dirs: Record<string, string> = {},
) {
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
export async function goTo(c: Page, side: Side, path: string): Promise<number> {
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
export async function cursorTo(c: Page, side: Side, name: string): Promise<void> {
  const grid = c.getByTestId(`grid-${side}`)
  await grid.locator("[data-id]", { hasText: name }).first().click()
  await expect(grid.locator("[data-cursor=true]")).toContainText(name)
}

export interface ScrollResult {
  frames: number
  p95FrameMs: number
  maxFrameGapMs: number
  longTasks: number
  longTaskMaxMs: number
  maxMountedRows: number
}

/** Scrolls a panel's body for `ms`, counting frames, long tasks and mounted rows. */
export function scrollPanel(
  c: Page,
  side: Side,
  ms: number,
  pxPerFrame: number,
): Promise<ScrollResult> {
  return c.evaluate(
    async ({ side, ms, pxPerFrame }) => {
      const grid = document.querySelector<HTMLElement>(`[data-testid="grid-${side}"]`)!
      const body = grid.children[0] as HTMLElement
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

export const visibleRows = (c: Page, side: Side) =>
  c.evaluate((side) => {
    const grid = document.querySelector<HTMLElement>(`[data-testid="grid-${side}"]`)!
    const body = grid.children[0] as HTMLElement
    const row = grid.querySelector<HTMLElement>("[data-row]")
    return Math.ceil(body.clientHeight / (row?.offsetHeight || 22))
  }, side)

export async function commanderOf(app: ElectronApplication): Promise<Page> {
  const c = await commanderPage(app)
  // The first start on a CI runner can be slow (a fresh binary, cold caches).
  await expect(c.getByTestId("sidecar-status")).toHaveAttribute("data-state", "ready", {
    timeout: process.env.CI ? 45_000 : 15_000,
  })
  return c
}

/** Opens a folder that may be empty (goTo waits for entry rows). */
export async function openFolder(c: Page, side: Side, path: string): Promise<void> {
  await c.getByTestId(`path-${side}`).click()
  await c.getByRole("textbox", { name: "Path" }).fill(path)
  await c.keyboard.press("Enter")
  await expect(c.getByTestId(`path-${side}`)).toHaveText(path)
}
