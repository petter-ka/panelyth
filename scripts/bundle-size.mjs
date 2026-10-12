// Records the size of the built renderers (`pnpm build` first), so a stage
// can show that an extraction or a new dependency did not grow a bundle.
//
//   BENCH_STAGE=P01 pnpm bench:bundle
//
// Writes src/shared/bench/results/stage-<id>-<date>-<host>-bundle.json. The
// locale chunks (one per language, loaded on demand) are counted apart from
// the code every start loads.
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, extname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"
import { resultPath } from "./results.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const renderers = {
  viewer: join(root, "src", "viewer", "renderer", "dist", "assets"),
  commander: join(root, "src", "commander", "renderer", "dist", "assets"),
  docviewer: join(root, "src", "shared", "docviewer", "dist", "assets"),
}
// de-BhtZOYnd.js: a message catalog of src/shared/i18n.
const localeChunk = /^[a-z]{2}-[\w-]{8}\.js$/

const outFile = resultPath("bundle")

function measure(dir) {
  if (!existsSync(dir)) throw new Error(`${dir} is missing; run pnpm build first`)
  const files = readdirSync(dir)
    .filter((name) => [".js", ".css"].includes(extname(name)))
    .sort()
    .map((name) => {
      const bytes = readFileSync(join(dir, name))
      return {
        // Without the content hash, so two runs compare by name.
        name: name.replace(/-[\w-]{8}(\.\w+)$/, "$1"),
        kind: extname(name) === ".css" ? "css" : localeChunk.test(name) ? "locale" : "js",
        bytes: bytes.length,
        gzipBytes: gzipSync(bytes).length,
      }
    })
  const total = (kind, field) =>
    files.filter((f) => f.kind === kind).reduce((n, f) => n + f[field], 0)
  return {
    jsBytes: total("js", "bytes"),
    jsGzipBytes: total("js", "gzipBytes"),
    cssBytes: total("css", "bytes"),
    cssGzipBytes: total("css", "gzipBytes"),
    localeBytes: total("locale", "bytes"),
    files,
  }
}

let commit = null
try {
  commit = execFileSync("git", ["describe", "--always", "--dirty"], {
    cwd: root,
    encoding: "utf8",
  }).trim()
} catch {
  // not a git checkout
}

const result = {
  stage: process.env.BENCH_STAGE,
  benchmark: "bundle-size",
  date: new Date().toISOString(),
  commit,
  note: process.env.BENCH_NOTE ?? null,
  renderers: Object.fromEntries(
    Object.entries(renderers).map(([name, dir]) => [name, measure(dir)]),
  ),
}
writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n")

for (const [name, r] of Object.entries(result.renderers)) {
  console.log(
    `${name.padEnd(10)} js ${r.jsBytes} B (gzip ${r.jsGzipBytes})  css ${r.cssBytes} B (gzip ${r.cssGzipBytes})`,
  )
}
console.log(`wrote ${outFile}`)
