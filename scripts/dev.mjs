// Development loop: build the sidecar and Electron bundles, start the Vite dev
// server for the renderer (HMR), then launch Electron against it.
// Main/preload changes need a restart of this script.
import { execFileSync, spawn } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const desktop = join(root, "apps", "desktop")
const renderer = join(root, "apps", "renderer")
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"

execFileSync(process.execPath, [join(root, "scripts", "build-sidecar.mjs")], { stdio: "inherit" })
execFileSync(pnpm, ["--filter", "@fastview/desktop", "build"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
})

const { createServer } = await import(
  // Resolve vite from the renderer package so its config/plugins apply.
  pathToFileURL(createRequire(join(renderer, "package.json")).resolve("vite")).href
)
const server = await createServer({ root: renderer, configFile: join(renderer, "vite.config.ts") })
await server.listen()
const url = server.resolvedUrls?.local[0] ?? "http://localhost:5173/"
console.log(`renderer dev server: ${url}`)

const electronPath = createRequire(join(desktop, "package.json"))("electron")
const child = spawn(electronPath, [desktop], {
  stdio: "inherit",
  env: { ...process.env, FASTVIEW_RENDERER_URL: url },
})
child.on("exit", async (code) => {
  await server.close()
  process.exit(code ?? 0)
})
