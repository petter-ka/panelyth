import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { goBinary } from "../../scripts/go.mjs"
import { repoRoot } from "./launch"

export interface Fixture {
  root: string
  expected: { Dirs: number; Media: number; NonMedia: number; Hidden: number }
}

export interface FixtureSpec {
  /** Real, decodable images instead of empty files. */
  images?: {
    count: number
    width: number
    height: number
    pngAlphaEvery?: number
    rotatedEvery?: number
  }
  files: number
  depth?: number
  fanout?: number
  nonMediaEvery?: number
}

/**
 * Generates (once per machine; cached by a marker file) a deterministic tree
 * with the Go fixture generator shared with the Go tests and benchmarks.
 */
export function ensureFixture(
  name: string,
  spec: FixtureSpec,
  base = join(tmpdir(), "fastview-fixtures"),
): Fixture {
  const root = join(base, name)
  const out = execFileSync(
    goBinary(),
    [
      "run",
      "./cmd/fixturegen",
      "-out",
      root,
      "-files",
      String(spec.files),
      "-depth",
      String(spec.depth ?? 0),
      "-fanout",
      String(spec.fanout ?? 0),
      "-non-media-every",
      String(spec.nonMediaEvery ?? 10),
      ...(spec.images
        ? [
            "-images",
            String(spec.images.count),
            "-width",
            String(spec.images.width),
            "-height",
            String(spec.images.height),
            "-png-alpha-every",
            String(spec.images.pngAlphaEvery ?? 0),
            "-rotated-every",
            String(spec.images.rotatedEvery ?? 0),
          ]
        : []),
    ],
    { cwd: join(repoRoot, "shared", "sidecar"), encoding: "utf8", timeout: 600_000 },
  )
  return JSON.parse(out) as Fixture
}
