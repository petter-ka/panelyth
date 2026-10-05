// Builds the Go sidecar for the host platform into
// apps/desktop/resources/bin/<platform>-<arch>/, where Electron main finds it.
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { goBinary } from "./go.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const goRoot = join(root, "native", "fastview-go")

const goos = { win32: "windows", darwin: "darwin", linux: "linux" }[process.platform]
const goarch = { x64: "amd64", arm64: "arm64" }[process.arch]
if (!goos || !goarch) throw new Error(`unsupported host ${process.platform}-${process.arch}`)

const outDir = join(
  root,
  "apps",
  "desktop",
  "resources",
  "bin",
  `${process.platform}-${process.arch}`,
)
const out = join(outDir, `fastview-sidecar${process.platform === "win32" ? ".exe" : ""}`)
mkdirSync(outDir, { recursive: true })

let version = "dev"
try {
  version = execFileSync("git", ["describe", "--always", "--dirty"], {
    cwd: root,
    encoding: "utf8",
  }).trim()
} catch {
  // not a git checkout
}

const started = performance.now()
execFileSync(
  goBinary(),
  [
    "build",
    "-trimpath",
    "-ldflags",
    `-s -w -X main.version=${version}`,
    "-o",
    out,
    "./cmd/fastview-sidecar",
  ],
  {
    cwd: goRoot,
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
  },
)
console.log(`sidecar ${version} → ${out} (${Math.round(performance.now() - started)} ms)`)
