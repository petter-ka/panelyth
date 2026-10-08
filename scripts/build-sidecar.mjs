// Builds the Go sidecar into shared/desktop/resources/bin/<platform>-<arch>/,
// where Electron main finds it and the packager copies it from (ADR-0032).
// Host platform and arch by default; `--arch x64,arm64` and `--platform
// darwin` cross-compile (CGO_ENABLED=0, ADR-0019).
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { goBinary } from "./go.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const goRoot = join(root, "shared", "sidecar")

const { values } = parseArgs({
  options: {
    platform: { type: "string", default: process.platform },
    arch: { type: "string", default: process.arch },
  },
})
const platform = values.platform
const goos = { win32: "windows", darwin: "darwin", linux: "linux" }[platform]
if (!goos) throw new Error(`unsupported platform ${platform}`)

let version = "dev"
try {
  version = execFileSync("git", ["describe", "--always", "--dirty"], {
    cwd: root,
    encoding: "utf8",
  }).trim()
} catch {
  // not a git checkout
}

for (const arch of values.arch.split(",")) {
  const goarch = { x64: "amd64", arm64: "arm64" }[arch]
  if (!goarch) throw new Error(`unsupported arch ${arch}`)
  const outDir = join(root, "shared", "desktop", "resources", "bin", `${platform}-${arch}`)
  const out = join(outDir, `panelyth-sidecar${platform === "win32" ? ".exe" : ""}`)
  mkdirSync(outDir, { recursive: true })
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
      "./cmd/panelyth-sidecar",
    ],
    {
      cwd: goRoot,
      stdio: "inherit",
      env: { ...process.env, CGO_ENABLED: "0", GOOS: goos, GOARCH: goarch },
    },
  )
  console.log(`sidecar ${version} → ${out} (${Math.round(performance.now() - started)} ms)`)
}
