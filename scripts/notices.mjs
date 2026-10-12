// Writes the product's one licence notice file (Stage P06):
// src/shared/desktop/build/THIRD-PARTY-NOTICES.txt, shipped in every package
// and opened from Help → Third-Party Licenses.
//
// What it lists is found, not kept by hand:
//  - npm packages bundled into the renderers: the `dependencies` of the
//    viewer, the commander and the document window, followed to the end;
//  - npm packages bundled into Electron main and the preloads: the modules
//    their source maps name (so `pnpm build` runs first);
//  - Go modules linked into the sidecar (`go list -deps`), and Go itself;
//  - what no tool can find, from src/shared/desktop/build/third-party.json:
//    Electron and Chromium, fonts, icon sets and the ffmpeg build beside the
//    sidecar when scripts/media-tools.mjs fetched one.
//
// It fails when a component has no licence text or a licence the product does
// not ship (docs/RELEASING.md "Licences"): `node scripts/notices.mjs --check`
// does only that and writes nothing.
import { execFileSync } from "node:child_process"
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { goBinary } from "./go.mjs"
import { productVersion } from "./version.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const desktop = join(root, "src", "shared", "desktop")
const OUT = join(desktop, "build", "THIRD-PARTY-NOTICES.txt")

/** Licences the product ships. A copyleft licence is allowed only for a named component. */
const ALLOWED = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "OFL-1.1",
  "Unlicense",
])
/** Separate programs beside the sidecar, never linked into the product (ADR-0018). */
const ALLOWED_FOR = { FFmpeg: new Set(["LGPL-2.1-or-later", "LGPL-3.0-or-later"]) }

const LICENCE_FILE = /^(licen[cs]e|copying|notice|patents)([-_.].*)?$/i

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"))

/** Licence files in a folder (not below it), as name → text. */
function licenceTexts(dir, prefix = "") {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => LICENCE_FILE.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ file: prefix + name, text: readFileSync(join(dir, name), "utf8").trim() }))
}

/** Node's resolution, by hand: pnpm links a package's dependencies beside it. */
function findPackage(fromDir, name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name)
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate)
    if (dirname(dir) === dir) return null
  }
}

const spdx = (pkg) =>
  typeof pkg.license === "string"
    ? pkg.license
    : (pkg.license?.type ?? (pkg.licenses ?? []).map((l) => l.type).join(" OR "))

const repository = (pkg) => {
  const url = typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? "")
  return (url || pkg.homepage || `https://www.npmjs.com/package/${pkg.name}`)
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
}

/** The MIT licence, for a package that declares it and ships no text of it. */
const MIT_TEXT = [
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  'of this software and associated documentation files (the "Software"), to deal',
  "in the Software without restriction, including without limitation the rights",
  "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
  "copies of the Software, and to permit persons to whom the Software is",
  "furnished to do so, subject to the following conditions:",
  "",
  "The above copyright notice and this permission notice shall be included in all",
  "copies or substantial portions of the Software.",
  "",
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
  "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
  "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
  "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
  "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
  "SOFTWARE.",
].join("\n")

const author = (pkg) =>
  typeof pkg.author === "string" ? pkg.author : (pkg.author?.name ?? `the ${pkg.name} authors`)

function npmComponent(dir) {
  const pkg = readJson(join(dir, "package.json"))
  // Data folders with licences of their own (pdf.js ships fonts and decoders that way).
  const nested = readdirSync(dir)
    .filter((name) => name !== "node_modules" && statSync(join(dir, name)).isDirectory())
    .flatMap((name) => licenceTexts(join(dir, name), `${name}/`))
  const texts = [...licenceTexts(dir), ...nested]
  // A few packages declare MIT in package.json and ship no copy of it.
  if (texts.length === 0 && spdx(pkg) === "MIT") {
    texts.push({
      file: 'package.json ("license": "MIT")',
      text: `Copyright (c) ${author(pkg)}\n\n${MIT_TEXT}`,
    })
  }
  return {
    name: pkg.name,
    version: pkg.version,
    licence: spdx(pkg),
    source: repository(pkg),
    texts,
  }
}

/**
 * The packages a renderer bundles: its dependencies, and theirs. Workspace
 * packages are ours. Optional dependencies are left out: they are native
 * add-ons for Node (pdf.js's canvas), which a browser bundle cannot hold.
 */
function rendererPackages(appDir, seen) {
  const visit = (dir) => {
    const pkg = readJson(join(dir, "package.json"))
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      // Listed under both by some packages: optional wins, as in npm.
      if (pkg.optionalDependencies?.[name]) continue
      const found = findPackage(dir, name)
      if (!found) {
        throw new Error(`${name}, a dependency of ${pkg.name}, is not installed (pnpm install)`)
      }
      if (seen.has(found)) continue
      seen.add(found)
      visit(found)
    }
  }
  visit(appDir)
}

/** The packages a bundle of main or a preload was built from, read from its source map. */
function bundledPackages(distDir, seen) {
  const maps = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name.endsWith(".map")) maps.push(path)
    }
  }
  if (!existsSync(distDir)) throw new Error(`${relative(root, distDir)} is missing: run pnpm build`)
  walk(distDir)
  if (maps.length === 0) throw new Error(`no source maps under ${relative(root, distDir)}`)
  for (const map of maps) {
    for (const source of readJson(map).sources ?? []) {
      const path = join(dirname(map), source)
      const parts = path.split(sep)
      const at = parts.lastIndexOf("node_modules")
      if (at < 0) continue
      const scoped = parts[at + 1]?.startsWith("@")
      const dir = parts.slice(0, at + (scoped ? 3 : 2)).join(sep)
      if (existsSync(join(dir, "package.json"))) seen.add(realpathSync(dir))
    }
  }
}

/** Go modules linked into the sidecar on any of the three OSes. */
function goComponents() {
  const sidecar = join(root, "src", "shared", "sidecar")
  const modules = new Map()
  for (const goos of ["windows", "darwin", "linux"]) {
    const out = execFileSync(
      goBinary(),
      [
        "list",
        "-deps",
        "-f",
        "{{with .Module}}{{if not .Main}}{{.Path}}\t{{.Version}}\t{{.Dir}}{{end}}{{end}}",
        "./cmd/panelyth-sidecar",
      ],
      { cwd: sidecar, encoding: "utf8", env: { ...process.env, GOOS: goos, CGO_ENABLED: "0" } },
    )
    for (const line of out.split("\n")) {
      const [path, version, dir] = line.trim().split("\t")
      if (path && dir) modules.set(path, { path, version, dir })
    }
  }
  const components = [...modules.values()].map(({ path, version, dir }) => ({
    name: path,
    version: version.replace(/^v/, ""),
    licence: "",
    source: `https://pkg.go.dev/${path}`,
    texts: licenceTexts(dir),
  }))
  const goRoot = execFileSync(goBinary(), ["env", "GOROOT"], { encoding: "utf8" }).trim()
  const goVersion = execFileSync(goBinary(), ["env", "GOVERSION"], { encoding: "utf8" }).trim()
  components.push({
    name: "Go (runtime and standard library)",
    version: goVersion.replace(/^go/, ""),
    licence: "BSD-3-Clause",
    source: "https://go.dev",
    texts: licenceTexts(goRoot),
  })
  return components
}

/** A Go module names no licence; its text does. */
function licenceOfText(text) {
  if (/Apache License\s+Version 2\.0/i.test(text)) return "Apache-2.0"
  if (/Mozilla Public License,? v(ersion)?\.? ?2\.0/i.test(text)) return "MPL-2.0"
  if (/GNU (LESSER|Lesser) GENERAL PUBLIC LICENSE/.test(text)) return "LGPL"
  if (/GNU GENERAL PUBLIC LICENSE/.test(text)) return "GPL"
  if (/Permission is hereby granted, free of charge/.test(text)) return "MIT"
  if (/Permission to use, copy, modify, and(\/or)? distribute this software/.test(text))
    return "ISC"
  if (/Redistribution and use in source and binary forms/.test(text)) {
    return /Neither the name|may be used to endorse/.test(text) ? "BSD-3-Clause" : "BSD-2-Clause"
  }
  return ""
}

/** What no tool finds: third-party.json, with licence texts read from the files it names. */
function listedComponents() {
  const listed = readJson(join(desktop, "build", "third-party.json")).components
  const out = []
  for (const c of listed) {
    // The ffmpeg build is listed only when it is in a package (scripts/media-tools.mjs).
    if (
      c.when === "media-tools" &&
      !existsSync(join(desktop, "resources", "media-tools.lock.json"))
    )
      continue
    const texts = (c.files ?? []).map((file) => {
      const path = join(root, file)
      if (!existsSync(path)) throw new Error(`${c.name}: ${file} is missing (pnpm install)`)
      return { file: file.split("/").pop(), text: readFileSync(path, "utf8").trim() }
    })
    if (c.text) texts.push({ file: "NOTICE", text: c.text.join("\n") })
    const version =
      c.version ?? (c.versionFrom ? readJson(join(root, c.versionFrom)).version : "") ?? ""
    out.push({ name: c.name, version, licence: c.licence, source: c.source, texts, note: c.note })
  }
  return out
}

function collect() {
  const dirs = new Set()
  for (const app of ["viewer/renderer", "commander/renderer", "shared/docviewer"]) {
    rendererPackages(join(root, "src", app), dirs)
  }
  bundledPackages(join(desktop, "dist"), dirs)
  const npm = [...dirs]
    .map(npmComponent)
    // Workspace packages are the product itself.
    .filter((c) => !c.name.startsWith("@panelyth/"))
  const components = [...npm, ...goComponents(), ...listedComponents()]
  for (const c of components) {
    if (c.licence) continue
    // The module's own licence is the file named just that; the others are its dependencies'.
    const own = c.texts.find((t) => /^(licen[cs]e|copying)(\.(txt|md))?$/i.test(t.file))
    c.licence = licenceOfText(own ? own.text : c.texts.map((t) => t.text).join("\n"))
  }
  // One entry per name and version, whatever number of apps bundle it.
  const unique = new Map(components.map((c) => [`${c.name}@${c.version}`, c]))
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, "en"))
}

/** "MIT", "(MIT OR Apache-2.0)", "MIT AND ISC": every part must be allowed; of alternatives, one. */
function allowed(component) {
  const extra = ALLOWED_FOR[component.name] ?? new Set()
  const ok = (id) => ALLOWED.has(id) || extra.has(id)
  const expression = component.licence.replace(/[()]/g, " ").trim()
  if (!expression) return false
  return expression
    .split(/\s+AND\s+/i)
    .every((part) => part.split(/\s+OR\s+/i).some((id) => ok(id.trim())))
}

function problems(components) {
  const found = []
  for (const c of components) {
    if (c.texts.length === 0) found.push(`${c.name} ${c.version}: no licence text found`)
    if (!allowed(c))
      found.push(`${c.name} ${c.version}: licence "${c.licence}" is not one the product ships`)
  }
  return found
}

function render(components) {
  const rule = "=".repeat(80)
  const thin = "-".repeat(80)
  const lines = [
    "Panelyth — third-party notices",
    "",
    `Panelyth ${productVersion()} includes the software, fonts and icons listed below, each under its`,
    "own licence. The licence texts follow the list. Electron's and Chromium's own notices",
    "are in LICENSE.electron.txt and LICENSES.chromium.html in the application folder.",
    "",
    ...components.map((c) => `  ${c.name} ${c.version}  —  ${c.licence}`),
    "",
  ]
  for (const c of components) {
    lines.push(
      rule,
      `${c.name} ${c.version}`.trim(),
      `Licence: ${c.licence}`,
      `Source: ${c.source}`,
    )
    if (c.note) lines.push(c.note)
    for (const t of c.texts) lines.push(thin, t.file, "", t.text, "")
  }
  return lines.join("\n").replace(/\r\n?/g, "\n") + "\n"
}

const components = collect()
const found = problems(components)
if (found.length > 0) {
  console.error(`notices: ${found.length} problem(s)\n  ${found.join("\n  ")}`)
  process.exit(1)
}
if (process.argv.includes("--check")) {
  console.log(`notices: ${components.length} components, all with a licence the product ships`)
} else {
  writeFileSync(OUT, render(components))
  console.log(`notices: ${components.length} components → ${relative(root, OUT)}`)
}
