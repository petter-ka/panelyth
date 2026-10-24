import type { SyntaxNode, Tree } from "@lezer/common"

// Markdown → HTML from the @lezer/markdown tree the editor already has (ADR-0046):
// no second Markdown parser. CommonMark plus GFM tables, task lists and
// strikethrough. HTML in the source is shown as text, never passed through.
// Pure: no DOM, so the PDF export (C10.8) prints exactly this. The output is
// still cleaned by DOMPurify before it reaches a page (markdown/preview.ts).

export interface HtmlOptions {
  /**
   * The <img> src of a linked picture (a read-only token), or null for a
   * placeholder. Pictures from the web (any URL with a scheme) are never
   * asked about: they are placeholders.
   */
  imageSrc?(link: string): string | null
}

/** One top-level block: its first source line (1-based) and its HTML (with data-line). */
export interface HtmlBlock {
  line: number
  html: string
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c]!)

const SCHEME = /^([a-z][a-z0-9+.-]*):/i

/** A link target as written, without <angle brackets>. */
export function linkTarget(url: string): string {
  const trimmed = url.trim()
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed
}

/**
 * A link's href, or null when it may not be one: http, https and mailto, or a
 * relative target. Control characters and whitespace are dropped before the
 * scheme is read, as browsers do ("java\tscript:" is javascript:).
 */
export function safeHref(url: string): string | null {
  const target = linkTarget(url)
  // eslint-disable-next-line no-control-regex
  const compact = target.replace(/[\u0000- \u007f]/g, "")
  if (compact === "") return null
  const scheme = SCHEME.exec(compact)?.[1]?.toLowerCase()
  if (scheme === undefined) return compact.startsWith("//") ? null : target
  return scheme === "http" || scheme === "https" || scheme === "mailto" ? target : null
}

/** A picture link the sidecar may resolve: relative, inside the document's tree. */
export function isLocalImageLink(url: string): boolean {
  const target = linkTarget(url)
  return target !== "" && !SCHEME.test(target) && !target.startsWith("//")
}

const ENTITY = /^&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});$/i

interface Context {
  text: string
  refs: Map<string, { url: string; title: string | null }>
  options: HtmlOptions
}

const normalizeLabel = (label: string): string => label.trim().replace(/\s+/g, " ").toLowerCase()

function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) out.push(child)
  return out
}

/** Text without its marks: the alt of a picture, a link's plain label. */
function plainText(ctx: Context, node: SyntaxNode, from: number, to: number): string {
  let out = ""
  let at = from
  for (const child of children(node)) {
    if (child.to <= from || child.from >= to) continue
    out += ctx.text.slice(at, Math.max(at, child.from))
    if (!/Mark$/.test(child.name) && child.name !== "URL" && child.name !== "LinkTitle")
      out += plainText(ctx, child, child.from, child.to)
    at = Math.max(at, child.to)
  }
  return out + ctx.text.slice(at, to)
}

/** A link title without its quotes or parentheses. */
function titleText(text: string, node: SyntaxNode | null | undefined): string | null {
  if (!node) return null
  const raw = text.slice(node.from, node.to)
  return raw.length >= 2 ? raw.slice(1, -1) : null
}
const titleOf = (ctx: Context, node: SyntaxNode | undefined): string | null =>
  titleText(ctx.text, node)

/** A link's or picture's target: inline (URL, LinkTitle) or by reference (LinkLabel). */
function targetOf(
  ctx: Context,
  node: SyntaxNode,
  labelText: string,
): { url: string; title: string | null } | null {
  const kids = children(node)
  const url = kids.find((c) => c.name === "URL")
  if (url) {
    return {
      url: ctx.text.slice(url.from, url.to),
      title: titleOf(
        ctx,
        kids.find((c) => c.name === "LinkTitle"),
      ),
    }
  }
  const label = kids.find((c) => c.name === "LinkLabel")
  const key = normalizeLabel(
    label ? ctx.text.slice(label.from + 1, label.to - 1) || labelText : labelText,
  )
  return ctx.refs.get(key) ?? null
}

/** Where a link's or picture's label ends: the first "]" mark. */
function labelRange(node: SyntaxNode): [number, number] {
  const kids = children(node)
  const open = kids[0]
  const close = kids.find((c) => c.name === "LinkMark" && c !== open && c.to - c.from === 1)
  return [open ? open.to : node.from, close ? close.from : node.to]
}

/** Inline content of [from, to) inside `node`; marks are left out. */
function inline(ctx: Context, node: SyntaxNode, from = node.from, to = node.to): string {
  let out = ""
  let at = from
  for (const child of children(node)) {
    if (child.to <= from || child.from >= to) continue
    if (child.from > at) out += textRun(ctx.text.slice(at, child.from))
    out += inlineNode(ctx, child)
    at = Math.max(at, child.to)
    // A continuation line's "> " inside a quoted paragraph: the space goes with the mark.
    if (child.name === "QuoteMark") while (ctx.text.charCodeAt(at) === 32 && at < to) at++
  }
  if (at < to) out += textRun(ctx.text.slice(at, to))
  return out
}

/** Plain text between inline nodes: escaped; line indentation dropped. */
const textRun = (text: string): string => escapeHtml(text.replace(/\n[ \t]+/g, "\n"))

function inlineNode(ctx: Context, node: SyntaxNode): string {
  const raw = (): string => ctx.text.slice(node.from, node.to)
  switch (node.name) {
    case "Emphasis":
      return `<em>${inline(ctx, node)}</em>`
    case "StrongEmphasis":
      return `<strong>${inline(ctx, node)}</strong>`
    case "Strikethrough":
      return `<del>${inline(ctx, node)}</del>`
    case "Subscript":
      return `<sub>${inline(ctx, node)}</sub>`
    case "Superscript":
      return `<sup>${inline(ctx, node)}</sup>`
    case "InlineCode": {
      const kids = children(node)
      const start = kids[0]?.to ?? node.from
      const end = kids.length > 1 ? kids[kids.length - 1]!.from : node.to
      let code = ctx.text.slice(start, end).replace(/\n/g, " ")
      if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1)
      return `<code>${escapeHtml(code)}</code>`
    }
    case "Link": {
      const [from, to] = labelRange(node)
      const target = targetOf(ctx, node, ctx.text.slice(from, to))
      const content = inline(ctx, node, from, to)
      if (!target) return escapeHtml(raw())
      const href = safeHref(target.url)
      const title = escapeHtml(target.title ?? linkTarget(target.url))
      if (href === null) return `<span class="md-link-blocked" title="${title}">${content}</span>`
      return `<a href="${escapeHtml(href)}" title="${title}">${content}</a>`
    }
    case "Image": {
      const [from, to] = labelRange(node)
      const alt = plainText(ctx, node, from, to)
      const target = targetOf(ctx, node, ctx.text.slice(from, to))
      if (!target) return escapeHtml(raw())
      const link = linkTarget(target.url)
      const src = isLocalImageLink(link) ? (ctx.options.imageSrc?.(link) ?? null) : null
      const title = target.title === null ? "" : ` title="${escapeHtml(target.title)}"`
      if (src === null) {
        const kind = isLocalImageLink(link) ? "md-image-missing" : "md-image-web"
        return `<span class="md-image-placeholder ${kind}" title="${escapeHtml(link)}">${escapeHtml(alt)}</span>`
      }
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${title}>`
    }
    case "Autolink": {
      const url = children(node).find((c) => c.name === "URL")
      const target = url ? ctx.text.slice(url.from, url.to) : raw().slice(1, -1)
      const isMail = !SCHEME.test(target) && target.includes("@")
      const href = safeHref(isMail ? `mailto:${target}` : target)
      if (href === null) return escapeHtml(raw())
      return `<a href="${escapeHtml(href)}" title="${escapeHtml(target)}">${escapeHtml(target)}</a>`
    }
    case "URL": {
      // A bare GFM autolink (www.example.com, https://…, someone@example.com).
      const target = raw()
      const withScheme = SCHEME.test(target)
        ? target
        : target.includes("@") && !target.startsWith("www.")
          ? `mailto:${target}`
          : `http://${target}`
      const href = safeHref(withScheme)
      if (href === null) return escapeHtml(target)
      return `<a href="${escapeHtml(href)}" title="${escapeHtml(target)}">${escapeHtml(target)}</a>`
    }
    case "Escape":
      return escapeHtml(raw().slice(1))
    case "Entity":
      return ENTITY.test(raw()) ? raw() : escapeHtml(raw())
    case "HardBreak":
      return "<br>"
    case "TaskMarker":
      return ""
    default:
      // Syntax marks (EmphasisMark, StrikethroughMark, QuoteMark…) are not content.
      if (node.name.endsWith("Mark")) return ""
      // HTMLTag, Comment, ProcessingInstruction and anything unknown: as text.
      return node.firstChild ? inline(ctx, node) : escapeHtml(raw())
  }
}

const attr = (dataLine: number | null): string =>
  dataLine === null ? "" : ` data-line="${dataLine}"`

/** A list is loose when a blank line separates its items or the blocks inside one. */
function isLoose(ctx: Context, list: SyntaxNode): boolean {
  const items = children(list)
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    const blocks = children(item).filter((c) => c.name !== "ListMark" && c.name !== "TaskMarker")
    for (let j = 1; j < blocks.length; j++) {
      if (/\n[ \t>]*\n/.test(ctx.text.slice(blocks[j - 1]!.to, blocks[j]!.from))) return true
    }
    const next = items[i + 1]
    if (next && /\n[ \t>]*\n/.test(ctx.text.slice(item.to, next.from))) return true
    if (next && /\n[ \t>]*\n\s*$/.test(ctx.text.slice(item.from, item.to))) return true
  }
  return false
}

function codeText(ctx: Context, node: SyntaxNode): string {
  const parts = children(node).filter((c) => c.name === "CodeText")
  if (parts.length === 0) return ""
  const from = parts[0]!.from
  const to = parts[parts.length - 1]!.to
  // Inside a block quote, the quote marks of the code's lines are not code.
  const marks: SyntaxNode[] = []
  const cursor = node.cursor()
  if (cursor.firstChild()) {
    do {
      if (cursor.name === "QuoteMark" && cursor.from >= from && cursor.to <= to)
        marks.push(cursor.node)
    } while (cursor.next() && cursor.from < node.to)
  }
  let out = ""
  let at = from
  for (const mark of marks) {
    out += ctx.text.slice(at, mark.from)
    at = ctx.text.charCodeAt(mark.to) === 32 ? mark.to + 1 : mark.to
  }
  return out + ctx.text.slice(at, to)
}

function alignments(ctx: Context, delimiter: SyntaxNode | undefined): string[] {
  if (!delimiter) return []
  return ctx.text
    .slice(delimiter.from, delimiter.to)
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => {
      const c = cell.trim()
      const left = c.startsWith(":")
      const right = c.endsWith(":")
      return left && right ? "center" : right ? "right" : left ? "left" : ""
    })
}

function tableRow(ctx: Context, row: SyntaxNode, tag: "th" | "td", aligns: string[]): string {
  const cells = children(row).filter((c) => c.name === "TableCell")
  // The alignment row sets the columns: short rows are padded, long ones cut.
  const columns = aligns.length || cells.length
  let out = "<tr>"
  for (let i = 0; i < columns; i++) {
    const cell = cells[i]
    const align = aligns[i] ? ` class="align-${aligns[i]}"` : ""
    out += `<${tag}${align}>${cell ? inline(ctx, cell).trim() : ""}</${tag}>`
  }
  return out + "</tr>"
}

function block(ctx: Context, node: SyntaxNode, dataLine: number | null, tight = false): string {
  const a = attr(dataLine)
  const name = node.name
  const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name)
  if (heading) {
    const level = heading[1]
    return `<h${level}${a}>${inline(ctx, node).trim()}</h${level}>`
  }
  switch (name) {
    case "Paragraph": {
      const content = inline(ctx, node).trim()
      return tight ? content : `<p${a}>${content}</p>`
    }
    case "Blockquote":
      return `<blockquote${a}>${blocks(ctx, node)}</blockquote>`
    case "BulletList":
    case "OrderedList": {
      const loose = isLoose(ctx, node)
      const tag = name === "BulletList" ? "ul" : "ol"
      let start = ""
      if (tag === "ol") {
        const mark = node.firstChild?.firstChild
        const n = mark ? parseInt(ctx.text.slice(mark.from, mark.to), 10) : 1
        if (Number.isFinite(n) && n !== 1) start = ` start="${n}"`
      }
      const items = children(node)
        .map((item) => listItem(ctx, item, !loose))
        .join("")
      return `<${tag}${a}${start}>${items}</${tag}>`
    }
    case "HorizontalRule":
      return `<hr${a}>`
    case "FencedCode": {
      const info = children(node).find((c) => c.name === "CodeInfo")
      const language = info ? ctx.text.slice(info.from, info.to).trim().split(/\s+/)[0] : ""
      const cls =
        language && /^[\w+#.-]{1,32}$/.test(language) ? ` class="language-${language}"` : ""
      return `<pre${a}><code${cls}>${escapeHtml(codeText(ctx, node))}</code></pre>`
    }
    case "CodeBlock": {
      const code = codeText(ctx, node).replace(/\n {1,4}/g, "\n")
      return `<pre${a}><code>${escapeHtml(code)}</code></pre>`
    }
    case "Table": {
      const kids = children(node)
      const header = kids.find((c) => c.name === "TableHeader")
      const aligns = alignments(
        ctx,
        kids.find((c) => c.name === "TableDelimiter"),
      )
      const rows = kids.filter((c) => c.name === "TableRow")
      const head = header ? `<thead>${tableRow(ctx, header, "th", aligns)}</thead>` : ""
      const body = rows.length
        ? `<tbody>${rows.map((r) => tableRow(ctx, r, "td", aligns)).join("")}</tbody>`
        : ""
      return `<table${a}>${head}${body}</table>`
    }
    case "LinkReference":
      return ""
    case "HTMLBlock":
    case "CommentBlock":
    case "ProcessingInstructionBlock":
      // Raw HTML is shown as written, never rendered (ADR-0046).
      return `<pre class="md-html"${a}>${escapeHtml(ctx.text.slice(node.from, node.to))}</pre>`
    default:
      return node.firstChild
        ? `<div${a}>${blocks(ctx, node)}</div>`
        : `<p${a}>${escapeHtml(ctx.text.slice(node.from, node.to))}</p>`
  }
}

function listItem(ctx: Context, item: SyntaxNode, tight: boolean): string {
  let out = ""
  let task = ""
  for (const child of children(item)) {
    if (child.name === "ListMark") continue
    if (child.name === "Task") {
      const marker = child.firstChild
      const checked = marker ? /x/i.test(ctx.text.slice(marker.from, marker.to)) : false
      task = ' class="task"'
      const box = `<input type="checkbox" disabled${checked ? " checked" : ""}> `
      const content = inline(ctx, child, marker ? marker.to : child.from).trim()
      out += tight ? box + content : `<p>${box}${content}</p>`
      continue
    }
    out += block(ctx, child, null, tight)
  }
  return `<li${task}>${out}</li>`
}

function blocks(ctx: Context, node: SyntaxNode): string {
  return children(node)
    .filter((c) => c.name !== "QuoteMark")
    .map((c) => block(ctx, c, null))
    .join("")
}

function referencesOf(text: string, tree: Tree): Context["refs"] {
  const refs: Context["refs"] = new Map()
  tree.iterate({
    enter(node) {
      // Definitions are blocks: inline content holds none.
      if (node.name === "Paragraph" || /Heading|Code|Table/.test(node.name)) return false
      if (node.name !== "LinkReference") return
      const n = node.node
      const label = n.getChild("LinkLabel")
      const url = n.getChild("URL")
      if (label && url) {
        const key = normalizeLabel(text.slice(label.from + 1, label.to - 1))
        if (!refs.has(key)) {
          refs.set(key, {
            url: text.slice(url.from, url.to),
            title: titleText(text, n.getChild("LinkTitle")),
          })
        }
      }
      return false
    },
  })
  return refs
}

/**
 * The document's top-level blocks as HTML, each with the source line it
 * starts on (data-line on its first element), in order. Long documents are
 * shown block group by block group (markdown/preview.ts).
 */
export function renderBlocks(text: string, tree: Tree, options: HtmlOptions = {}): HtmlBlock[] {
  return [...htmlBlocks(text, tree, options)]
}

/**
 * The same blocks one at a time, so a long document can be rendered in slices
 * (the PDF export's print view) without holding the main thread.
 */
export function* htmlBlocks(
  text: string,
  tree: Tree,
  options: HtmlOptions = {},
): Generator<HtmlBlock, void, undefined> {
  const ctx: Context = { text, refs: referencesOf(text, tree), options }
  let line = 1
  let at = 0
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    for (let i = text.indexOf("\n", at); i >= 0 && i < node.from; i = text.indexOf("\n", i + 1))
      line++
    at = node.from
    const html = block(ctx, node, line)
    if (html !== "") yield { line, html }
  }
}

/** The whole document as one HTML string (tests, the PDF export). */
export function renderHtml(text: string, tree: Tree, options: HtmlOptions = {}): string {
  return renderBlocks(text, tree, options)
    .map((b) => b.html)
    .join("\n")
}

/** The local picture links of a document, each once, in order (for one batched resolve). */
export function imageLinks(text: string, tree: Tree, from = 0, to = text.length): string[] {
  const links = new Set<string>()
  tree.iterate({
    from,
    to,
    enter(node) {
      if (node.name !== "Image") return
      const url = node.node.getChild("URL")
      if (url) {
        const link = linkTarget(text.slice(url.from, url.to))
        if (isLocalImageLink(link)) links.add(link)
      }
      return false
    },
  })
  return [...links]
}
