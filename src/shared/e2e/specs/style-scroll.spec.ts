import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { ensureFixture } from "../fixtures"
import { repoRoot, showViewerFolder } from "../launch"
import { commanderOf, goTo, launch } from "./commander/helpers"

// The design styles' cost on the scrolling surfaces (ADR-0041, ADR-0047): the
// viewer's tile view and the commander's Full view on flat-10k, scrolled at
// 300 px per frame for 2 s and then slowly for 1 s, the styles alternating so
// drift on the machine falls on both. A measurement, not a gate: run with
// PANELYTH_STYLE_BENCH=1 (and BENCH_STAGE; STYLE_BENCH_RUNS for more than 6 runs) after a
// change to a style.

test.skip(!process.env.PANELYTH_STYLE_BENCH, "a measurement; PANELYTH_STYLE_BENCH=1 runs it")

const STYLES = ["classic", "terminal"] as const
const RUNS = Number(process.env.STYLE_BENCH_RUNS ?? 6)

function writeResult(result: object): void {
  const stage = process.env.BENCH_STAGE ?? "P06"
  const date = new Date().toISOString().slice(0, 10)
  const file = join(
    repoRoot,
    "src",
    "shared",
    "bench",
    "results",
    `stage-${stage}-${date}-e2e-style-scroll.jsonl`,
  )
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

async function setWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!
    w.unmaximize()
    w.setContentSize(1600, 1000)
  })
}

/** Scrolls the element `selector` names (or its first scrolling descendant) and times the frames. */
function scroll(page: Page, selector: string) {
  return page.evaluate(async (selector) => {
    const host = document.querySelector<HTMLElement>(selector)!
    const el =
      host.scrollHeight > host.clientHeight
        ? host
        : [...host.querySelectorAll<HTMLElement>("*")].find(
            (e) =>
              e.scrollHeight > e.clientHeight + 100 && getComputedStyle(e).overflowY === "auto",
          )!
    el.scrollTop = 0
    await new Promise((r) => setTimeout(r, 300))
    const long: number[] = []
    const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(e.duration)))
    po.observe({ type: "longtask" })
    const gaps: number[] = []
    const run = (ms: number, px: number) =>
      new Promise<void>((resolve) => {
        const start = performance.now()
        let last = start
        const tick = (t: number) => {
          gaps.push(t - last)
          last = t
          el.scrollTop += px
          if (t - start < ms) requestAnimationFrame(tick)
          else resolve()
        }
        requestAnimationFrame(tick)
      })
    await run(2000, 300)
    await run(1000, 12)
    await new Promise((r) => setTimeout(r, 300))
    po.disconnect()
    const sorted = gaps.slice(1).sort((a, b) => a - b)
    return {
      frames: sorted.length,
      meanFrameMs: Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 100) / 100,
      p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
      maxFrameGapMs: Math.round(sorted.at(-1) ?? 0),
      over20ms: sorted.filter((g) => g > 20).length,
      longTasks: long.length,
      longTaskMaxMs: Math.round(Math.max(0, ...long)),
      scrolledPx: Math.round(el.scrollTop),
    }
  }, selector)
}

async function alternate(page: Page, name: string, selector: string): Promise<void> {
  for (let run = 0; run < RUNS; run++) {
    const style = STYLES[run % STYLES.length]!
    await page.evaluate((s) => (document.documentElement.dataset.style = s), style)
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const result = await scroll(page, selector)
    writeResult({ test: name, style, run, ...result })
    expect(result.longTaskMaxMs).toBeLessThan(50)
  }
}

test.describe("design styles while scrolling 10k entries", () => {
  const fx = () => ensureFixture("flat-10k", { files: 10_000, nonMediaEvery: 10 })

  test("the viewer's tile view", async () => {
    test.setTimeout(240_000)
    const { app, page } = await launch("viewer")
    try {
      await setWindow(app)
      await showViewerFolder(page, fx().root)
      await expect(page.getByTestId("folder-summary")).toHaveText(/^9,000 items/, {
        timeout: 60_000,
      })
      // After the shared appearance has loaded, so it does not set the style back.
      await page.waitForTimeout(1000)
      await alternate(page, "viewer-tiles-10k", '[data-testid="tile-view"]')
    } finally {
      await app.close()
    }
  })

  test("the commander's Full view", async () => {
    test.setTimeout(240_000)
    const { app } = await launch("commander")
    try {
      await setWindow(app)
      const c = await commanderOf(app)
      await goTo(c, "left", fx().root)
      await c.waitForTimeout(1000)
      await alternate(c, "commander-full-10k", '[data-testid="grid-left"]')
    } finally {
      await app.close()
    }
  })
})
