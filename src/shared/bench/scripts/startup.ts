// Stage 00 baseline: startup timings, idle memory, IPC round trip, relay
// throughput and shutdown latency. Runs the production build (`pnpm build`).
//
//   pnpm bench:startup            (from repo root; builds first)
//   RUNS=20 pnpm --filter @panelyth/bench startup
//
// Writes bench/results/stage-00-<date>-<host>.json. Never fabricates values:
// anything that could not be measured is recorded as null.
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { cpus, hostname, platform, release, tmpdir, totalmem } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { resultPath } from "../../../../scripts/results.mjs"
import type { PanelythApi, SidecarStatus } from "@panelyth/contracts"
import { _electron, type ElectronApplication, type Page } from "playwright"

declare global {
  interface Window {
    panelyth?: PanelythApi
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")
const desktopDir = join(root, "src", "shared", "desktop")
const electronPath = createRequire(import.meta.url)("electron") as unknown as string
const RUNS = Number(process.env.RUNS ?? 10)
const IDLE_MS = Number(process.env.IDLE_MS ?? 10_000)
const STAGE = process.env.BENCH_STAGE ?? ""
// A VS Code extension host sets ELECTRON_RUN_AS_NODE for its children; with
// it Electron runs as plain Node and neither the app nor the empty Electron
// starts.
delete process.env.ELECTRON_RUN_AS_NODE
// Resolved up front so a missing BENCH_STAGE fails before minutes of runs;
// never overwrites an earlier result.
const outFile = resultPath("startup")

type MainMarks = Partial<Record<string, number>>

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function stats(values: number[]) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!
  const round = (v: number) => Math.round(v * 1000) / 1000
  return {
    n: sorted.length,
    min: round(sorted[0]!),
    p50: round(q(0.5)),
    p95: round(q(0.95)),
    p99: round(q(0.99)),
    max: round(sorted.at(-1)!),
  }
}

async function launch(extraEnv: Record<string, string> = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "panelyth-bench-"))
  const started = performance.now()
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [desktopDir],
    env: {
      ...(process.env as Record<string, string>),
      PANELYTH_CACHE_DIR: join(scratch, "cache"),
      PANELYTH_CONFIG_DIR: join(scratch, "config"),
      PANELYTH_USER_DATA_DIR: join(scratch, "user-data"),
      PANELYTH_RENDERER_URL: "",
      ...extraEnv,
    },
  })
  const page = await app.firstWindow()
  return { app, page, started }
}

async function status(page: Page): Promise<SidecarStatus> {
  return page.evaluate(async () => {
    const res = await window.panelyth!.sidecar.getStatus()
    if (!res.ok) throw new Error(res.e.message)
    return res.r
  })
}

async function waitReady(page: Page): Promise<SidecarStatus> {
  for (;;) {
    const s = await status(page)
    if (s.state === "ready") return s
    if (s.state === "failed") throw new Error(`sidecar failed: ${s.lastError}`)
    await sleep(5)
  }
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Working set / RSS of an arbitrary pid in KB, or null if unavailable. */
function processMemoryKb(pid: number): number | null {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
      })
      const cols = out.trim().split('","')
      const mem = cols.at(-1)?.replace(/[^\d]/g, "")
      return mem ? Number(mem) : null
    }
    const out = execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" })
    return Number(out.trim()) || null
  } catch {
    return null
  }
}

/**
 * Polls sidecar liveness *while* Electron closes. Awaiting app.close() first
 * would fold Chromium's whole teardown (slow on a fresh profile) into the
 * sidecar number.
 */
async function closeAndMeasure(app: ElectronApplication, sidecarPid: number | null) {
  const t = performance.now()
  const sidecarGone = (async (): Promise<number | null> => {
    if (sidecarPid === null) return null
    while (isAlive(sidecarPid)) {
      if (performance.now() - t > 5_000) return null
      await sleep(2)
    }
    return performance.now() - t
  })()
  await app.close()
  const closeMs = performance.now() - t
  return { closeMs, sidecarGoneMs: await sidecarGone }
}

async function startupRuns() {
  const rows: {
    wallToWindowMs: number
    wallToReadyMs: number
    main: MainMarks
    rendererFirstRenderMs: number | null
    closeMs: number
    sidecarGoneMs: number | null
  }[] = []
  for (let i = 0; i < RUNS; i++) {
    const { app, page, started } = await launch()
    const wallToWindowMs = performance.now() - started
    const s = await waitReady(page)
    await page.waitForFunction(() => performance.getEntriesByName("fv:first-render").length > 0)
    const wallToReadyMs = performance.now() - started
    // ready-to-show can land after the renderer's first render; wait for it.
    let main: MainMarks = {}
    for (let tries = 0; tries < 200 && main["ready-to-show"] === undefined; tries++) {
      main = await app.evaluate(
        () => (globalThis as { __panelythPerf?: () => MainMarks }).__panelythPerf?.() ?? {},
      )
      if (main["ready-to-show"] === undefined) await sleep(10)
    }
    const rendererFirstRenderMs = await page.evaluate(
      () => performance.getEntriesByName("fv:first-render")[0]?.startTime ?? null,
    )
    const closed = await closeAndMeasure(app, s.pid)
    rows.push({ wallToWindowMs, wallToReadyMs, main, rendererFirstRenderMs, ...closed })
    process.stdout.write(`run ${i + 1}/${RUNS}: ready in ${wallToReadyMs.toFixed(0)} ms\n`)
  }
  const col = (f: (r: (typeof rows)[number]) => number | null | undefined) =>
    stats(rows.map(f).filter((v): v is number => typeof v === "number"))
  return {
    note: "main.* are ms since Electron main-process start; wall.* include Playwright launch/attach overhead",
    firstRun: rows[0],
    main: {
      mainLoaded: col((r) => r.main["main-loaded"]),
      appReady: col((r) => r.main["app-ready"]),
      sidecarSpawned: col((r) => r.main["sidecar-spawned"]),
      sidecarReady: col((r) => r.main["sidecar-ready"]),
      windowCreated: col((r) => r.main["window-created"]),
      readyToShow: col((r) => r.main["ready-to-show"]),
    },
    rendererFirstRenderSinceNavigation: col((r) => r.rendererFirstRenderMs),
    wall: {
      toFirstWindow: col((r) => r.wallToWindowMs),
      toSidecarReadyAndFirstRender: col((r) => r.wallToReadyMs),
    },
    shutdown: {
      appClose: col((r) => r.closeMs),
      sidecarExitAfterCloseStart: col((r) => r.sidecarGoneMs),
      orphanedSidecars: rows.filter((r) => r.sidecarGoneMs === null).length,
    },
  }
}

async function steadyState() {
  const { app, page } = await launch({ PANELYTH_DEV_METHODS: "1" })
  const s = await waitReady(page)
  await sleep(IDLE_MS)

  const metrics = await app.evaluate(({ app }) =>
    app.getAppMetrics().map((m) => ({
      type: m.type,
      pid: m.pid,
      workingSetKb: m.memory.workingSetSize,
      cpu: m.cpu.percentCPUUsage,
    })),
  )
  const sidecarKb = s.pid !== null ? processMemoryKb(s.pid) : null
  const electronKb = metrics.reduce((sum, m) => sum + m.workingSetKb, 0)
  const info = await page.evaluate(async () => {
    const r = await window.panelyth!.system.info()
    return r.ok ? r.r : null
  })

  const pingSeq = await page.evaluate(async (n) => {
    const out: number[] = []
    for (let i = 0; i < 50; i++) await window.panelyth!.system.ping() // warm-up
    for (let i = 0; i < n; i++) {
      const t = performance.now()
      const r = await window.panelyth!.system.ping()
      out.push(performance.now() - t)
      if (!r.ok) throw new Error(r.e.message)
    }
    return out
  }, 1000)

  const pingConcurrent = await page.evaluate(
    async ({ n, concurrency }) => {
      const out: number[] = []
      let next = 0
      const t0 = performance.now()
      // Inline (unnamed) function: tsx's keepNames helper does not exist in the page.
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (next < n) {
            next++
            const t = performance.now()
            const r = await window.panelyth!.system.ping()
            out.push(performance.now() - t)
            if (!r.ok) throw new Error(r.e.message)
          }
        }),
      )
      return { latencies: out, totalMs: performance.now() - t0 }
    },
    { n: 1000, concurrency: 32 },
  )

  const echo = await page.evaluate(
    async ({ n, size }) => {
      const payload = "x".repeat(size)
      const out: number[] = []
      for (let i = 0; i < n; i++) {
        const t = performance.now()
        const r = await window.panelyth!.dev!.echo(payload)
        out.push(performance.now() - t)
        if (!r.ok || r.r.payload.length !== size) throw new Error("echo failed")
      }
      return out
    },
    { n: 200, size: 64 * 1024 },
  )

  const echoStats = stats(echo)
  await closeAndMeasure(app, s.pid)
  return {
    idleAfterMs: IDLE_MS,
    memory: {
      electronWorkingSetKb: electronKb,
      sidecarWorkingSetKb: sidecarKb,
      totalKb: sidecarKb === null ? null : electronKb + sidecarKb,
      electronProcesses: metrics,
      sidecarGoHeapBytes: info?.heapBytes ?? null,
      sidecarGoRuntimeBytes: info?.runtimeMemBytes ?? null,
      sidecarGoroutines: info?.goroutines ?? null,
    },
    ipc: {
      pingSequentialMs: stats(pingSeq),
      pingConcurrent32Ms: stats(pingConcurrent.latencies),
      pingConcurrent32Throughput: Math.round((1000 / pingConcurrent.totalMs) * 1000),
      echo64KbMs: echoStats,
      echo64KbMBps: echoStats
        ? Math.round(((2 * 64) / 1024 / (echoStats.p50 / 1000)) * 10) / 10
        : null,
    },
    goVersion: info?.goVersion ?? null,
  }
}

/**
 * Idle working set of an empty sandboxed Electron window (bench/empty-electron),
 * measured the same way. Panelyth's memory budget is the delta over this
 * floor, because the floor is Electron's and varies by OS and version.
 */
async function emptyElectronBaseline() {
  const totals: number[] = []
  for (let i = 0; i < 3; i++) {
    const app = await _electron.launch({
      executablePath: electronPath,
      args: [join(root, "src", "shared", "bench", "empty-electron")],
    })
    await app.firstWindow()
    await sleep(IDLE_MS)
    const kb = await app.evaluate(({ app }) =>
      app.getAppMetrics().reduce((sum, m) => sum + m.memory.workingSetSize, 0),
    )
    totals.push(kb)
    await app.close()
  }
  return { totalKb: stats(totals) }
}

// Budgets from docs/shared/ARCHITECTURE-ANALYSIS.md §10.4 (memory recalibrated in stage 00).
function evaluateBudgets(
  startup: Awaited<ReturnType<typeof startupRuns>>,
  steady: Awaited<ReturnType<typeof steadyState>>,
  baseline: Awaited<ReturnType<typeof emptyElectronBaseline>>,
) {
  const totalMb = steady.memory.totalKb === null ? null : steady.memory.totalKb / 1024
  const floorMb = baseline.totalKb ? baseline.totalKb.p50 / 1024 : null
  const check = (name: string, value: number | null | undefined, limit: number, unit: string) => ({
    name,
    value: value ?? null,
    limit,
    unit,
    pass: value === null || value === undefined ? null : value < limit,
  })
  return [
    check("ready-to-show p50 (since main start)", startup.main.readyToShow?.p50, 1000, "ms"),
    check("sidecar ready p50 (since main start)", startup.main.sidecarReady?.p50, 500, "ms"),
    check("idle memory, all processes (absolute)", totalMb, 400, "MB"),
    check(
      "idle memory over empty-Electron floor",
      totalMb === null || floorMb === null ? null : totalMb - floorMb,
      60,
      "MB",
    ),
    check("ping round trip p95", steady.ipc.pingSequentialMs?.p95, 3, "ms"),
    check(
      "sidecar exit after close p95",
      startup.shutdown.sidecarExitAfterCloseStart?.p95,
      1000,
      "ms",
    ),
  ]
}

const startup = await startupRuns()
const steady = await steadyState()
const emptyElectron = await emptyElectronBaseline()
const budgets = evaluateBudgets(startup, steady, emptyElectron)

const versions = await (async () => {
  const { app, page } = await launch()
  const v = await app.evaluate(() => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }))
  await waitReady(page)
  await app.close()
  return v
})()

let commit: string | null = null
try {
  commit = execFileSync("git", ["describe", "--always", "--dirty"], {
    cwd: root,
    encoding: "utf8",
  }).trim()
} catch {
  // not a git checkout
}

const host = hostname()
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, "-")
const result = {
  stage: STAGE,
  benchmark: "startup-idle-ipc",
  date: new Date().toISOString(),
  commit,
  env: {
    host,
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? null,
    cores: cpus().length,
    ramGb: Math.round(totalmem() / 1024 ** 3),
    runnerNode: process.versions.node,
    ...versions,
    go: steady.goVersion,
    build: "production renderer via app://, unpackaged Electron",
  },
  fixture: "none (empty app)",
  runs: RUNS,
  startup,
  steady,
  emptyElectron,
  budgets,
}

writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n")

console.log("\nBudgets (provisional):")
for (const b of budgets) {
  const verdict = b.pass === null ? "NOT MEASURED" : b.pass ? "PASS" : "FAIL"
  console.log(
    `  ${verdict.padEnd(12)} ${b.name}: ${b.value === null ? "—" : b.value.toFixed(2)} ${b.unit} (budget < ${b.limit} ${b.unit})`,
  )
}
console.log(`\nwrote ${outFile}`)
