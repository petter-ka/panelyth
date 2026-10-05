// Development loop: build the sidecar and Electron bundles, start the Vite dev
// servers for the viewer and the commander (HMR), then launch Electron against
// them. The commander is enabled in development (ADR-0031 feature flag).
// Main/preload changes need a restart of this script.
import { execFileSync, spawn } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const desktop = join(root, "shared", "desktop")
const renderer = join(root, "viewer", "renderer")
const commander = join(root, "commander", "renderer")
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

execFileSync(process.execPath, [join(root, "scripts", "build-sidecar.mjs")], { stdio: "inherit" })
execFileSync(pnpm, ["--filter", "@fastview/desktop", "build"], {
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
console.log(`viewer dev server: ${viewer.url}`)
console.log(`commander dev server: ${commanderDev.url}`)

const electronPath = createRequire(join(desktop, "package.json"))("electron")
const child = spawn(electronPath, [desktop], {
  stdio: "inherit",
  env: {
    ...process.env,
    FASTVIEW_RENDERER_URL: viewer.url,
    FASTVIEW_COMMANDER_URL: commanderDev.url,
    FASTVIEW_COMMANDER: process.env.FASTVIEW_COMMANDER ?? "1",
  },
})
child.on("exit", async (code) => {
  await Promise.all([viewer.server.close(), commanderDev.server.close()])
  process.exit(code ?? 0)
})
