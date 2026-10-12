// Puts an LGPL ffmpeg and ffprobe beside the sidecar (ADR-0018, Stage P06),
// where the sidecar looks first (internal/video: "next to the sidecar
// executable"). The builds are named in src/shared/desktop/media-tools.json:
// a URL and its SHA-256 per platform, so a package holds exactly the bytes
// that were reviewed.
//
//   node scripts/media-tools.mjs                 host platform and arch
//   node scripts/media-tools.mjs --arch x64,arm64
//   node scripts/media-tools.mjs --clean         remove what was fetched
//
// A build is refused when its checksum differs or when it was configured with
// GPL or non-free parts. A platform without an entry gets none: the package
// then uses an ffmpeg installed on the system, as development builds do.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const desktop = join(root, "src", "shared", "desktop")
const manifestPath = join(desktop, "media-tools.json")
/** What the notices script reads: present only while a build is in resources/bin. */
const lockPath = join(desktop, "resources", "media-tools.lock.json")
const licencePath = join(desktop, "resources", "media-tools.LICENSE.txt")
const BUILD_NOTE = "FFMPEG-BUILD.txt"

const binDir = (platform, arch) => join(desktop, "resources", "bin", `${platform}-${arch}`)
// Linux builds look for their libraries in ../lib (their RPATH is $ORIGIN/../lib); the
// package copies this folder to resources/lib, beside resources/bin.
const libDir = (platform, arch) => join(desktop, "resources", "lib", `${platform}-${arch}`)

// bsdtar reads zip and tar.xz. Windows has it in System32; a `tar` found on PATH there
// can be GNU tar (Git Bash), which reads no zip.
const TAR =
  process.platform === "win32"
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar"

async function sha256(path) {
  const hash = createHash("sha256")
  await pipeline(createReadStream(path), hash)
  return hash.digest("hex")
}

/** The archive, from the cache when its checksum still matches. */
async function download(build) {
  const cache = process.env.PANELYTH_MEDIA_TOOLS_CACHE || join(tmpdir(), "panelyth-media-tools")
  mkdirSync(cache, { recursive: true })
  const file = join(cache, `${build.sha256}-${basename(new URL(build.url).pathname)}`)
  if (existsSync(file) && (await sha256(file)) === build.sha256) return file
  console.log(`media tools: downloading ${build.url}`)
  const response = await fetch(build.url, { redirect: "follow" })
  if (!response.ok || !response.body) throw new Error(`${build.url}: HTTP ${response.status}`)
  const partial = `${file}.part`
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
  const actual = await sha256(partial)
  if (actual !== build.sha256) {
    rmSync(partial, { force: true })
    throw new Error(
      `${build.url}: SHA-256 is ${actual}, the manifest says ${build.sha256}. Nothing was installed.`,
    )
  }
  renameSync(partial, file)
  return file
}

/** Files of `dir` a pattern names: a path, or a folder with `*.ext`. */
function matches(dir, pattern) {
  const folder = join(dir, dirname(pattern))
  const name = basename(pattern)
  if (!name.includes("*")) return existsSync(join(folder, name)) ? [join(folder, name)] : []
  const [prefix, suffix] = name.split("*")
  return readdirSync(folder)
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .map((f) => join(folder, f))
}

/** Removes a fetched build: the files its note lists, and its libraries. */
function clean(platform, arch) {
  const dir = binDir(platform, arch)
  const libs = libDir(platform, arch)
  rmSync(libs, { recursive: true, force: true })
  // The package copies this folder whether or not a build has libraries.
  mkdirSync(libs, { recursive: true })
  const note = join(dir, BUILD_NOTE)
  if (!existsSync(note)) return
  const listed = readFileSync(note, "utf8").match(/^Files: (.*)$/m)?.[1] ?? ""
  for (const name of listed.split(", ").filter(Boolean)) rmSync(join(dir, name), { force: true })
  rmSync(note, { force: true })
}

async function install(manifest, platform, arch) {
  const key = `${platform}-${arch}`
  const build = manifest.builds[key]
  const out = binDir(platform, arch)
  clean(platform, arch)
  if (!build) {
    console.log(`media tools: no ffmpeg build is listed for ${key}; the package uses the system's`)
    return null
  }
  const archive = await download(build)
  const scratch = mkdtempSync(join(tmpdir(), "panelyth-ffmpeg-"))
  try {
    // bsdtar (Windows, macOS) reads zip and tar.xz; GNU tar reads the tar.xz of Linux builds.
    execFileSync(TAR, ["-xf", archive, "-C", scratch], { stdio: "inherit" })
    const top = join(scratch, build.root)
    const take = (patterns) =>
      (patterns ?? []).flatMap((pattern) => {
        const found = matches(top, pattern)
        if (found.length === 0) throw new Error(`${key}: nothing matches ${pattern} in the archive`)
        return found
      })
    const files = take(build.bin)
    const libraries = take(build.lib)
    mkdirSync(out, { recursive: true })
    // A copy follows links: a library lands under the name the programs ask for.
    for (const file of files) copyFileSync(file, join(out, basename(file)))
    for (const file of libraries) copyFileSync(file, join(libDir(platform, arch), basename(file)))
    const names = files.map((f) => basename(f)).sort()

    // The licence gate: only a build this machine can run can be asked how it was configured.
    let configuration = "(not run: built for another platform or architecture)"
    if (platform === process.platform && arch === process.arch) {
      const exe = join(out, platform === "win32" ? "ffmpeg.exe" : "ffmpeg")
      const version = execFileSync(exe, ["-version"], { encoding: "utf8" })
      configuration = version.match(/^configuration: (.*)$/m)?.[1] ?? ""
      if (!version.startsWith("ffmpeg version") || !configuration) {
        throw new Error(`${key}: ${exe} did not report its configuration`)
      }
      const forbidden = ["--enable-gpl", "--enable-nonfree"].filter((f) =>
        configuration.includes(f),
      )
      if (forbidden.length > 0) {
        clean(platform, arch)
        throw new Error(
          `${key}: this ffmpeg was built with ${forbidden.join(" and ")}; only LGPL builds ship (ADR-0018)`,
        )
      }
    }
    const licence = readFileSync(join(top, build.licenceFile), "utf8")
    writeFileSync(
      join(out, BUILD_NOTE),
      [
        `FFmpeg ${manifest.ffmpeg} (ffmpeg and ffprobe), an ${manifest.licence} build, unmodified.`,
        "Panelyth starts these programs as child processes; it does not link them.",
        `Build: ${build.url}`,
        `SHA-256: ${build.sha256}`,
        `Source: ${manifest.source}`,
        `Build scripts: ${manifest.buildScripts}`,
        // The configuration names every library the build links.
        `Configuration: ${configuration}`,
        `Files: ${names.join(", ")}`,
        ...(libraries.length > 0
          ? [
              `Libraries (../lib): ${libraries
                .map((f) => basename(f))
                .sort()
                .join(", ")}`,
            ]
          : []),
        "You may replace these files with another build of the same FFmpeg version.",
        "The licence is in THIRD-PARTY-NOTICES.txt in the application's resources.",
        "",
      ].join("\n"),
    )
    console.log(
      `media tools: ffmpeg ${manifest.ffmpeg} (${names.length + libraries.length} files) → ${out}`,
    )
    return { key, url: build.url, sha256: build.sha256, files: names, licence }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const { values } = parseArgs({
  options: {
    platform: { type: "string", default: process.platform },
    arch: { type: "string", default: process.arch },
    clean: { type: "boolean", default: false },
  },
})
const archs = values.arch.split(",")

if (values.clean) {
  for (const arch of archs) clean(values.platform, arch)
  rmSync(lockPath, { force: true })
  rmSync(licencePath, { force: true })
  console.log("media tools: removed")
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  const installed = []
  for (const arch of archs) {
    const result = await install(manifest, values.platform, arch)
    if (result) installed.push(result)
  }
  if (installed.length > 0) {
    writeFileSync(licencePath, installed[0].licence)
    writeFileSync(
      lockPath,
      JSON.stringify(
        {
          version: manifest.ffmpeg,
          licence: manifest.licence,
          builds: installed.map(({ key, url, sha256: sum, files }) => ({
            key,
            url,
            sha256: sum,
            files,
          })),
        },
        null,
        2,
      ) + "\n",
    )
  } else {
    rmSync(lockPath, { force: true })
    rmSync(licencePath, { force: true })
  }
}
