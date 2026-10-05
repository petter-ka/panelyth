// Benchmark result paths. Results are evidence: a run never overwrites an
// earlier one; a numeric suffix is added instead.
import { existsSync, mkdirSync } from "node:fs"
import { hostname } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const resultsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "shared",
  "bench",
  "results",
)

/**
 * shared/bench/results/stage-<BENCH_STAGE>-<date>-<host>-<kind>[-n].json.
 * BENCH_STAGE is required so results are never filed under the wrong stage.
 */
export function resultPath(kind, ext = "json") {
  const stage = process.env.BENCH_STAGE
  // Viewer stages (03, 08.6), platform (P01) and commander (C00) stage IDs.
  if (!stage || !/^(\d{2}(\.\d)?|[PC]\d{2})$/.test(stage)) {
    throw new Error("Set BENCH_STAGE to the stage being measured, e.g. BENCH_STAGE=02, P01 or C00")
  }
  mkdirSync(resultsDir, { recursive: true })
  const date = new Date().toISOString().slice(0, 10)
  const host = hostname()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
  const base = `stage-${stage}-${date}-${host}-${kind}`
  let file = join(resultsDir, `${base}.${ext}`)
  for (let n = 2; existsSync(file); n++) file = join(resultsDir, `${base}-${n}.${ext}`)
  return file
}
