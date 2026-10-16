// Finds every message the apps translate: the string literal that is the first
// argument of t(...) or msg(...). Used by the catalog test and by `pnpm i18n`
// (scripts/i18n.mjs); never part of an app bundle.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const SOURCE_ROOTS = [
  "viewer/renderer/src",
  "commander/renderer/src",
  "system/renderer/src",
  "shared/ui/src",
  "shared/media-ui/src",
  "shared/docviewer/src",
]

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "messages") continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* walk(path)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|\.d\.ts$|fakeApi|fakeBridge/.test(name))
      yield path
  }
}

// t("…") / msg("…") with a plain double-quoted or template literal first argument.
const CALL = /(?<![\w$.])(?:t|msg)\(\s*("(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.|\$(?!\{))*`)/g

function literal(source: string): string {
  if (source.startsWith('"')) return JSON.parse(source) as string
  return source.slice(1, -1).replace(/\\(.)/g, "$1")
}

export interface Found {
  message: string
  files: string[]
}

/** `srcRoot` is the repository's `src` directory. */
export function extractMessages(srcRoot: string): Map<string, Found> {
  const found = new Map<string, Found>()
  for (const root of SOURCE_ROOTS) {
    for (const file of walk(join(srcRoot, root))) {
      const text = readFileSync(file, "utf8")
      for (const m of text.matchAll(CALL)) {
        const message = literal(m[1]!)
        const entry = found.get(message) ?? { message, files: [] }
        const rel = relative(srcRoot, file)
        if (!entry.files.includes(rel)) entry.files.push(rel)
        found.set(message, entry)
      }
    }
  }
  return found
}
