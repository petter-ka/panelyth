// Go tooling wrapper for pnpm scripts: `node scripts/go.mjs <fmt|fmt-check|vet|test|bench>`.
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { resultPath } from "./results.mjs"

const goRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "shared", "sidecar")

/** `go` from PATH, falling back to the per-user Windows install location. */
export function goBinary() {
  if (process.env.GO) return process.env.GO
  const probe = spawnSync("go", ["version"], { stdio: "ignore" })
  if (probe.status === 0) return "go"
  const local =
    process.platform === "win32"
      ? join(
          process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
          "Programs",
          "go",
          "bin",
          "go.exe",
        )
      : "/usr/local/go/bin/go"
  if (existsSync(local)) return local
  throw new Error("Go toolchain not found. Install Go or set GO=/path/to/go.")
}

function gofmt() {
  const go = goBinary()
  if (go === "go") return "gofmt"
  return join(dirname(go), process.platform === "win32" ? "gofmt.exe" : "gofmt")
}

const fixtureRoot = () => process.env.FASTVIEW_FIXTURES ?? join(tmpdir(), "fastview-fixtures")

const run = (cmd, args) => execFileSync(cmd, args, { cwd: goRoot, stdio: "inherit" })

// Only when run as a script: the e2e fixtures import goBinary(), and an
// import must not start a task (under Playwright, argv[2] is "test").
const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
const task = isMain ? process.argv[2] : undefined
if (task) {
  switch (task) {
    case "fmt":
      run(gofmt(), ["-w", "."])
      break
    case "fmt-check": {
      const out = execFileSync(gofmt(), ["-l", "."], { cwd: goRoot, encoding: "utf8" }).trim()
      if (out) {
        console.error(`gofmt needed:\n${out}`)
        process.exit(1)
      }
      break
    }
    case "vet":
      run(goBinary(), ["vet", "./..."])
      break
    case "test":
      run(goBinary(), ["test", "-count=1", "-timeout=120s", "./..."])
      break
    case "indexbench":
      run(goBinary(), [
        "run",
        "./cmd/indexbench",
        "-fixtures",
        fixtureRoot(),
        "-out",
        resultPath("index"),
      ])
      break
    case "thumbbench":
      run(goBinary(), [
        "run",
        "./cmd/thumbbench",
        "-fixtures",
        fixtureRoot(),
        "-out",
        resultPath("previews"),
      ])
      break
    case "findbench":
      run(goBinary(), [
        "run",
        "./cmd/findbench",
        "-fixtures",
        fixtureRoot(),
        "-out",
        resultPath("find"),
      ])
      break
    case "bench":
      run(goBinary(), ["test", "-run=^$", "-bench=.", "-benchmem", "-count=5", "./..."])
      break
    default:
      console.error(`unknown task ${task}`)
      process.exit(2)
  }
}
