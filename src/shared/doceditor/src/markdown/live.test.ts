import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { ensureSyntaxTree } from "@codemirror/language"
import { EditorSelection, EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createImageResolver, type ResolveBatch } from "./images"
import { liveMarkdown } from "./live"

const TOKEN = `panelyth-media://m/${"1".repeat(32)}`
let views: EditorView[] = []
afterEach(() => {
  for (const v of views) v.destroy()
  views = []
})

function open(doc: string, cursor = doc.length, resolve?: ResolveBatch) {
  const resolver = createImageResolver(
    resolve ??
      (async (links) =>
        links.map((link) => ({ link, src: link.startsWith("assets/") ? TOKEN : null }))),
  )
  const onLink = vi.fn()
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [markdown({ base: markdownLanguage }), liveMarkdown({ resolver, onLink })],
    }),
  })
  ensureSyntaxTree(view.state, view.state.doc.length, 5000)
  // A no-op update so the plugin sees the finished tree.
  view.dispatch({})
  views.push(view)
  return { view, onLink, resolver }
}

/** The text each rendered line shows (hidden marks are not in the DOM). */
const shown = (view: EditorView): string[] =>
  [...view.contentDOM.querySelectorAll(".cm-line")].map((l) => l.textContent ?? "")

const lineEl = (view: EditorView, n: number): Element =>
  view.contentDOM.querySelectorAll(".cm-line")[n - 1]!

describe("the live view", () => {
  it("hides the marks away from the cursor's line and shows them on it", () => {
    const doc = "# Title\n\nSome **bold**, *em*, ~~old~~ and `code`.\n\n> quoted\n\nend"
    const { view } = open(doc)
    expect(shown(view)).toEqual([
      "Title",
      "",
      "Some bold, em, old and code.",
      "",
      "quoted",
      "",
      "end",
    ])
    expect(lineEl(view, 1).classList.contains("cm-md-h1")).toBe(true)
    expect(lineEl(view, 3).querySelector(".cm-md-strong")?.textContent).toBe("bold")
    expect(lineEl(view, 5).classList.contains("cm-md-quote")).toBe(true)

    // The cursor on line 3: its marks show, the heading's stay hidden.
    view.dispatch({ selection: { anchor: doc.indexOf("Some") } })
    expect(shown(view)[2]).toBe("Some **bold**, *em*, ~~old~~ and `code`.")
    expect(shown(view)[0]).toBe("Title")
    // And on the heading.
    view.dispatch({ selection: { anchor: 2 } })
    expect(shown(view)[0]).toBe("# Title")
  })

  it("shows links by their text with the target as a tooltip; Ctrl+click shows the target", () => {
    const { view, onLink } = open("See [the site](https://example.com) now\n\nx")
    expect(shown(view)[0]).toBe("See the site now")
    const link = lineEl(view, 1).querySelector(".cm-md-link")!
    expect(link.getAttribute("title")).toBe("https://example.com")
    link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, ctrlKey: true }))
    expect(onLink).toHaveBeenCalledWith("https://example.com")
  })

  it("keeps the text exact when typing in a decorated line", () => {
    const doc = "# Head\n\nA **bold** word\n"
    const { view } = open(doc)
    const at = doc.indexOf("bold") + 2
    view.dispatch({ selection: { anchor: at } })
    view.dispatch({ changes: { from: at, insert: "XY" }, selection: { anchor: at + 2 } })
    expect(view.state.doc.toString()).toBe("# Head\n\nA **boXYld** word\n")
    expect(shown(view)[2]).toBe("A **boXYld** word")
    // Away from the line the marks hide again; the text stays as typed.
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    expect(shown(view)[2]).toBe("A boXYld word")
    expect(view.state.doc.toString()).toBe("# Head\n\nA **boXYld** word\n")
  })

  it("draws task boxes; a click ticks one by editing the text", () => {
    const doc = "- [ ] todo\n- [x] done\n\nend"
    const { view } = open(doc)
    const boxes = view.contentDOM.querySelectorAll("[data-testid=live-task]")
    expect([...boxes].map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "true"])
    boxes[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    expect(view.state.doc.toString()).toBe("- [x] todo\n- [x] done\n\nend")
    // The cursor stayed where it was.
    expect(view.state.selection.main.head).toBe(doc.length)
  })

  it("draws bullets, rules and tables", () => {
    const doc = "- one\n- two\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nend"
    const { view } = open(doc)
    expect(view.contentDOM.querySelectorAll(".cm-md-bullet")).toHaveLength(2)
    expect(view.contentDOM.querySelector(".cm-md-hr")).not.toBeNull()
    expect(lineEl(view, 6).classList.contains("cm-md-table-head")).toBe(true)
    expect(lineEl(view, 7).classList.contains("cm-md-table-delim")).toBe(true)
  })

  it("shows linked pictures under their line through resolved tokens, never web ones", async () => {
    const resolve = vi.fn<ResolveBatch>(async (links) =>
      links.map((link) => ({ link, src: link === "assets/a.png" ? TOKEN : null })),
    )
    const doc = "![A](assets/a.png)\n\n![B](gone.png)\n\n![W](https://web.example/w.png)\n\nend"
    const { view } = open(doc, doc.length, resolve)
    await vi.waitFor(() => expect(view.contentDOM.querySelector(".cm-md-image img")).not.toBeNull())
    const img = view.contentDOM.querySelector<HTMLImageElement>(".cm-md-image img")!
    expect(img.getAttribute("src")).toBe(TOKEN)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0]![0]).toEqual(["assets/a.png", "gone.png"])
    const placeholders = [...view.contentDOM.querySelectorAll(".cm-md-image-placeholder")]
    expect(placeholders.map((p) => p.getAttribute("title"))).toEqual([
      "gone.png",
      "https://web.example/w.png",
    ])
    // The alt text shows; the syntax is hidden.
    expect(shown(view)[0]).toBe("A")
  })
})
