import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { removeTemp } from "../../launch"
import { commanderOf, goTo, launch } from "./helpers"

// The row under the cursor stays on screen, in every view: while the keys move
// it, and when a folder that was scrolled comes back. jsdom has no layout, so
// this is measured in the real window: the row's rectangle against the area the
// list can show (below the Full view's sticky header, above a horizontal
// scrollbar). The Full view's virtualizer once took neither for part of its
// geometry, so the cursor walked off the bottom edge.

const FOLDERS = 300

/** A folder of folders, so the cursor can leave and come back from anywhere in it. */
function folderOfFolders(): string {
  const root = mkdtempSync(join(tmpdir(), "panelyth-cursor-"))
  for (let i = 0; i < FOLDERS; i++) {
    const dir = join(root, `d${String(i).padStart(4, "0")}`)
    mkdirSync(dir)
    writeFileSync(join(dir, "inner.txt"), "x")
  }
  return root
}

interface Gaps {
  /** Pixels between the visible area's edge and the row; negative: cut off by that many. */
  top: number
  bottom: number
  left: number
  right: number
  name: string
}

/** Where the cursor row is against the area the list shows; null when it is not mounted at all. */
const cursorGaps = (c: Page): Promise<Gaps | null> =>
  c.evaluate(async () => {
    // A frame for the view's effect and the virtualizer's scroll, one for the scroll event.
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame)
    const grid = document.querySelector<HTMLElement>('[data-testid="grid-left"]')!
    const row = grid.querySelector<HTMLElement>('[data-cursor="true"]')
    if (!row) return null
    const full = grid.getAttribute("role") === "grid"
    const scroller = full ? (grid.children[0] as HTMLElement) : grid
    const box = scroller.getBoundingClientRect()
    const r = row.getBoundingClientRect()
    const header = full
      ? (scroller.querySelector<HTMLElement>('[role="columnheader"]')?.offsetHeight ?? 0)
      : 0
    return {
      top: r.top - (box.top + scroller.clientTop + header),
      bottom: box.top + scroller.clientTop + scroller.clientHeight - r.bottom,
      left: r.left - (box.left + scroller.clientLeft),
      right: box.left + scroller.clientLeft + scroller.clientWidth - r.right,
      // A Full view row's text runs on into its other columns.
      name: /d\d{4}/.exec(row.textContent ?? "")?.[0] ?? "",
    }
  })

/** The row is fully on screen vertically and, where the list scrolls sideways, sideways too. */
async function expectOnScreen(c: Page, what: string, sideways = false): Promise<void> {
  const gaps = await cursorGaps(c)
  expect(gaps, `${what}: the cursor row is not mounted`).not.toBeNull()
  // Half a pixel: the rectangles are fractional at some scale factors.
  expect(gaps!.top, `${what}: cut off at the top`).toBeGreaterThanOrEqual(-0.5)
  expect(gaps!.bottom, `${what}: cut off at the bottom`).toBeGreaterThanOrEqual(-0.5)
  if (sideways) {
    expect(gaps!.left, `${what}: cut off at the left`).toBeGreaterThanOrEqual(-0.5)
    expect(gaps!.right, `${what}: cut off at the right`).toBeGreaterThanOrEqual(-0.5)
  }
}

async function open(size?: { width: number; height: number }) {
  const root = folderOfFolders()
  const launched = await launch("commander")
  const c = await commanderOf(launched.app)
  if (size) await resize(launched.app, size)
  await goTo(c, "left", root)
  await c.getByTestId("grid-left").focus()
  return { ...launched, c, root }
}

const resize = (app: ElectronApplication, size: { width: number; height: number }) =>
  app.evaluate(({ BrowserWindow }, { width, height }) => {
    const win = BrowserWindow.getAllWindows()[0]!
    win.setContentSize(width, height)
  }, size)

const VIEWS = [
  { name: "Full", key: "Control+F2", view: null, sideways: false },
  { name: "Brief", key: "Control+F1", view: "brief", sideways: true },
  { name: "Thumbnails", key: "Control+Shift+F1", view: "thumbs", sideways: false },
] as const

for (const { name, key, view, sideways } of VIEWS) {
  test.describe(`the cursor stays on screen in the ${name} view`, () => {
    test("while the keys move it", async () => {
      const { app, c, root } = await open()
      try {
        await c.keyboard.press(key)
        if (view) await expect(c.getByTestId("grid-left")).toHaveAttribute("data-view", view)
        for (let i = 0; i < 70; i++) {
          await c.keyboard.press("ArrowDown")
          await expectOnScreen(c, `${i + 1} x Down`, sideways)
        }
        for (let i = 0; i < 70; i++) {
          await c.keyboard.press("ArrowUp")
          await expectOnScreen(c, `${i + 1} x Up`, sideways)
        }
        await c.keyboard.press("PageDown")
        await expectOnScreen(c, "Page Down", sideways)
        await c.keyboard.press("End")
        await expectOnScreen(c, "End", sideways)
        await c.keyboard.press("PageUp")
        await expectOnScreen(c, "Page Up", sideways)
        await c.keyboard.press("Home")
        await expectOnScreen(c, "Home", sideways)
      } finally {
        await app.close().catch(() => undefined)
        removeTemp(root)
      }
    })

    test("when a scrolled folder comes back", async () => {
      const { app, c, root } = await open()
      try {
        await c.keyboard.press(key)
        if (view) await expect(c.getByTestId("grid-left")).toHaveAttribute("data-view", view)
        // Every distance from the top: the row may be anywhere between the list's edges.
        for (const moves of [40, 7, 13, 21]) {
          for (let i = 0; i < moves; i++) await c.keyboard.press("ArrowDown")
          await expectOnScreen(c, `${moves} x Down`, sideways)
          const before = (await cursorGaps(c))!.name
          await c.keyboard.press("Enter")
          await expect(c.getByTestId("path-left")).toContainText(before)
          await c.keyboard.press("Backspace")
          await expect(c.getByTestId("grid-left").locator('[data-cursor="true"]')).toContainText(
            before,
          )
          await expectOnScreen(c, `back after ${moves} x Down`, sideways)
        }
      } finally {
        await app.close().catch(() => undefined)
        removeTemp(root)
      }
    })

    test("when a folder comes back after the mouse scrolled the cursor away", async () => {
      const { app, c, root } = await open()
      try {
        await c.keyboard.press(key)
        if (view) await expect(c.getByTestId("grid-left")).toHaveAttribute("data-view", view)
        for (let i = 0; i < 10; i++) await c.keyboard.press("ArrowDown")
        const before = (await cursorGaps(c))!.name
        await c.getByTestId("grid-left").evaluate((grid) => {
          const scroller =
            grid.getAttribute("role") === "grid" ? (grid.children[0] as HTMLElement) : grid
          scroller.scrollTop = scroller.scrollHeight
          scroller.scrollLeft = scroller.scrollWidth
        })
        await c.keyboard.press("Enter")
        await expect(c.getByTestId("path-left")).toContainText(before)
        await c.keyboard.press("Backspace")
        await expect(c.getByTestId("grid-left").locator('[data-cursor="true"]')).toContainText(
          before,
        )
        await expectOnScreen(c, "back", sideways)
      } finally {
        await app.close().catch(() => undefined)
        removeTemp(root)
      }
    })
  })
}

test.describe("the cursor stays on screen above a horizontal scrollbar", () => {
  test("in a Full view too narrow for its columns", async () => {
    const { app, c, root } = await open({ width: 700, height: 560 })
    try {
      // The precondition: the list scrolls sideways, so its scrollbar takes height.
      const scrollbar = await c.getByTestId("grid-left").evaluate((grid) => {
        const scroller = grid.children[0] as HTMLElement
        return scroller.offsetHeight - scroller.clientHeight
      })
      expect(scrollbar).toBeGreaterThan(0)
      for (let i = 0; i < 40; i++) {
        await c.keyboard.press("ArrowDown")
        await expectOnScreen(c, `${i + 1} x Down`)
      }
      await c.keyboard.press("Enter")
      await c.keyboard.press("Backspace")
      await expect(c.getByTestId("grid-left").locator('[data-cursor="true"]')).toContainText(
        "d0039",
      )
      await expectOnScreen(c, "back")
    } finally {
      await app.close().catch(() => undefined)
      removeTemp(root)
    }
  })

  test("in a Brief view: a column holds only the rows that fit above the scrollbar", async () => {
    const { app, c, root } = await open()
    try {
      await c.keyboard.press("Control+F1")
      await expect(c.getByTestId("grid-left")).toHaveAttribute("data-view", "brief")
      const scrollbar = await c
        .getByTestId("grid-left")
        .evaluate((el) => (el as HTMLElement).offsetHeight - (el as HTMLElement).clientHeight)
      expect(scrollbar).toBeGreaterThan(0)
      // The bottom row of every column on the way.
      for (let i = 0; i < 70; i++) {
        await c.keyboard.press("ArrowDown")
        await expectOnScreen(c, `${i + 1} x Down`, true)
      }
    } finally {
      await app.close().catch(() => undefined)
      removeTemp(root)
    }
  })
})
