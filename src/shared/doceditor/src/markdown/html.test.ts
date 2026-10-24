import { markdownLanguage } from "@codemirror/lang-markdown"
import { describe, expect, it } from "vitest"
import { imageLinks, renderBlocks, renderHtml, safeHref, type HtmlOptions } from "./html"

const html = (text: string, options?: HtmlOptions): string =>
  renderHtml(text, markdownLanguage.parser.parse(text), options)

describe("renderHtml: CommonMark", () => {
  it.each([
    ["# Title", '<h1 data-line="1">Title</h1>'],
    ["### Three ###", '<h3 data-line="1">Three</h3>'],
    ["Title\n=====", '<h1 data-line="1">Title</h1>'],
    ["Sub\n---", '<h2 data-line="1">Sub</h2>'],
    ["one\ntwo", '<p data-line="1">one\ntwo</p>'],
    [
      "*em* _em_ **strong** __strong__",
      '<p data-line="1"><em>em</em> <em>em</em> <strong>strong</strong> <strong>strong</strong></p>',
    ],
    ["`a < b`", '<p data-line="1"><code>a &lt; b</code></p>'],
    ["`` `x` ``", '<p data-line="1"><code>`x`</code></p>'],
    ["line  \nbreak", '<p data-line="1">line<br>break</p>'],
    ["\\*not em\\*", '<p data-line="1">*not em*</p>'],
    ["&amp; &copy; &#35;", '<p data-line="1">&amp; &copy; &#35;</p>'],
    ["> quote\n> more", '<blockquote data-line="1"><p>quote\nmore</p></blockquote>'],
    ["---", '<hr data-line="1">'],
    [
      "```js\nlet a = 1 < 2\n```",
      '<pre data-line="1"><code class="language-js">let a = 1 &lt; 2</code></pre>',
    ],
    ["    indented\n    code", '<pre data-line="1"><code>indented\ncode</code></pre>'],
    ["- a\n- b", '<ul data-line="1"><li>a</li><li>b</li></ul>'],
    ["- a\n\n- b", '<ul data-line="1"><li><p>a</p></li><li><p>b</p></li></ul>'],
    ["3. c\n4. d", '<ol data-line="1" start="3"><li>c</li><li>d</li></ol>'],
    ["- a\n  - b", '<ul data-line="1"><li>a<ul><li>b</li></ul></li></ul>'],
    [
      '[site](https://example.com "Title")',
      '<p data-line="1"><a href="https://example.com" title="Title">site</a></p>',
    ],
    [
      "[rel](docs/a%20b.md)",
      '<p data-line="1"><a href="docs/a%20b.md" title="docs/a%20b.md">rel</a></p>',
    ],
    [
      '[ref][r]\n\n[r]: https://r.example "R"',
      '<p data-line="1"><a href="https://r.example" title="R">ref</a></p>',
    ],
    [
      "<https://auto.example>",
      '<p data-line="1"><a href="https://auto.example" title="https://auto.example">https://auto.example</a></p>',
    ],
    [
      "<me@example.com>",
      '<p data-line="1"><a href="mailto:me@example.com" title="me@example.com">me@example.com</a></p>',
    ],
  ])("%j", (source, expected) => {
    expect(html(source)).toBe(expected)
  })

  it("numbers each top-level block with its source line", () => {
    const text = "# A\n\npara\n\n- x\n- y\n\n```\nc\n```\n"
    const blocks = renderBlocks(text, markdownLanguage.parser.parse(text))
    expect(blocks.map((b) => b.line)).toEqual([1, 3, 5, 8])
    expect(blocks.every((b) => b.html.includes(`data-line="${b.line}"`))).toBe(true)
  })
})

describe("renderHtml: GFM", () => {
  it("renders tables with alignment as classes (no style attributes)", () => {
    expect(html("| a | b | c |\n|:-|:-:|-:|\n| 1 | **2** |\n")).toBe(
      '<table data-line="1"><thead><tr><th class="align-left">a</th><th class="align-center">b</th><th class="align-right">c</th></tr></thead>' +
        '<tbody><tr><td class="align-left">1</td><td class="align-center"><strong>2</strong></td><td class="align-right"></td></tr></tbody></table>',
    )
  })

  it("renders task lists as disabled checkboxes", () => {
    expect(html("- [ ] todo\n- [x] done")).toBe(
      '<ul data-line="1"><li class="task"><input type="checkbox" disabled> todo</li>' +
        '<li class="task"><input type="checkbox" disabled checked> done</li></ul>',
    )
  })

  it("renders strikethrough and bare links", () => {
    expect(html("~~gone~~ www.example.com")).toBe(
      '<p data-line="1"><del>gone</del> <a href="http://www.example.com" title="www.example.com">www.example.com</a></p>',
    )
  })
})

describe("renderHtml: safety", () => {
  it("shows HTML as text, never as markup", () => {
    expect(html('<script>alert(1)</script>\n\nhi <img src=x onerror="alert(1)"> there')).toBe(
      '<pre class="md-html" data-line="1">&lt;script&gt;alert(1)&lt;/script&gt;</pre>\n' +
        '<p data-line="3">hi &lt;img src=x onerror=&quot;alert(1)&quot;&gt; there</p>',
    )
  })

  it("drops javascript:, data: and vbscript: links, also disguised", () => {
    for (const url of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\tscript:x",
      "data:text/html,x",
      "vbscript:x",
      "//evil.example",
    ]) {
      expect(safeHref(url), url).toBeNull()
    }
    const out = html("[x](javascript:alert(1)) [y](<java\tscript:alert(1)>)")
    expect(out).not.toMatch(/href/)
    expect(out).toContain('class="md-link-blocked"')
  })

  it("keeps an entity-disguised scheme inert by escaping it in the attribute", () => {
    expect(html("[x](javascript&#58;alert(1))")).toContain('href="javascript&amp;#58;alert(1)"')
  })

  it("escapes quotes in titles and alt text", () => {
    expect(html('[a](https://e.x "say \\"hi\\"")')).not.toMatch(/title="say "/)
    expect(
      html('![a" onload="x](assets/p.png)', {
        imageSrc: () => "panelyth-media://m/" + "1".repeat(32),
      }),
    ).toContain('alt="a&quot; onload=&quot;x"')
  })
})

describe("pictures", () => {
  const token = "panelyth-media://m/" + "2".repeat(32)

  it("uses the resolved token, else a placeholder; never a web URL", () => {
    const src = (link: string): string | null => (link === "assets/a.png" ? token : null)
    expect(html("![A](assets/a.png)", { imageSrc: src })).toBe(
      `<p data-line="1"><img src="${token}" alt="A"></p>`,
    )
    expect(html("![B](missing.png)", { imageSrc: src })).toBe(
      '<p data-line="1"><span class="md-image-placeholder md-image-missing" title="missing.png">B</span></p>',
    )
    let asked = false
    const out = html("![C](https://web.example/c.png)", {
      imageSrc: () => {
        asked = true
        return token
      },
    })
    expect(asked).toBe(false)
    expect(out).toContain("md-image-web")
    expect(out).not.toContain("<img")
  })

  it("lists the local picture links once, in order", () => {
    const text =
      "![a](assets/a.png) ![b](<assets/b c.png>)\n\n![w](http://x/y.png) ![a2](assets/a.png)"
    expect(imageLinks(text, markdownLanguage.parser.parse(text))).toEqual([
      "assets/a.png",
      "assets/b c.png",
    ])
  })
})
