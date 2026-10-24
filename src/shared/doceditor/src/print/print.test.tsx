import { jsonLanguage } from "@codemirror/lang-json"
import { markdownLanguage } from "@codemirror/lang-markdown"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../App"
import { createImageResolver, type ResolveBatch } from "../markdown/images"
import { fakeApi, type FakeApi } from "../testing/fakeApi"
import { createWorkspace, type Workspace } from "../workspace"
import { createExporter, type ExportState } from "./exporter"
import { readPdfChoice, writePdfChoice } from "./prefs"
import { buildPrintView, type PrintSource } from "./printView"

const TOKEN = `panelyth-media://m/${"b".repeat(32)}`
const microtask = (next: () => void): void => queueMicrotask(next)
const FAST = { yieldTo: microtask, imageTimeoutMs: 50 }

beforeEach(() => localStorage.clear())

const resolverFor = (resolve?: ResolveBatch) =>
  createImageResolver(
    resolve ??
      (async (links) =>
        links.map((link) => ({ link, src: link.startsWith("assets/") ? TOKEN : null }))),
  )

const MARKDOWN = [
  "# Report",
  "",
  "```js",
  "if (a < b) run()",
  "```",
  "",
  "| a | b |",
  "|---|--:|",
  "| 1 | 2 |",
  "",
  "![Chart](assets/chart.png) ![Web](https://web.example/w.png)",
  "",
  "- [x] done",
  "- [ ] open",
  "",
  "See [the site](https://example.com) and [a note](notes/a.md).",
  "",
  '<script>alert(1)</script> <img src=x onerror="alert(1)">',
  "",
  "Also [bad](javascript:alert(1)) here.",
].join("\n")

describe("the print view of a Markdown document", () => {
  it("renders the page with resolved pictures and harmless HTML", async () => {
    const view = document.createElement("div")
    const source: PrintSource = {
      text: MARKDOWN,
      markdown: true,
      parser: markdownLanguage.parser,
      resolver: resolverFor(),
    }
    expect(await buildPrintView(view, source, FAST)).toBe(true)
    expect(view.querySelector(".print-md h1")?.textContent).toBe("Report")
    expect(view.querySelector("pre code.language-js")?.textContent).toBe("if (a < b) run()")
    expect(view.querySelector("table th")?.textContent).toBe("a")
    expect(view.querySelector("td.align-right")?.textContent).toBe("2")
    expect(view.querySelector("img")?.getAttribute("src")).toBe(TOKEN)
    expect(view.querySelector(".md-image-web")?.textContent).toBe("Web")
    const boxes = [...view.querySelectorAll<HTMLInputElement>("li.task input")]
    expect(boxes.map((b) => b.checked)).toEqual([true, false])
    expect(boxes.every((b) => b.disabled)).toBe(true)
    const links = [...view.querySelectorAll("a")].map((a) => a.getAttribute("href"))
    expect(links).toEqual(["https://example.com", "notes/a.md"])
    // Unsafe HTML stays text; the javascript: link is no link.
    expect(view.querySelector("script")).toBeNull()
    expect(view.querySelector("[onerror]")).toBeNull()
    expect(view.textContent).toContain("<script>alert(1)</script>")
    // The blocked target may show as a tooltip's text, never as an address.
    const addresses = [...view.querySelectorAll("[href], [src]")].map(
      (el) => el.getAttribute("href") ?? el.getAttribute("src") ?? "",
    )
    expect(addresses.some((a) => /javascript:/i.test(a))).toBe(false)
    expect(view.querySelector(".md-link-blocked")?.textContent).toBe("bad")
  })

  it("resolves every picture in batches of at most 200, in order", async () => {
    const resolve = vi.fn<ResolveBatch>(async (links) =>
      links.map((link) => ({ link, src: TOKEN })),
    )
    const text = Array.from({ length: 450 }, (_, i) => `![p${i}](assets/p${i}.png)`).join("\n\n")
    const view = document.createElement("div")
    await buildPrintView(
      view,
      { text, markdown: true, parser: markdownLanguage.parser, resolver: resolverFor(resolve) },
      FAST,
    )
    expect(resolve.mock.calls.map((c) => c[0].length)).toEqual([200, 200, 50])
    expect(view.querySelectorAll("img")).toHaveLength(450)
  })
})

describe("the print view of a text file", () => {
  it("prints the source escaped, numbered and coloured", async () => {
    const text = '{\n  "name": "<b>bold</b>",\n  "count": 3,\n  "ok": true\n}\n'
    const view = document.createElement("div")
    await buildPrintView(
      view,
      { text, markdown: false, parser: jsonLanguage.parser, resolver: null },
      FAST,
    )
    const rows = [...view.querySelectorAll(".print-code .pl")]
    expect(rows.map((r) => r.querySelector(".pn")?.textContent)).toEqual(["1", "2", "3", "4", "5"])
    expect(rows.map((r) => r.querySelector(".pc")?.textContent)).toEqual([
      "{",
      '  "name": "<b>bold</b>",',
      '  "count": 3,',
      '  "ok": true',
      "}",
    ])
    expect(view.querySelector("b")).toBeNull()
    expect(view.querySelector(".tok-string")?.textContent).toBe('"<b>bold</b>"')
    expect(view.querySelector(".tok-number")?.textContent).toBe("3")
    expect(view.querySelector(".tok-propertyName")).not.toBeNull()
    expect(
      (view.querySelector(".print-code") as HTMLElement).style.getPropertyValue("--gutter"),
    ).toBe("2ch")
  })

  it("prints plain text without a parser", async () => {
    const view = document.createElement("div")
    await buildPrintView(
      view,
      { text: "a < b\n\nc", markdown: false, parser: null, resolver: null },
      FAST,
    )
    expect([...view.querySelectorAll(".pc")].map((c) => c.textContent)).toEqual(["a < b", "", "c"])
  })
})

describe("the export's choice", () => {
  it("defaults to Letter in the United States, A4 elsewhere, normal margins", () => {
    expect(readPdfChoice("en-US")).toEqual({ pageSize: "Letter", margins: "normal" })
    expect(readPdfChoice("de-DE")).toEqual({ pageSize: "A4", margins: "normal" })
    expect(readPdfChoice("en-GB")).toEqual({ pageSize: "A4", margins: "normal" })
  })

  it("remembers the last choice, ignoring nonsense", () => {
    writePdfChoice({ pageSize: "Letter", margins: "wide" })
    expect(readPdfChoice("de-DE")).toEqual({ pageSize: "Letter", margins: "wide" })
    localStorage.setItem("panelyth.editor.pdf", '{"pageSize":"A0","margins":"huge"}')
    expect(readPdfChoice("de-DE")).toEqual({ pageSize: "A4", margins: "normal" })
  })
})

describe("the export flow", () => {
  function setup(api: FakeApi = fakeApi(), text = "# Doc\n\n![p](assets/p.png)") {
    const states: ExportState[] = []
    const notices: string[] = []
    const resolver = resolverFor(async (links) => {
      const envelope = (await api.resolveImages(links)) as {
        ok: true
        r: { images: { link: string; src: string | null }[] }
      }
      return envelope.r.images
    })
    const exporter = createExporter({
      api,
      notify: (t) => notices.push(t),
      setState: (s) => states.push(s),
      source: async () => ({ text, markdown: true, parser: markdownLanguage.parser, resolver }),
      build: FAST,
    })
    return { api, exporter, states, notices }
  }
  const printViews = (): number => document.querySelectorAll("[data-testid=print-view]").length

  it("prints after the pictures resolved, then takes the view away", async () => {
    const { api, exporter, states, notices } = setup()
    let viewDuringPrint = 0
    api.exportPdf = vi.fn(async (params) => {
      viewDuringPrint = printViews()
      api.exports.push(params)
      return { ok: true as const, r: { saved: true, name: "Doc.pdf" } }
    })
    await exporter.run({ pageSize: "A4", margins: "normal" })
    expect(vi.mocked(api.resolveImages).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.exportPdf).mock.invocationCallOrder[0]!,
    )
    expect(viewDuringPrint).toBe(1)
    expect(api.exports).toEqual([{ pageSize: "A4", margins: "normal" }])
    expect(printViews()).toBe(0)
    expect(states).toEqual(["building", "printing", "idle"])
    expect(notices).toEqual(["Exported Doc.pdf"])
  })

  it("a cancelled save dialog says nothing; an error says so; the view goes either way", async () => {
    const { api, exporter, notices } = setup()
    api.exportAnswer = { ok: true, r: { saved: false, name: null } }
    await exporter.run({ pageSize: "Letter", margins: "wide" })
    expect(notices).toEqual([])
    expect(printViews()).toBe(0)
    api.exportAnswer = {
      ok: false,
      e: { code: "INTERNAL", message: "disk full", retryable: false },
    }
    await exporter.run({ pageSize: "Letter", margins: "wide" })
    expect(notices).toEqual(["The PDF could not be exported: disk full"])
    expect(printViews()).toBe(0)
  })

  it("cancelled while building, it never prints", async () => {
    const text = Array.from({ length: 3000 }, (_, i) => `Paragraph ${i}`).join("\n\n")
    const { api, exporter, states } = setup(fakeApi(), text)
    const run = exporter.run({ pageSize: "A4", margins: "normal" })
    exporter.cancel()
    await run
    expect(api.exportPdf).not.toHaveBeenCalled()
    expect(printViews()).toBe(0)
    expect(states.at(-1)).toBe("idle")
  })

  it("runs one export at a time", async () => {
    const { api, exporter } = setup()
    await Promise.all([
      exporter.run({ pageSize: "A4", margins: "normal" }),
      exporter.run({ pageSize: "A4", margins: "normal" }),
    ])
    expect(api.exportPdf).toHaveBeenCalledTimes(1)
  })
})

describe("the Export PDF command", () => {
  let current: Workspace | null = null
  afterEach(() => {
    current?.destroy()
    current = null
  })

  it("opens the dialog from the header and Ctrl+Shift+E, exports with the choice and remembers it", async () => {
    const api = fakeApi()
    api.currentSession = { ...api.currentSession, name: "config.json", readOnly: true }
    const workspace = createWorkspace({
      api,
      session: api.currentSession,
      text: '{ "a": 1 }',
      dark: true,
    })
    current = workspace
    render(<App workspace={workspace} />)
    // Read-only windows export too.
    fireEvent.click(screen.getByTestId("export-pdf"))
    const dialog = await screen.findByRole("dialog", { name: "Export PDF" })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByRole("radio", { name: "Normal" })).toBeChecked()
    fireEvent.click(screen.getByRole("radio", { name: "Letter" }))
    fireEvent.click(screen.getByRole("radio", { name: "Narrow" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Export" }))
    })
    await waitFor(() => expect(api.exports).toEqual([{ pageSize: "Letter", margins: "narrow" }]))
    await waitFor(() =>
      expect(screen.getByTestId("status-notice")).toHaveTextContent("Exported notes.pdf"),
    )
    expect(document.querySelector("[data-testid=print-view]")).toBeNull()

    act(() => {
      fireEvent.keyDown(window, { key: "E", code: "KeyE", ctrlKey: true, shiftKey: true })
    })
    await screen.findByRole("dialog", { name: "Export PDF" })
    expect(screen.getByRole("radio", { name: "Letter" })).toBeChecked()
    expect(screen.getByRole("radio", { name: "Narrow" })).toBeChecked()
  })
})
