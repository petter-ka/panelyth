// Packages the product for the host OS (ADR-0032): builds the renderers,
// main and preloads, the sidecar for every arch the OS's targets name, then
// runs electron-builder. Extra arguments go to electron-builder, for example
// `pnpm package --dir` (unpacked, for the smoke test) or
// `pnpm package -c.extraMetadata.version=1.2.3`.
// Output: shared/desktop/release/.
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const desktop = join(root, "shared", "desktop")
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

run(pnpm, ["build"])
run(process.execPath, [join(root, "scripts", "build-sidecar.mjs"), "--arch", archs])

const builder = createRequire(join(desktop, "package.json")).resolve("electron-builder/cli.js")
run(process.execPath, [builder, os, "--publish", "never", ...process.argv.slice(2)], desktop)
