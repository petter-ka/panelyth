// Points git at the repository's own hooks in .githooks (`pnpm install` runs
// this as `prepare`): pre-push runs the lint and the tests, not e2e.
// Nothing happens outside a git checkout or in CI, which runs those itself.
import { execFileSync } from "node:child_process"
import { chmodSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const hooks = join(root, ".githooks")

const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })

if (process.env.CI) process.exit(0)
try {
  if (git("rev-parse", "--is-inside-work-tree").trim() !== "true") process.exit(0)
} catch {
  // No git, or not a checkout (a source archive).
  process.exit(0)
}

git("config", "core.hooksPath", ".githooks")
// macOS and Linux run a hook only when it is executable; Windows ignores the mode.
for (const name of readdirSync(hooks)) chmodSync(join(hooks, name), 0o755)
console.log("git hooks: .githooks (pre-push runs pnpm lint and pnpm test)")
