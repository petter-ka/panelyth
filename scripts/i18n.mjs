// Lists the messages the apps translate, and which are missing in each language:
//   node scripts/i18n.mjs            summary
//   node scripts/i18n.mjs --json     the English source messages as JSON
//   node scripts/i18n.mjs --missing de   the messages without a German translation
import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
execFileSync(
  pnpm,
  [
    "--filter",
    "@panelyth/i18n",
    "exec",
    "node",
    "--experimental-strip-types",
    "src/cli.ts",
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: "inherit", shell: process.platform === "win32" },
)
