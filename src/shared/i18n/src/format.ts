// A small ICU MessageFormat subset (ADR-0034): "{name}" and
// "{count, plural, =0 {none} one {# file} other {# files}}", where # is the
// number. Nothing else: no select, no nesting beyond plural branches.

export type Params = Readonly<Record<string, string | number>>

type Node =
  | string
  | { kind: "arg"; name: string }
  | { kind: "plural"; name: string; branches: Map<string, Node[]> }

/** Index just after the "}" matching the "{" at `open`. */
function closing(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++
    else if (text[i] === "}" && --depth === 0) return i + 1
  }
  throw new Error(`unbalanced braces in message: ${text}`)
}

function parse(text: string): Node[] {
  const nodes: Node[] = []
  let literal = ""
  for (let i = 0; i < text.length;) {
    const ch = text[i]!
    if (ch !== "{") {
      literal += ch
      i++
      continue
    }
    const end = closing(text, i)
    const inner = text.slice(i + 1, end - 1)
    if (literal) nodes.push(literal)
    literal = ""
    const comma = inner.indexOf(",")
    if (comma < 0) {
      nodes.push({ kind: "arg", name: inner.trim() })
    } else {
      const name = inner.slice(0, comma).trim()
      const rest = inner.slice(comma + 1).trim()
      if (!rest.startsWith("plural")) throw new Error(`only plural is supported: ${text}`)
      const branches = new Map<string, Node[]>()
      let body = rest.slice("plural".length).replace(/^\s*,/, "")
      while (body.trim() !== "") {
        const m = /^\s*(=\d+|zero|one|two|few|many|other)\s*\{/.exec(body)
        if (!m) throw new Error(`bad plural branch in message: ${text}`)
        const open = m[0].length - 1
        const stop = closing(body, open)
        branches.set(m[1]!, parse(body.slice(open + 1, stop - 1)))
        body = body.slice(stop)
      }
      if (!branches.has("other")) throw new Error(`plural without "other": ${text}`)
      nodes.push({ kind: "plural", name, branches })
    }
    i = end
  }
  if (literal) nodes.push(literal)
  return nodes
}

const cache = new Map<string, Node[]>()
const parsed = (message: string): Node[] => {
  let nodes = cache.get(message)
  if (!nodes) {
    nodes = message.includes("{") ? parse(message) : [message]
    cache.set(message, nodes)
  }
  return nodes
}

const rules = new Map<string, Intl.PluralRules>()
function category(locale: string, n: number): Intl.LDMLPluralRule {
  let r = rules.get(locale)
  if (!r) {
    r = new Intl.PluralRules(locale)
    rules.set(locale, r)
  }
  return r.select(n)
}

function render(
  nodes: readonly Node[],
  params: Params,
  locale: string,
  hash: string | null,
): string {
  let out = ""
  for (const node of nodes) {
    if (typeof node === "string") {
      out += hash === null ? node : node.replaceAll("#", hash)
    } else if (node.kind === "arg") {
      const v = params[node.name]
      out += v === undefined ? `{${node.name}}` : String(v)
    } else {
      const raw = params[node.name]
      const n = typeof raw === "number" ? raw : Number(raw)
      const branch =
        node.branches.get(`=${n}`) ??
        node.branches.get(category(locale, n)) ??
        node.branches.get("other")!
      out += render(branch, params, locale, new Intl.NumberFormat(locale).format(n))
    }
  }
  return out
}

/** Fills a message's placeholders and plural forms for a locale. */
export function format(message: string, params: Params | undefined, locale: string): string {
  if (!message.includes("{")) return message
  return render(parsed(message), params ?? {}, locale, null)
}

/** The placeholder names a message uses (for the completeness test). */
export function placeholders(message: string): string[] {
  const names = new Set<string>()
  const walk = (nodes: readonly Node[]): void => {
    for (const node of nodes) {
      if (typeof node === "string") continue
      names.add(node.name)
      if (node.kind === "plural") node.branches.forEach(walk)
    }
  }
  walk(parsed(message))
  return [...names].sort()
}

/** The plural categories a message's plurals define, per plural placeholder. */
export function pluralForms(message: string): string[][] {
  const out: string[][] = []
  const walk = (nodes: readonly Node[]): void => {
    for (const node of nodes) {
      if (typeof node !== "string" && node.kind === "plural") {
        out.push([...node.branches.keys()].filter((k) => !k.startsWith("=")).sort())
        node.branches.forEach(walk)
      }
    }
  }
  walk(parsed(message))
  return out
}
