import { syntaxTree } from "@codemirror/language"
import { StateEffect, type EditorState, type Extension, type Range } from "@codemirror/state"
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view"
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common"
import { t } from "@panelyth/i18n"
import { isLocalImageLink, linkTarget } from "./html"
import type { ImageResolver } from "./images"

// The live view (ADR-0046, C10.7): decorations over the @lezer/markdown tree for
// the visible ranges only, rebuilt when the document, the viewport, the tree,
// the cursor's lines or a resolved picture change. The syntax marks hide away
// from the cursor's lines and show on them; the text itself is never changed
// (a task box's click is an ordinary edit of "[ ]").

/** A batch of pictures was resolved: rebuild so their widgets show them. */
export const imagesChanged = StateEffect.define<null>()

export interface LiveOptions {
  resolver: ImageResolver
  /** Ctrl+click on a link: its target is shown (opening it goes through main later). */
  onLink(url: string): void
}

const hidden = Decoration.replace({})
const marks = new Map<string, Decoration>()
const markOf = (cls: string): Decoration => {
  let deco = marks.get(cls)
  if (!deco) marks.set(cls, (deco = Decoration.mark({ class: cls })))
  return deco
}
const lines = new Map<string, Decoration>()
const lineOf = (cls: string): Decoration => {
  let deco = lines.get(cls)
  if (!deco) lines.set(cls, (deco = Decoration.line({ class: cls })))
  return deco
}

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement("span")
    span.className = "cm-md-bullet"
    span.textContent = "•"
    return span
  }
}
const bullet = Decoration.replace({ widget: new BulletWidget() })

class RuleWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement("span")
    span.className = "cm-md-hr"
    span.setAttribute("role", "separator")
    return span
  }
}
const rule = Decoration.replace({ widget: new RuleWidget() })

/** Ticks or clears the box of the task marker "[ ]" / "[x]" that starts at `pos`. */
export function toggleTask(view: EditorView, pos: number): boolean {
  // A read-only document shows its boxes; they do not tick.
  if (view.state.readOnly) return false
  const marker = view.state.sliceDoc(pos, pos + 3)
  if (!/^\[[ xX]\]$/.test(marker)) return false
  view.dispatch({
    changes: { from: pos + 1, to: pos + 2, insert: marker[1] === " " ? "x" : " " },
    userEvent: "input.toggle",
  })
  return true
}

class TaskWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  override eq(other: TaskWidget): boolean {
    return other.checked === this.checked
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("span")
    box.className = this.checked ? "cm-md-task cm-md-task-checked" : "cm-md-task"
    box.setAttribute("role", "checkbox")
    box.setAttribute("aria-checked", String(this.checked))
    box.setAttribute("aria-label", t("Task"))
    box.dataset.testid = "live-task"
    // A click edits the marker's text; the cursor stays where it was.
    box.addEventListener("mousedown", (e) => {
      e.preventDefault()
      toggleTask(view, view.posAtDOM(box))
    })
    return box
  }
}
const tasks = [new TaskWidget(false), new TaskWidget(true)].map((widget) =>
  Decoration.replace({ widget }),
)

type ImageState =
  { kind: "img"; src: string } | { kind: "pending" } | { kind: "missing" } | { kind: "web" }

class ImageWidget extends WidgetType {
  constructor(
    readonly link: string,
    readonly alt: string,
    readonly state: ImageState,
  ) {
    super()
  }
  override eq(other: ImageWidget): boolean {
    return (
      other.link === this.link &&
      other.alt === this.alt &&
      other.state.kind === this.state.kind &&
      (other.state.kind !== "img" ||
        (this.state.kind === "img" && other.state.src === this.state.src))
    )
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("div")
    box.className = "cm-md-image"
    box.dataset.testid = "live-image"
    if (this.state.kind === "img") {
      const img = document.createElement("img")
      img.alt = this.alt
      img.title = this.link
      img.draggable = false
      // A loaded picture changes the line's height: measure again.
      img.addEventListener("load", () => view.requestMeasure())
      img.src = this.state.src
      box.appendChild(img)
      return box
    }
    const note = document.createElement("span")
    note.className = "cm-md-image-placeholder"
    note.textContent =
      this.state.kind === "web"
        ? t("Pictures from the web are not loaded")
        : this.state.kind === "missing"
          ? t("Picture not found")
          : "…"
    note.title = this.link
    box.appendChild(note)
    return box
  }
  override get estimatedHeight(): number {
    return this.state.kind === "img" ? 160 : 24
  }
}

/** The line ranges the cursors and selections are on (1-based, inclusive). */
function activeLines(state: EditorState): [number, number][] {
  return state.selection.ranges.map((r) => [
    state.doc.lineAt(r.from).number,
    state.doc.lineAt(r.to).number,
  ])
}

const sameLines = (a: [number, number][], b: [number, number][]): boolean =>
  a.length === b.length && a.every((r, i) => r[0] === b[i]![0] && r[1] === b[i]![1])

function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = []
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c)
  return out
}

interface Built {
  decorations: DecorationSet
  wanted: string[]
}

function build(view: EditorView, active: [number, number][], resolver: ImageResolver): Built {
  const { state } = view
  const { doc } = state
  const decos: Range<Decoration>[] = []
  const wanted: string[] = []
  const tree = syntaxTree(state)
  const isActive = (pos: number): boolean => {
    const n = doc.lineAt(pos).number
    return active.some(([a, b]) => n >= a && n <= b)
  }
  const hide = (from: number, to: number): void => {
    if (to > from) decos.push(hidden.range(from, to))
  }
  /** A mark and the spaces after it ("# ", "> "). */
  const hideWithSpace = (from: number, to: number): void => {
    let end = to
    while (end < doc.length && doc.sliceString(end, end + 1) === " ") end++
    hide(from, end)
  }
  const styleLines = (from: number, to: number, cls: string, vFrom: number, vTo: number): void => {
    const first = doc.lineAt(Math.max(from, vFrom))
    const last = doc.lineAt(Math.min(to, vTo))
    for (let n = first.number; n <= last.number; n++) {
      decos.push(lineOf(cls).range(doc.line(n).from))
    }
  }

  for (const { from: vFrom, to: vTo } of view.visibleRanges) {
    tree.iterate({
      from: vFrom,
      to: vTo,
      enter: (ref: SyntaxNodeRef) => {
        const { name, from, to } = ref
        const heading = /^(ATX|Setext)Heading(\d)$/.exec(name)
        if (heading) {
          const level = heading[2]
          if (heading[1] === "ATX") {
            decos.push(lineOf(`cm-md-h cm-md-h${level}`).range(doc.lineAt(from).from))
          } else {
            const underline = doc.lineAt(to)
            styleLines(from, underline.from - 1, `cm-md-h cm-md-h${level}`, vFrom, vTo)
            decos.push(lineOf("cm-md-setext").range(underline.from))
          }
          return
        }
        switch (name) {
          case "HeaderMark": {
            if (ref.node.parent?.name.startsWith("Setext") || isActive(from)) return
            // An opening "# " or a closing " ##".
            if (
              doc.lineAt(from).from === from ||
              /^\s*$/.test(doc.sliceString(doc.lineAt(from).from, from))
            )
              hideWithSpace(from, to)
            else {
              let start = from
              while (start > 0 && doc.sliceString(start - 1, start) === " ") start--
              hide(start, to)
            }
            return
          }
          case "Emphasis":
            decos.push(markOf("cm-md-em").range(from, to))
            return
          case "StrongEmphasis":
            decos.push(markOf("cm-md-strong").range(from, to))
            return
          case "Strikethrough":
            decos.push(markOf("cm-md-strike").range(from, to))
            return
          case "InlineCode":
            decos.push(markOf("cm-md-code").range(from, to))
            return
          case "EmphasisMark":
          case "StrikethroughMark":
          case "CodeMark":
            if (!isActive(from)) hide(from, to)
            return
          case "FencedCode":
          case "CodeBlock": {
            const first = doc.lineAt(from).number
            const last = doc.lineAt(to).number
            const vFirst = doc.lineAt(Math.max(from, vFrom)).number
            const vLast = doc.lineAt(Math.min(to, vTo)).number
            for (let n = vFirst; n <= vLast; n++) {
              let cls = "cm-md-codeblock"
              if (n === first) cls += " cm-md-codeblock-first"
              if (n === last) cls += " cm-md-codeblock-last"
              if (
                name === "FencedCode" &&
                (n === first || n === last) &&
                !isActive(doc.line(n).from)
              )
                cls += " cm-md-fence"
              decos.push(lineOf(cls).range(doc.line(n).from))
            }
            return false
          }
          case "Blockquote":
            styleLines(from, to, "cm-md-quote", vFrom, vTo)
            return
          case "QuoteMark":
            if (!isActive(from)) hideWithSpace(from, to)
            return
          case "ListMark": {
            const item = ref.node.parent
            const isTask = item?.getChild("Task") !== null && item?.getChild("Task") !== undefined
            if (isActive(from)) {
              decos.push(markOf("cm-md-listmark").range(from, to))
            } else if (isTask) {
              hideWithSpace(from, to)
            } else if (item?.parent?.name === "BulletList") {
              decos.push(bullet.range(from, to))
            } else {
              decos.push(markOf("cm-md-listmark").range(from, to))
            }
            return
          }
          case "TaskMarker": {
            if (isActive(from)) {
              decos.push(markOf("cm-md-taskmark").range(from, to))
            } else {
              const checked = /x/i.test(doc.sliceString(from, to))
              decos.push(tasks[checked ? 1 : 0]!.range(from, to))
            }
            return
          }
          case "Link":
          case "Image": {
            const node = ref.node
            const kids = children(node)
            const open = kids[0]
            const close = kids.find(
              (c) => c !== open && c.name === "LinkMark" && c.to - c.from === 1,
            )
            const url = kids.find((c) => c.name === "URL")
            const target = url ? linkTarget(doc.sliceString(url.from, url.to)) : ""
            const labelFrom = open ? open.to : from
            const labelTo = close ? close.from : to
            if (labelTo > labelFrom) {
              decos.push(
                Decoration.mark({
                  class: name === "Link" ? "cm-md-link" : "cm-md-image-alt",
                  attributes: target ? { title: target, "data-md-url": target } : {},
                }).range(labelFrom, labelTo),
              )
            }
            if (!isActive(from) && !isActive(to) && open && close) {
              hide(open.from, open.to)
              hide(close.from, to)
            }
            if (name === "Image") {
              const alt = doc.sliceString(labelFrom, labelTo)
              let widgetState: ImageState
              if (!isLocalImageLink(target)) widgetState = { kind: "web" }
              else {
                const src = resolver.get(target)
                if (src === undefined) {
                  wanted.push(target)
                  widgetState = { kind: "pending" }
                } else widgetState = src === null ? { kind: "missing" } : { kind: "img", src }
              }
              decos.push(
                Decoration.widget({
                  widget: new ImageWidget(target, alt, widgetState),
                  side: 1,
                }).range(doc.lineAt(to).to),
              )
              return false
            }
            return
          }
          case "Autolink": {
            const url = ref.node.getChild("URL")
            if (url) {
              const target = doc.sliceString(url.from, url.to)
              decos.push(
                Decoration.mark({
                  class: "cm-md-link",
                  attributes: { title: target, "data-md-url": target },
                }).range(url.from, url.to),
              )
            }
            if (!isActive(from) && url) {
              hide(from, url.from)
              hide(url.to, to)
            }
            return false
          }
          case "URL": {
            const parent = ref.node.parent?.name
            if (parent === "Link" || parent === "Image" || parent === "LinkReference") return
            const target = doc.sliceString(from, to)
            decos.push(
              Decoration.mark({
                class: "cm-md-link",
                attributes: { title: target, "data-md-url": target },
              }).range(from, to),
            )
            return
          }
          case "HorizontalRule":
            if (isActive(from)) decos.push(markOf("cm-md-muted").range(from, to))
            else decos.push(rule.range(from, to))
            return
          case "Table": {
            styleLines(from, to, "cm-md-table", vFrom, vTo)
            return
          }
          case "TableHeader":
            decos.push(lineOf("cm-md-table-head").range(doc.lineAt(from).from))
            return
          case "TableDelimiter":
            if (ref.node.parent?.name === "Table") {
              decos.push(lineOf("cm-md-table-delim").range(doc.lineAt(from).from))
            } else {
              decos.push(markOf("cm-md-pipe").range(from, to))
            }
            return
          case "Escape":
            if (!isActive(from)) hide(from, from + 1)
            return
          case "HTMLTag":
          case "HTMLBlock":
          case "Comment":
          case "CommentBlock":
          case "LinkReference":
            decos.push(markOf("cm-md-muted").range(from, to))
            return false
          default:
            return
        }
      },
    })
  }
  return { decorations: Decoration.set(decos, true), wanted }
}

const liveTheme = EditorView.theme({
  "&.cm-md-live .cm-content": {
    fontFamily: "Inter, system-ui, sans-serif",
    maxWidth: "52rem",
    margin: "0 auto",
    padding: "16px 0 40vh",
  },
  "&.cm-md-live .cm-line": { padding: "0 24px", lineHeight: "1.65" },
  // A page, not code: Source's syntax colours step back; the cm-md-* styles below set the look.
  "&.cm-md-live .cm-line span:not([class*=cm-md])": {
    color: "inherit",
    textDecoration: "none",
  },
  ".cm-md-h": { fontWeight: "700", lineHeight: "1.3" },
  ".cm-md-h1": { fontSize: "1.8em", paddingTop: "0.4em" },
  ".cm-md-h2": { fontSize: "1.45em", paddingTop: "0.3em" },
  ".cm-md-h3": { fontSize: "1.25em" },
  ".cm-md-h4": { fontSize: "1.1em" },
  ".cm-md-h6": { color: "var(--muted)" },
  ".cm-md-setext": { color: "var(--muted)", fontSize: "0.8em" },
  ".cm-md-em": { fontStyle: "italic" },
  ".cm-md-strong": { fontWeight: "700" },
  ".cm-md-strike": { textDecoration: "line-through" },
  ".cm-md-code": {
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    fontSize: "0.88em",
    backgroundColor: "var(--raised)",
    borderRadius: "4px",
    padding: "1px 3px",
  },
  ".cm-md-codeblock": {
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    fontSize: "0.88em",
    backgroundColor: "var(--raised)",
  },
  ".cm-md-codeblock span": { color: "inherit", fontStyle: "inherit" },
  ".cm-md-codeblock-first": { borderTopLeftRadius: "6px", borderTopRightRadius: "6px" },
  ".cm-md-codeblock-last": { borderBottomLeftRadius: "6px", borderBottomRightRadius: "6px" },
  ".cm-md-fence, .cm-md-fence span": { color: "var(--muted)" },
  ".cm-md-quote": {
    borderLeft: "3px solid var(--border)",
    color: "var(--muted)",
  },
  "&.cm-md-live .cm-md-quote": { paddingLeft: "16px" },
  ".cm-md-link": { color: "var(--accent)", textDecoration: "underline" },
  ".cm-md-link span": { color: "inherit" },
  ".cm-md-image-alt": { color: "var(--muted)", fontSize: "0.9em" },
  ".cm-md-bullet, .cm-md-listmark, .cm-md-taskmark": { color: "var(--muted)" },
  ".cm-md-task": {
    display: "inline-block",
    width: "0.95em",
    height: "0.95em",
    marginRight: "0.4em",
    verticalAlign: "-0.1em",
    border: "1.5px solid var(--muted)",
    borderRadius: "3px",
    cursor: "pointer",
  },
  ".cm-md-task-checked": {
    backgroundColor: "var(--accent)",
    borderColor: "var(--accent)",
    boxShadow: "inset 0 0 0 2px var(--canvas)",
  },
  ".cm-md-hr": {
    display: "inline-block",
    width: "100%",
    verticalAlign: "middle",
    borderTop: "1px solid var(--border)",
  },
  ".cm-md-table": { fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: "0.9em" },
  ".cm-md-table-head": { fontWeight: "600" },
  ".cm-md-table-delim, .cm-md-table-delim span, .cm-md-pipe": { color: "var(--muted)" },
  ".cm-md-muted, .cm-md-muted span": { color: "var(--muted)" },
  ".cm-md-image": { display: "block", padding: "4px 0" },
  ".cm-md-image img": {
    display: "block",
    maxWidth: "100%",
    maxHeight: "480px",
    borderRadius: "4px",
  },
  ".cm-md-image-placeholder": {
    display: "inline-block",
    padding: "2px 8px",
    border: "1px dashed var(--border)",
    borderRadius: "4px",
    color: "var(--muted)",
    fontSize: "0.85em",
  },
})

function livePlugin(options: LiveOptions) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      active: [number, number][]
      off: () => void
      constructor(readonly view: EditorView) {
        this.active = activeLines(view.state)
        this.decorations = this.rebuild()
        this.off = options.resolver.onChange(() => {
          // After this update cycle: a resolve may answer from a microtask during one.
          queueMicrotask(() => view.dispatch({ effects: imagesChanged.of(null) }))
        })
      }
      rebuild(): DecorationSet {
        const { decorations, wanted } = build(this.view, this.active, options.resolver)
        if (wanted.length > 0) options.resolver.request(wanted)
        return decorations
      }
      update(update: ViewUpdate): void {
        const active = activeLines(update.state)
        const activeChanged = !sameLines(active, this.active)
        this.active = active
        if (
          update.docChanged ||
          update.viewportChanged ||
          activeChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state) ||
          update.transactions.some((tr) => tr.effects.some((e) => e.is(imagesChanged)))
        ) {
          this.decorations = this.rebuild()
        }
      }
      destroy(): void {
        this.off()
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      eventHandlers: {
        mousedown(e) {
          if (!(e.ctrlKey || e.metaKey) || !(e.target instanceof Element)) return false
          const link = e.target.closest("[data-md-url]")
          const url = link?.getAttribute("data-md-url")
          if (!url) return false
          e.preventDefault()
          options.onLink(url)
          return true
        },
      },
    },
  )
}

/** The live view's parts: the decorations, their look, wrapped lines in a page's width. */
export function liveMarkdown(options: LiveOptions): Extension {
  return [
    livePlugin(options),
    liveTheme,
    EditorView.editorAttributes.of({ class: "cm-md-live" }),
    EditorView.lineWrapping,
  ]
}
