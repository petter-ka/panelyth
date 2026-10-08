// Runs the production build unpackaged (renderer served via app://panelyth/).
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..", "shared", "desktop")
const electronPath = createRequire(join(desktop, "package.json"))("electron")
const env = { ...process.env }
delete env.PANELYTH_RENDERER_URL
spawn(electronPath, [desktop], { stdio: "inherit", env }).on("exit", (code) =>
  process.exit(code ?? 0),
)
