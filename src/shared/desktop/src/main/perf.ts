import { performance } from "node:perf_hooks"

export type PerfMarkName =
  | "main-loaded"
  | "app-ready"
  | "sidecar-spawned"
  | "sidecar-ready"
  | "window-created"
  | "ready-to-show"
  | "commander-view-created"
  // A file from the OS: its media window was asked for (no main window behind it).
  | "open-with"

// Milliseconds since main-process start (performance.timeOrigin). Read by the
// startup benchmark through Playwright's electronApp.evaluate.
const marks: Partial<Record<PerfMarkName, number>> = {}

export function perfMark(name: PerfMarkName): void {
  marks[name] ??= performance.now()
}

export function perfMarks(): Readonly<Partial<Record<PerfMarkName, number>>> {
  return marks
}

// Exposed on globalThis for the benchmark harness; main process only, never
// reachable from the renderer.
;(globalThis as { __panelythPerf?: () => typeof marks }).__panelythPerf = () => ({ ...marks })
