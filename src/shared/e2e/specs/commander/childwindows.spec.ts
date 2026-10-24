import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { hitTest } from "../../hitTest"
import { openSettingsWindow } from "../../launch"
import { commanderOf, cursorTo, goTo, launch } from "./helpers"

// The title strip of the child windows (ADR-0045, owner request 2026-10-24):
// the settings and the document windows draw the main window's strip, with the
// mark at its left and only the buttons the window has. Windows only.

test.skip(process.platform !== "win32", "the strip is drawn on Windows only")

const windowOf = (app: ElectronApplication, page: Page) =>
  app.evaluate(({ BrowserWindow }, url) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL() === url)!
    return { maximized: w.isMaximized(), destroyed: w.isDestroyed() }
  }, page.url())

/** A real mouse: every button of the strip clicks; the name and the mark drag the window. */
async function expectRealMouse(app: ElectronApplication, page: Page): Promise<void> {
  const buttons = await hitTest(app, page, "[data-testid=title-bar] button")
  expect(buttons.length).toBeGreaterThan(0)
  expect(buttons).toEqual(buttons.map(() => "click"))
  expect(await hitTest(app, page, "[data-testid=title-bar] > span")).toContain("drag")
}

test.describe("child windows' title strips (ADR-0045)", () => {
  test("the settings window: the strip with Close only, and Close closes it", async () => {
    const { app, page } = await launch("viewer")
    try {
      const settings = await openSettingsWindow(app, page)
      const strip = settings.getByTestId("title-bar")
      await expect(strip).toContainText("Settings")
      await expect(strip.getByTestId("title-bar-mark")).toBeVisible()
      await expect(strip.getByRole("button", { name: "Close" })).toBeVisible()
      // Modal: no minimize or maximize.
      await expect(strip.getByRole("button", { name: "Minimize" })).toHaveCount(0)
      await expect(strip.getByRole("button", { name: "Maximize" })).toHaveCount(0)
      expect(await strip.evaluate((el) => el.getBoundingClientRect().top)).toBe(0)
      await expectRealMouse(app, settings)
      await Promise.all([
        settings.waitForEvent("close"),
        strip
          .getByRole("button", { name: "Close" })
          .click()
          .catch(() => undefined),
      ])
    } finally {
      await app.close()
    }
  })

  test("the document window: minimize, maximize and close of its own window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panelyth-childwin-"))
    writeFileSync(join(dir, "notes.txt"), "Hello\n")
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", dir)
      await cursorTo(c, "left", "notes")
      const opened = app.waitForEvent("window", (p) => p.url().startsWith("app://documents/"))
      await c.keyboard.press("F3")
      const doc = await opened
      const strip = doc.getByTestId("title-bar")
      await expect(strip).toContainText("notes.txt")
      await expect(strip.getByTestId("title-bar-mark")).toBeVisible()
      await expectRealMouse(app, doc)
      await strip.getByRole("button", { name: "Maximize", exact: true }).click()
      await expect.poll(async () => (await windowOf(app, doc)).maximized).toBe(true)
      await strip.getByRole("button", { name: "Restore" }).click()
      await expect.poll(async () => (await windowOf(app, doc)).maximized).toBe(false)
      // The main window is untouched by the document window's buttons.
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some(
            (w) => w.webContents.getURL().includes("index.html") && w.isMaximized(),
          ),
        ),
      ).toBe(false)
      await Promise.all([
        doc.waitForEvent("close"),
        strip
          .getByRole("button", { name: "Close" })
          .click()
          .catch(() => undefined),
      ])
    } finally {
      await app.close()
    }
  })

  test("the text editor window: its strip and its own buttons", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panelyth-childwin-"))
    writeFileSync(join(dir, "todo.txt"), "one\n")
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", dir)
      await cursorTo(c, "left", "todo")
      const opened = app.waitForEvent("window", (p) => p.url().startsWith("app://texteditor/"))
      await c.keyboard.press("F4")
      const ed = await opened
      const strip = ed.getByTestId("title-bar")
      await expect(strip).toContainText("todo.txt")
      await expect(strip.getByTestId("title-bar-mark")).toBeVisible()
      await expectRealMouse(app, ed)
      await strip.getByRole("button", { name: "Maximize", exact: true }).click()
      await expect.poll(async () => (await windowOf(app, ed)).maximized).toBe(true)
      await strip.getByRole("button", { name: "Restore" }).click()
      await expect.poll(async () => (await windowOf(app, ed)).maximized).toBe(false)
      await Promise.all([
        ed.waitForEvent("close"),
        strip
          .getByRole("button", { name: "Close" })
          .click()
          .catch(() => undefined),
      ])
    } finally {
      await app.close()
    }
  })
})
