// Development loop: build the sidecar and Electron bundles, start the Vite dev
// servers for the viewer and the commander (HMR), then launch Electron against
// them. The commander is enabled in development (ADR-0031 feature flag).
// Main/preload changes need a restart of this script.
import { execFileSync, spawn } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const desktop = join(root, "src", "shared", "desktop")
const renderer = join(root, "src", "viewer", "renderer")
const commander = join(root, "src", "commander", "renderer")
const system = join(root, "src", "system", "renderer")
const documents = join(root, "src", "shared", "docviewer")
const textEditor = join(root, "src", "shared", "doceditor")
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

execFileSync(process.execPath, [join(root, "scripts", "build-sidecar.mjs")], { stdio: "inherit" })
execFileSync(pnpm, ["--filter", "@panelyth/desktop", "build"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
})

async function devServer(dir, fallbackUrl) {
  const { createServer } = await import(
    // Resolve vite from the app's package so its config/plugins apply.
    pathToFileURL(createRequire(join(dir, "package.json")).resolve("vite")).href
  )
  const server = await createServer({ root: dir, configFile: join(dir, "vite.config.ts") })
  await server.listen()
  return { server, url: server.resolvedUrls?.local[0] ?? fallbackUrl }
}

const viewer = await devServer(renderer, "http://localhost:5173/")
const commanderDev = await devServer(commander, "http://localhost:5174/")
const documentsDev = await devServer(documents, "http://localhost:5175/")
const textEditorDev = await devServer(textEditor, "http://localhost:5177/")
const systemDev = await devServer(system, "http://localhost:5176/")
console.log(`viewer dev server: ${viewer.url}`)
console.log(`commander dev server: ${commanderDev.url}`)
console.log(`document window dev server: ${documentsDev.url}`)
console.log(`text editor window dev server: ${textEditorDev.url}`)
console.log(`system dev server: ${systemDev.url}`)

const electronPath = createRequire(join(desktop, "package.json"))("electron")
const child = spawn(electronPath, [desktop], {
  stdio: "inherit",
  env: {
    ...process.env,
    PANELYTH_RENDERER_URL: viewer.url,
    PANELYTH_COMMANDER_URL: commanderDev.url,
    PANELYTH_DOCUMENTS_URL: documentsDev.url,
    PANELYTH_TEXTEDITOR_URL: textEditorDev.url,
    PANELYTH_SYSTEM_URL: systemDev.url,
    PANELYTH_COMMANDER: process.env.PANELYTH_COMMANDER ?? "1",
  },
})
child.on("exit", async (code) => {
  await Promise.all([
    viewer.server.close(),
    commanderDev.server.close(),
    documentsDev.server.close(),
    textEditorDev.server.close(),
    systemDev.server.close(),
  ])
  process.exit(code ?? 0)
})
