import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { repoRoot } from "../../launch"
import { commanderOf, cursorTo, goTo, launch } from "./helpers"

// The text editor window (Stage C10.6, ADR-0046): F4 opens a file in an editor
// window of its own; it saves in the file's own encoding and line endings,
// never over a change made elsewhere without asking, and asks before closing
// with unsaved changes.

function writeResult(result: object, stage = "C10.6"): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(
    repoRoot,
    "src",
    "shared",
    "bench",
    "results",
    `stage-${stage}-${date}-e2e-texteditor.jsonl`,
  )
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

/** A folder with a Markdown file, a legacy Windows-1252 file with CRLF, a binary and 1 MB of Markdown. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "panelyth-c106-"))
  writeFileSync(join(dir, "notes.md"), "# Notes\n\nFirst line\n")
  // "Grüße\r\n5 €\r\n" in Windows-1252: ü = FC, ß = DF, € = 80.
  writeFileSync(
    join(dir, "legacy.txt"),
    Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65, 0x0d, 0x0a, 0x35, 0x20, 0x80, 0x0d, 0x0a]),
  )
  writeFileSync(join(dir, "data.bin"), Buffer.from([0, 1, 2, 0, 0, 255, 0, 7, 0, 0, 0, 3]))
  const para = "Some **bold** text, a [link](https://example.org) and `code`.\n\n"
  const big = Array.from({ length: Math.ceil(1_000_000 / para.length) }, (_, i) =>
    i % 50 === 0 ? `## Section ${i / 50}\n\n` : para,
  ).join("")
  writeFileSync(join(dir, "big.md"), big)
  return dir
}

/** F4 on a file; the editor window that opens, with its text painted. */
async function edit(app: ElectronApplication, c: Page, name: string): Promise<Page> {
  // The Full view shows the extension in a column of its own: the stems here are unique.
  await cursorTo(c, "left", name.replace(/\.[^.]+$/, ""))
  const opened = app.waitForEvent("window", (p) =>
    p.url().startsWith("app://texteditor/index.html"),
  )
  await c.keyboard.press("F4")
  const editor = await opened
  await expect(editor.locator(".cm-content")).toBeVisible()
  return editor
}

/** Types at the end of the document. */
async function typeAtEnd(editor: Page, text: string): Promise<void> {
  await editor.locator(".cm-content").click()
  await editor.keyboard.press("Control+End")
  await editor.keyboard.type(text)
}

const editorWindows = (app: ElectronApplication) =>
  app.evaluate(
    () =>
      (
        globalThis as unknown as { __panelythShellState: () => { textEditorWindows: number } }
      ).__panelythShellState().textEditorWindows,
  )

/**
 * Teardown: editor windows a failed step left open, discarded. One with unsaved
 * changes would otherwise ask, and keep the app from quitting.
 */
const discardEditors = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.webContents.getURL().startsWith("app://texteditor/")) w.destroy()
    }
  })

/** The user's close of the editor window (its frame's ×). */
const closeWindow = (app: ElectronApplication, title: RegExp) =>
  app.evaluate(({ BrowserWindow }, source) => {
    const pattern = new RegExp(source)
    BrowserWindow.getAllWindows()
      .find((w) => pattern.test(w.getTitle()))
      ?.close()
  }, title.source)

test.describe("the text editor window (Stage C10.6)", () => {
  test("F4 edits a Markdown file and saves it; a legacy file keeps its encoding and line endings", async () => {
    const dir = fixture()
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", dir)

      const notes = await edit(app, c, "notes.md")
      await expect(notes.getByTestId("status-encoding")).toHaveText("UTF-8")
      await expect(notes.getByTestId("status-eol")).toHaveText("LF")
      await expect(notes.getByTestId("status-language")).toContainText("Markdown")
      await typeAtEnd(notes, "Second line")
      await expect(notes.getByTestId("dirty-dot")).toBeVisible()
      const t0 = Date.now()
      await notes.keyboard.press("Control+s")
      await expect(notes.getByTestId("dirty-dot")).toHaveCount(0)
      const saveMs = Date.now() - t0
      expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("# Notes\n\nFirst line\nSecond line")
      // No program was started: Settings names no editor.
      await closeWindow(app, /notes\.md/)
      await expect.poll(() => editorWindows(app)).toBe(0)

      const legacy = await edit(app, c, "legacy.txt")
      await expect(legacy.getByTestId("status-encoding")).toContainText("1252")
      await expect(legacy.getByTestId("status-eol")).toHaveText("CRLF")
      await expect(legacy.locator(".cm-content")).toContainText("Grüße")
      await typeAtEnd(legacy, "ü")
      await legacy.keyboard.press("Control+s")
      await expect(legacy.getByTestId("dirty-dot")).toHaveCount(0)
      // Byte for byte: the old text unchanged, the new ü as FC, CRLF kept.
      expect([...readFileSync(join(dir, "legacy.txt"))]).toEqual([
        0x47, 0x72, 0xfc, 0xdf, 0x65, 0x0d, 0x0a, 0x35, 0x20, 0x80, 0x0d, 0x0a, 0xfc,
      ])
      await closeWindow(app, /legacy\.txt/)
      writeResult({ test: "save-small", saveMs })
    } finally {
      await discardEditors(app).catch(() => undefined)
      await app.close()
    }
  })

  test("a change made elsewhere is never overwritten without asking; unsaved changes are asked about", async () => {
    const dir = fixture()
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", dir)
      const notes = await edit(app, c, "notes.md")
      // Another program writes the file while it is open.
      writeFileSync(join(dir, "notes.md"), "Written elsewhere\n")
      await typeAtEnd(notes, "Mine")
      await notes.keyboard.press("Control+s")
      const conflict = notes.getByRole("dialog", { name: /changed on disk/ })
      await expect(conflict).toBeVisible()
      expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("Written elsewhere\n")
      await conflict.getByRole("button", { name: "Overwrite" }).click()
      await expect(notes.getByTestId("dirty-dot")).toHaveCount(0)
      expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("# Notes\n\nFirst line\nMine")

      // Closing with unsaved changes asks; Cancel keeps the window, "Don't save" closes it.
      await typeAtEnd(notes, " more")
      await closeWindow(app, /notes\.md/)
      const ask = notes.getByRole("dialog", { name: /Save the changes to notes\.md/ })
      await expect(ask).toBeVisible()
      await ask.getByRole("button", { name: "Cancel" }).click()
      await expect(ask).toHaveCount(0)
      expect(await editorWindows(app)).toBe(1)
      await closeWindow(app, /notes\.md/)
      // The click closes the window it is in: wait for the close, not for the click to settle.
      const dontSave = notes.getByRole("dialog").getByRole("button", { name: "Don't save" })
      await Promise.all([notes.waitForEvent("close"), dontSave.click().catch(() => undefined)])
      await expect.poll(() => editorWindows(app)).toBe(0)
      expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("# Notes\n\nFirst line\nMine")

      // F4 on a file the editor can't take says why; no window opens.
      await cursorTo(c, "left", "data")
      await c.keyboard.press("F4")
      await expect(c.getByText("data.bin isn't a text file. F3 views it.")).toBeVisible()
      expect(await editorWindows(app)).toBe(0)
    } finally {
      await discardEditors(app).catch(() => undefined)
      await app.close()
    }
  })

  test("1 MB of Markdown opens, finds and saves within the budgets", async () => {
    const dir = fixture()
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", dir)
      const big = await edit(app, c, "big.md")
      // The page's own mark: fetch, decode and the editor made.
      const openMs = await big.evaluate(
        () => performance.getEntriesByName("doceditor:open").at(-1)?.duration ?? -1,
      )
      expect(openMs).toBeGreaterThan(0)
      expect(openMs).toBeLessThan(300)

      // Typing: frames between keystrokes and long tasks while typing.
      await big.evaluate(() => {
        const w = window as unknown as { __long: number[] }
        w.__long = []
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) w.__long.push(e.duration)
        }).observe({ type: "longtask", buffered: false })
      })
      await typeAtEnd(big, "The end of a long document, typed key by key.")
      const longTasks = await big.evaluate(() => (window as unknown as { __long: number[] }).__long)
      expect(longTasks.filter((d) => d > 50)).toEqual([])

      // Find: the panel and its match count.
      await big.keyboard.press("Control+f")
      const find = big.getByRole("search", { name: "Find and replace" })
      await find.getByRole("textbox", { name: "Find" }).fill("Section 7")
      await expect(find).toContainText(/\d/)

      const t0 = Date.now()
      await big.keyboard.press("Control+s")
      await expect(big.getByTestId("dirty-dot")).toHaveCount(0)
      const saveMs = Date.now() - t0
      expect(readFileSync(join(dir, "big.md"), "utf8").endsWith("typed key by key.")).toBe(true)
      // Stage C10.7: 1 MB opens in Live (typing above was in Live); Preview's first screen.
      await expect(big.getByTestId("mode-live")).toHaveAttribute("aria-checked", "true")
      const p0 = Date.now()
      await big.getByTestId("mode-preview").click()
      await expect(big.getByTestId("preview").locator("[data-line]").first()).toBeVisible()
      const previewMs = Date.now() - p0
      expect(previewMs).toBeLessThan(1000)
      await big.getByTestId("mode-live").click()
      writeResult({ test: "open-save-1mb", openMs, saveMs, longTasks: longTasks.length, previewMs })
      await closeWindow(app, /big\.md/)
    } finally {
      await discardEditors(app).catch(() => undefined)
      await app.close()
    }
  })
})

// A 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

/** A Markdown document with a picture, a task, raw HTML and a javascript: link. */
function markdownFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "panelyth-c107-"))
  mkdirSync(join(dir, "assets"))
  writeFileSync(join(dir, "assets", "pic.png"), PNG)
  writeFileSync(
    join(dir, "readme.md"),
    [
      "# Title",
      "",
      "Some **bold** text.",
      "",
      "- [ ] a task",
      "",
      "![pic](assets/pic.png)",
      "",
      "<script>window.__pwned = true</script>",
      "",
      "[bad](javascript:alert(1)) and [good](https://example.org)",
      "",
    ].join("\n"),
  )
  return dir
}

const checked = (p: Page, testId: string) => p.getByTestId(testId)

test.describe("Markdown modes and pictures (Stage C10.7)", () => {
  test("Live, Source and Preview are one document; Preview renders it safely with its pictures", async () => {
    const dir = markdownFixture()
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", dir)
      const md = await edit(app, c, "readme.md")
      // Markdown opens in Live the first time.
      await expect(checked(md, "mode-live")).toHaveAttribute("aria-checked", "true")
      await expect(md.locator(".cm-md-live")).toHaveCount(1)
      // The picture under its line, through a token.
      await expect(md.locator("[data-testid=live-image] img")).toHaveAttribute(
        "src",
        /^panelyth-media:\/\/m\/[0-9a-f]{32}$/,
      )
      // A task box edits the text.
      // Live draws the marker as a box: its state, not "[x]", is on screen.
      await md.getByTestId("live-task").first().click()
      await expect(md.getByTestId("live-task").first()).toHaveAttribute("aria-checked", "true")
      await expect(md.getByTestId("dirty-dot")).toBeVisible()

      // Preview: the rendered page, with the same unsaved change.
      await checked(md, "mode-preview").click()
      const preview = md.getByTestId("preview")
      await expect(preview.locator("h1")).toHaveText("Title")
      await expect(preview.locator("strong")).toHaveText("bold")
      await expect(preview.locator("li.task input[disabled]")).toBeChecked()
      const img = preview.locator("img").first()
      await expect(img).toHaveAttribute("src", /^panelyth-media:/)
      await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(1)
      // Raw HTML is text, a javascript: link has no target, nothing ran.
      await expect(preview.locator("script")).toHaveCount(0)
      expect(
        await md.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned),
      ).toBeUndefined()
      await expect(preview.getByText("bad")).not.toHaveAttribute("href", /javascript/i)
      await expect(preview.locator("a[href^='https://example.org']")).toHaveCount(1)
      await expect(md.getByTestId("dirty-dot")).toBeVisible()

      // Ctrl+E steps on: Preview → Source → Live; the text is the same one.
      await md.keyboard.press("Control+e")
      await expect(checked(md, "mode-source")).toHaveAttribute("aria-checked", "true")
      await expect(md.locator(".cm-content")).toContainText("- [x] a task")
      await md.keyboard.press("Control+z")
      await expect(md.locator(".cm-content")).toContainText("- [ ] a task")
      await expect(md.getByTestId("dirty-dot")).toHaveCount(0)
      await md.keyboard.press("Control+e")
      await expect(checked(md, "mode-live")).toHaveAttribute("aria-checked", "true")
      await closeWindow(app, /readme\.md/)
    } finally {
      await discardEditors(app).catch(() => undefined)
      await app.close()
    }
  })

  test("a pasted picture goes into assets/ beside the file and its link into the text", async () => {
    const dir = markdownFixture()
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", dir)
      const md = await edit(app, c, "readme.md")
      await md.locator(".cm-content").click()
      await md.keyboard.press("Control+End")
      // A paste with a picture in it (the OS clipboard is left alone).
      await md.evaluate(
        (bytes) => {
          const data = new DataTransfer()
          data.items.add(new File([new Uint8Array(bytes)], "shot.png", { type: "image/png" }))
          const content = document.querySelector(".cm-content")!
          content.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
          )
        },
        [...PNG],
      )
      await expect(md.locator(".cm-content")).toContainText(/!\[[^\]]*\]\(assets\/[^)]+\.png\)/)
      const text = await md.locator(".cm-content").innerText()
      const link = /!\[[^\]]*\]\((assets\/[^)]+\.png)\)/.exec(text)![1]!
      // The same bytes were already there: the existing file is linked, nothing is written twice.
      expect(link).toBe("assets/pic.png")

      // New bytes: a new file.
      const other = Buffer.from(PNG)
      // A different CRC: different bytes, still a PNG by its header.
      other.writeUInt8(other.readUInt8(other.length - 5) ^ 1, other.length - 5)
      await md.evaluate(
        (bytes) => {
          const data = new DataTransfer()
          data.items.add(new File([new Uint8Array(bytes)], "shot.png", { type: "image/png" }))
          document
            .querySelector(".cm-content")!
            .dispatchEvent(
              new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
            )
        },
        [...other],
      )
      await expect
        .poll(() => readdirSync(join(dir, "assets")).sort())
        .toEqual(expect.arrayContaining(["pic.png"]))
      await expect.poll(() => readdirSync(join(dir, "assets")).length).toBe(2)
      await md.keyboard.press("Control+s")
      await expect(md.getByTestId("dirty-dot")).toHaveCount(0)
      const saved = readFileSync(join(dir, "readme.md"), "utf8")
      const added = readdirSync(join(dir, "assets")).find((n) => n !== "pic.png")!
      expect(saved).toContain(`](assets/${added.replace(/ /g, "%20")})`)
      await closeWindow(app, /readme\.md/)
    } finally {
      await discardEditors(app).catch(() => undefined)
      await app.close()
    }
  })
})

test.describe("quitting with unsaved text (ADR-0046)", () => {
  test("the editor asks before anything stops; Save still works; then the app quits", async () => {
    const dir = fixture()
    const { app } = await launch("commander")
    const exited = new Promise<void>((resolve) => app.process().once("exit", () => resolve()))
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", dir)
      const notes = await edit(app, c, "notes.md")
      await typeAtEnd(notes, "Kept")
      await expect(notes.getByTestId("dirty-dot")).toBeVisible()
      await app.evaluate(({ app: a }) => a.quit())
      const ask = notes.getByRole("dialog", { name: /Save the changes to notes\.md/ })
      await expect(ask).toBeVisible()
      // Still running, with its sidecar: Save writes the file.
      await Promise.all([
        notes.waitForEvent("close"),
        ask
          .getByRole("button", { name: "Save", exact: true })
          .click()
          .catch(() => undefined),
      ])
      expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("# Notes\n\nFirst line\nKept")
      await app.evaluate(({ app: a }) => a.quit())
      await exited
    } finally {
      await discardEditors(app).catch(() => undefined)
      await app.close().catch(() => undefined)
    }
  })
})

test.describe("F3 and F4 on Markdown (owner request)", () => {
  test("F3 shows it in Preview; F4 turns that window to editing in Live", async () => {
    const dir = markdownFixture()
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", dir)
      await cursorTo(c, "left", "readme")
      const opened = app.waitForEvent("window", (p) =>
        p.url().startsWith("app://texteditor/index.html"),
      )
      await c.keyboard.press("F3")
      const md = await opened
      // The rendered page, read-only (owner request: F3 opens Preview).
      await expect(md.getByTestId("mode-preview")).toHaveAttribute("aria-checked", "true")
      await expect(md.getByTestId("preview").locator("h1")).toHaveText("Title")
      const host = md.getByTestId("editor-host")
      await expect(host).toHaveAttribute("data-readonly", "true")
      await expect(md.getByTestId("readonly-mark")).toBeVisible()
      await expect(md.getByTestId("save")).toHaveCount(0)
      // Typing changes nothing.
      await md.getByTestId("preview").click()
      await md.keyboard.type("nope")
      await expect(md.getByTestId("dirty-dot")).toHaveCount(0)

      // F4 on the same file: no second window; editing starts in this one.
      await c.bringToFront()
      await cursorTo(c, "left", "readme")
      await c.keyboard.press("F4")
      await expect(host).toHaveAttribute("data-readonly", "false")
      expect(await editorWindows(app)).toBe(1)
      await expect(md.getByTestId("mode-live")).toHaveAttribute("aria-checked", "true")
      await typeAtEnd(md, "Edited")
      await expect(md.getByTestId("dirty-dot")).toBeVisible()
      await md.keyboard.press("Control+s")
      await expect(md.getByTestId("dirty-dot")).toHaveCount(0)
      expect(readFileSync(join(dir, "readme.md"), "utf8").endsWith("Edited")).toBe(true)
      await closeWindow(app, /readme\.md/)
    } finally {
      await discardEditors(app).catch(() => undefined)
      await app.close()
    }
  })
})

/** The text and the page count of a PDF, read with pdf.js (the document window's own reader). */
async function readPdf(path: string): Promise<{ pages: number; text: string; images: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(readFileSync(path)),
    useSystemFonts: true,
  }).promise
  let text = ""
  let images = 0
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    text += content.items.map((i) => ("str" in i ? i.str : "")).join(" ") + "\n"
    const ops = await page.getOperatorList()
    images += ops.fnArray.filter((f) => f === pdfjs.OPS.paintImageXObject).length
  }
  return { pages: doc.numPages, text, images }
}

test.describe("PDF export (Stage C10.8)", () => {
  test("Markdown exports to a clean PDF: the page's text, its code and table, its picture", async () => {
    const dir = markdownFixture()
    writeFileSync(
      join(dir, "report.md"),
      [
        "# Quarterly report",
        "",
        "Some **bold** text and a [link](https://example.org).",
        "",
        "```",
        "const total = 42",
        "```",
        "",
        "| Name | Count |",
        "|------|------:|",
        "| Apples | 3 |",
        "",
        "![pic](assets/pic.png)",
        "",
      ].join("\n"),
    )
    const pdf = join(dir, "out", "report.pdf")
    mkdirSync(join(dir, "out"))
    const { app } = await launch("commander", { PANELYTH_TEST_SAVE_PATH: pdf })
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", dir)
      const md = await edit(app, c, "report.md")
      await md.getByTestId("export-pdf").click()
      const dialog = md.getByRole("dialog", { name: "Export PDF" })
      await dialog.getByRole("radio", { name: "A4" }).check()
      await dialog.getByRole("button", { name: "Export", exact: true }).click()
      await expect(md.getByTestId("status-notice")).toContainText("report.pdf")
      await expect(md.getByTestId("print-view")).toHaveCount(0)
      expect(readFileSync(pdf).subarray(0, 5).toString()).toBe("%PDF-")
      const { pages, text, images } = await readPdf(pdf)
      expect(pages).toBeGreaterThanOrEqual(1)
      expect(text).toContain("Quarterly report")
      expect(text).toContain("const total = 42")
      expect(text).toContain("Apples")
      expect(text).toContain("https://example.org")
      expect(images).toBeGreaterThanOrEqual(1)
      await closeWindow(app, /report\.md/)
    } finally {
      await discardEditors(app).catch(() => undefined)
      await app.close()
    }
  })

  test("about 100 pages export within the budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panelyth-c108-"))
    // 300 sections: about 100 A4 pages (100 made 34).
    const sections = Array.from({ length: 300 }, (_, i) =>
      [
        `## Section ${i + 1}`,
        "",
        "A paragraph of plain text that fills part of the page. ".repeat(12),
        "",
        "```",
        `function step${i}() { return ${i} }`,
        "```",
        "",
        "| a | b |",
        "|---|---|",
        `| ${i} | ${i * 2} |`,
        "",
      ].join("\n"),
    )
    writeFileSync(join(dir, "long.md"), sections.join("\n"))
    const pdf = join(dir, "long.pdf")
    const { app } = await launch("commander", { PANELYTH_TEST_SAVE_PATH: pdf })
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", dir)
      const md = await edit(app, c, "long.md")
      await md.getByTestId("export-pdf").click()
      const t0 = Date.now()
      await md
        .getByRole("dialog", { name: "Export PDF" })
        .getByRole("button", { name: "Export", exact: true })
        .click()
      await expect(md.getByTestId("status-notice")).toContainText("long.pdf", { timeout: 20_000 })
      const exportMs = Date.now() - t0
      const { pages, text } = await readPdf(pdf)
      expect(text).toContain("Section 300")
      expect(pages).toBeGreaterThanOrEqual(90)
      expect(exportMs).toBeLessThan(5000)
      writeResult({ test: "export-pdf", pages, exportMs }, "C10.8")
      await closeWindow(app, /long\.md/)
    } finally {
      await discardEditors(app).catch(() => undefined)
      await app.close()
    }
  })
})
