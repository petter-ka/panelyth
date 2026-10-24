import { markdownLanguage } from "@codemirror/lang-markdown"
import { Text } from "@codemirror/state"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createImageResolver, type ResolveBatch } from "./images"
import { createPreview, sanitize } from "./preview"

const TOKEN = `panelyth-media://m/${"a".repeat(32)}`
const microtask = (next: () => void): void => queueMicrotask(next)

afterEach(() => vi.restoreAllMocks())

function setup(resolve?: ResolveBatch) {
  const resolver = createImageResolver(
    resolve ??
      (async (links) =>
        links.map((link) => ({ link, src: link.startsWith("assets/") ? TOKEN : null }))),
  )
  const onLink = vi.fn()
  const preview = createPreview({ resolver, onLink, yieldTo: microtask })
  document.body.appendChild(preview.element)
  return { preview, onLink, resolver }
}

const doc = (text: string): Text => Text.of(text.split("\n"))

describe("sanitize", () => {
  it("removes scripts, handlers and unsafe links; keeps what the serializer writes", () => {
    const out = sanitize(
      '<p data-line="1" onclick="x()">a<script>alert(1)</script></p><a href="javascript:alert(1)">j</a>' +
        '<iframe src="x"></iframe><a href="https://ok.example" title="t">ok</a><td class="align-right">1</td>',
    )
    expect(out).not.toMatch(/script|onclick|iframe|javascript/)
    expect(out).toContain('<p data-line="1">a</p>')
    expect(out).toContain('href="https://ok.example"')
  })

  it("lets only token pictures through; others become placeholders", () => {
    expect(sanitize(`<img src="${TOKEN}" alt="ok">`)).toContain(`src="${TOKEN}"`)
    for (const src of [
      "https://web/x.png",
      "assets/x.png",
      "data:image/png;base64,AA",
      "file:///c:/x.png",
    ]) {
      const out = sanitize(`<img src="${src}" alt="alt">`)
      expect(out, src).not.toContain("<img")
      expect(out, src).toContain("md-image-placeholder")
    }
  })

  it("keeps task boxes read-only and drops other inputs", () => {
    expect(sanitize('<input type="checkbox" checked>')).toMatch(/<input[^>]*disabled/)
    expect(sanitize('<input type="text" value="x">')).not.toContain("<input")
  })
})

describe("the preview", () => {
  it("renders the page with pictures resolved in one batch, read-only", async () => {
    const resolve = vi.fn<ResolveBatch>(async (links) =>
      links.map((link) => ({ link, src: link === "assets/a.png" ? TOKEN : null })),
    )
    const { preview, onLink } = setup(resolve)
    const text =
      "# Title\n\n- [x] done\n\n![A](assets/a.png) ![W](https://w/x.png)\n\n[site](https://e.x)\n\n<b>raw</b>"
    await preview.show(doc(text), markdownLanguage.parser, 1)
    const page = preview.element
    expect(page.querySelector("h1")?.textContent).toBe("Title")
    expect(page.querySelector("h1")?.getAttribute("data-line")).toBe("1")
    expect(page.querySelector<HTMLInputElement>("li.task input")?.disabled).toBe(true)
    expect(page.querySelector("img")?.getAttribute("src")).toBe(TOKEN)
    expect(page.querySelector(".md-image-web")).not.toBeNull()
    expect(page.querySelector("b")).toBeNull()
    expect(page.textContent).toContain("<b>raw</b>")
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0]![0]).toEqual(["assets/a.png"])
    expect(page.querySelector('[contenteditable="true"]')).toBeNull()

    const link = page.querySelector("a")!
    const click = new MouseEvent("click", { bubbles: true, cancelable: true })
    link.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(onLink).toHaveBeenCalledWith("https://e.x")
  })

  it("fills a long document section by section, the visible one first", async () => {
    const { preview } = setup()
    const text = Array.from({ length: 300 }, (_, i) => `Paragraph ${i + 1}`).join("\n\n")
    const sanitizeOrder: number[] = []
    const show = preview.show(doc(text), markdownLanguage.parser, 401)
    const observer = new MutationObserver(() => {
      for (const s of preview.element.querySelectorAll(".md-section:not(.md-section-pending)")) {
        const line = Number(s.querySelector("[data-line]")?.getAttribute("data-line"))
        if (!sanitizeOrder.includes(line)) sanitizeOrder.push(line)
      }
    })
    observer.observe(preview.element, { subtree: true, childList: true, attributes: true })
    await show
    await vi.waitFor(() =>
      expect(preview.element.querySelectorAll(".md-section-pending")).toHaveLength(0),
    )
    observer.disconnect()
    expect(preview.element.querySelectorAll("p[data-line]")).toHaveLength(300)
    // Section 6 (blocks 201–240, lines 401–479) came first.
    expect(sanitizeOrder[0]).toBe(401)
  })

  it("scrolls to the block of a line, and reads the line in view back", async () => {
    const { preview } = setup()
    const text = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join("\n\n")
    // jsdom has no layout: each block is 20px high, in source order.
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return (Number(this.dataset.line ?? 1) - 1) * 10
    })
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(20)
    await preview.show(doc(text), markdownLanguage.parser, 21)
    // Line 21 is the 11th paragraph: offsetTop 200, less the 12px margin.
    expect(preview.element.scrollTop).toBe(188)
    preview.element.scrollTop = 400
    // The block of line 39 ends at 400px; line 41's starts there.
    expect(preview.topLine()).toBe(41)
  })

  it("reuses the last render of the same text", async () => {
    const parse = vi.spyOn(markdownLanguage.parser, "startParse")
    const { preview } = setup()
    const d = doc("# Same\n\ntext")
    await preview.show(d, markdownLanguage.parser, 1)
    await preview.show(d, markdownLanguage.parser, 1)
    expect(parse).toHaveBeenCalledTimes(1)
    await preview.show(doc("# Other"), markdownLanguage.parser, 1)
    expect(parse).toHaveBeenCalledTimes(2)
  })
})
