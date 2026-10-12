// Packages the product for the host OS (ADR-0032, Stage P06): builds the
// renderers, main and preloads, the sidecar for every arch the OS's targets
// name, fetches the LGPL ffmpeg beside it, writes the licence notices, then
// runs electron-builder. Extra arguments go to electron-builder, for example
// `pnpm package --dir` (unpacked, for the smoke test).
//
// The environment decides what kind of package it is (docs/RELEASING.md):
//   PANELYTH_VERSION           the release's version; default: the desktop package's
//   PANELYTH_UPDATE_URL        a static HTTPS feed in place of the GitHub releases; "none": no updates
//   PANELYTH_MEDIA_TOOLS=skip  no bundled ffmpeg (the package uses the system's)
//   PANELYTH_REQUIRE_SIGNING=1 fail unless the package will be signed (and notarized on macOS)
//   signing: CSC_LINK / CSC_KEY_PASSWORD, WIN_CSC_LINK, AZURE_SIGN_*, APPLE_API_KEY* or APPLE_ID*
// Output: src/shared/desktop/release/.
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { productVersion } from "./version.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const desktop = join(root, "src", "shared", "desktop")
const archs = { darwin: "arm64,x64", win32: "x64", linux: "x64" }[process.platform]
if (!archs) throw new Error(`no package targets for ${process.platform}`)
const os = { darwin: "--mac", win32: "--win", linux: "--linux" }[process.platform]

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, {
    cwd,
    stdio: "inherit",
    // Windows needs cmd.exe for pnpm.cmd. Keep node.exe direct so paths with
    // spaces (for example C:\Program Files\nodejs\node.exe) stay quoted.
    shell: process.platform === "win32" && cmd.toLowerCase().endsWith(".cmd"),
  })
const script = (name, ...args) => run(process.execPath, [join(root, "scripts", name), ...args])

// Fails here, before a long build, on a version that is not one.
const version = productVersion()

// What the package will be, said before the build and checked when a release needs it.
const config = await import(pathToFileURL(join(desktop, "electron-builder.config.mjs")).href)
const signed = { darwin: config.macSigned, win32: config.winSigned, linux: false }[process.platform]
const notarized = process.platform !== "darwin" || config.default.mac.notarize === true
const feed = config.default.publish
console.log(
  [
    `package: Panelyth ${version} for ${process.platform} (${archs})`,
    `  signing: ${signed ? "yes" : process.platform === "linux" ? "checksums only (docs/RELEASING.md)" : "NO: the OS will warn about this package"}`,
    ...(process.platform === "darwin" ? [`  notarization: ${notarized ? "yes" : "NO"}`] : []),
    `  updates: ${feed ? (feed.provider === "generic" ? feed.url : `github.com/${feed.owner}/${feed.repo} releases`) : "none"}`,
  ].join("\n"),
)
if (process.env.PANELYTH_REQUIRE_SIGNING === "1" && process.platform !== "linux") {
  if (!signed)
    throw new Error("PANELYTH_REQUIRE_SIGNING is set and no signing identity is configured")
  if (!notarized)
    throw new Error("PANELYTH_REQUIRE_SIGNING is set and notarization is not configured")
}

run(pnpm, ["build"])
script("build-sidecar.mjs", "--arch", archs)
if (process.env.PANELYTH_MEDIA_TOOLS === "skip")
  script("media-tools.mjs", "--arch", archs, "--clean")
else script("media-tools.mjs", "--arch", archs)
// After the build and the media tools: the notices list what the package holds.
script("notices.mjs")

// electron-builder packs the NSIS payload with 7-Zip at -mx=9 whatever
// `compression` says (only "store" changes it), and the bundled 7za.exe crashed
// with an access violation (0xC0000005) doing so on a Windows machine. A lower
// level avoids that; set ELECTRON_BUILDER_COMPRESSION_LEVEL (0-9) to override.
if (process.platform === "win32" && process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL === undefined) {
  process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL = "5"
}

const builder = createRequire(join(desktop, "package.json")).resolve("electron-builder/cli.js")
run(
  process.execPath,
  [
    builder,
    os,
    "--config",
    "electron-builder.config.mjs",
    "--publish",
    "never",
    ...process.argv.slice(2),
  ],
  desktop,
)
