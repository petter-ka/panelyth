import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { goBinary } from "../../../scripts/go.mjs"
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
  /** Lister fixtures (Stage C05): a numbered log of this size and the encoding samples. */
  text?: { logBytes: number; encodings: boolean }
  /** Archive fixtures (Stage C07): samples (set.zip, set.tar.gz, slip.zip), many.zip, big.tar.gz, pack/. */
  archives?: { samples?: boolean; zipEntries?: number; tgzBytes?: number; packFiles?: number }
  /** Compare fixtures (Stage C08): left/ and right/ with known differences; tree-a/ and tree-b/ of many files. */
  sync?: { pair?: boolean; entries?: number }
  /** Multi-rename fixtures (Stage C09): scenario/ with a few named files; files/ of many pictures; folders/ of many folders. */
  rename?: { scenario?: boolean; files?: number; folders?: number }
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
  base = join(tmpdir(), "panelyth-fixtures"),
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
      ...(spec.text
        ? [
            "-text-log-bytes",
            String(spec.text.logBytes),
            ...(spec.text.encodings ? ["-encodings"] : []),
          ]
        : []),
      ...(spec.archives
        ? [
            ...(spec.archives.samples ? ["-archive-samples"] : []),
            "-archive-zip-entries",
            String(spec.archives.zipEntries ?? 0),
            "-archive-tgz-bytes",
            String(spec.archives.tgzBytes ?? 0),
            "-archive-pack-files",
            String(spec.archives.packFiles ?? 0),
          ]
        : []),
      ...(spec.sync
        ? [
            ...(spec.sync.pair ? ["-sync-pair"] : []),
            "-sync-entries",
            String(spec.sync.entries ?? 0),
          ]
        : []),
      ...(spec.rename
        ? [
            ...(spec.rename.scenario ? ["-rename-scenario"] : []),
            "-rename-files",
            String(spec.rename.files ?? 0),
            "-rename-folders",
            String(spec.rename.folders ?? 0),
          ]
        : []),
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
    { cwd: join(repoRoot, "src", "shared", "sidecar"), encoding: "utf8", timeout: 600_000 },
  )
  return JSON.parse(out) as Fixture
}
