import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommanderApi } from "@fastview/contracts"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { expectWithinBudget, repoRoot } from "../../launch"
import { commanderOf, cursorTo, goTo, launch } from "./helpers"

// Stage C05: quick view, lister, open and edit
// (docs/commander/stages/C05-quick-view-and-lister.md; scenario 11 and the
// safety tests of docs/commander/TESTING.md). Measurements:
// stage-C05-…-e2e-viewers.

const GIB = 1024 ** 3

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(repoRoot, "shared", "bench", "results", `stage-C05-${date}-e2e-viewers.jsonl`)
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

/** text-2g and encodings (cached once per machine by fixturegen). */
const textFixture = () =>
  ensureFixture("text-2g", { files: 0, text: { logBytes: 2 * GIB, encodings: true } }).root
const imageFixture = () =>
  ensureFixture("c05-images", { files: 0, images: { count: 40, width: 1600, height: 1200 } }).root

const SAMPLE = "Grüße aus Köln — naïve café"
const IS_WINDOWS = process.platform === "win32"

const lister = (c: Page) => c.getByTestId("lister")

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** The left panel's row of a file: its name and extension cells match exactly. */
function fileRow(c: Page, name: string) {
  const dot = name.lastIndexOf(".")
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot + 1)] : [name, ""]
  const cell = (n: number, text: string) =>
    c.locator(`[role=gridcell]:nth-child(${n})`, { hasText: new RegExp(`^${escape(text)}$`) })
  return c
    .getByTestId("grid-left")
    .locator("[data-id]")
    .filter({ has: cell(2, base) })
    .filter({ has: cell(3, ext) })
}

async function cursorToFile(c: Page, name: string): Promise<void> {
  const row = fileRow(c, name)
  await row.click()
  const id = await row.getAttribute("data-id")
  await expect(c.getByTestId("grid-left").locator("[data-cursor=true]")).toHaveAttribute(
    "data-id",
    id!,
  )
}
const shellLog = (app: ElectronApplication) =>
  app.evaluate(
    () =>
      (globalThis as unknown as { __fastviewShellLog: { action: string; value: string }[] })
        .__fastviewShellLog,
  )

async function openInLister(c: Page, name: string): Promise<void> {
  await cursorToFile(c, name)
  await c.keyboard.press("F3")
  await expect(lister(c)).toBeVisible()
}

async function closeLister(c: Page): Promise<void> {
  await c.keyboard.press("Escape")
  await expect(lister(c)).toHaveCount(0)
}

test.describe("quick view and lister (Stage C05)", () => {
  test("scenario 11: text in each encoding, binary, long lines and a 2 GB log", async () => {
    test.setTimeout(300_000)
    const root = textFixture()
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", root)
      for (const [name, encoding] of [
        ["utf8.txt", "utf-8"],
        ["utf8-bom.txt", "utf-8"],
        ["utf16le.txt", "utf-16le"],
        ["utf16be.txt", "utf-16be"],
        ["latin1.txt", "windows-1252"],
      ] as const) {
        await openInLister(c, name)
        await expect(lister(c)).toHaveAttribute("data-mode", "text")
        await expect(lister(c).getByLabel("Encoding")).toHaveValue(encoding)
        const text = lister(c).getByTestId("text-view")
        await expect(text.locator("[data-offset]").first()).toHaveText(SAMPLE)
        await expect(text.locator("[data-offset]")).toHaveCount(3)
        await closeLister(c)
      }
      // Binary starts in hex.
      await openInLister(c, "binary.bin")
      await expect(lister(c)).toHaveAttribute("data-mode", "hex")
      await expect(lister(c).getByTestId("hex-view")).toContainText("00000000")
      await expect(lister(c).getByTestId("hex-view")).toContainText("00 25 4a 6f 94 b9 de 03")
      await closeLister(c)
      // A 100 KB single line: segments without wrap, all of it with wrap.
      await openInLister(c, "long-line.txt")
      await expect(lister(c).getByTestId("text-view")).toHaveAttribute("data-wrap", "false")
      await c.keyboard.press("w")
      await expect(lister(c).getByTestId("text-view")).toHaveAttribute("data-wrap", "true")
      await c.keyboard.press("w")
      await closeLister(c)
      // Empty file.
      await openInLister(c, "empty.txt")
      await expect(lister(c)).toHaveAttribute("data-mode", "text")
      await closeLister(c)

      // The 2 GB log: first screen, End, find, N / P, Esc keeps the cursor.
      await openInLister(c, "big.log")
      const view = lister(c).getByTestId("text-view")
      await expect(view.locator("[data-offset]").first()).toContainText("000000000 2026-10-06")
      await c.keyboard.press("End")
      await expect(lister(c).getByTestId("lister-position")).toHaveText("100%")
      const size = statSync(join(root, "big.log")).size
      expect(Number(await view.getAttribute("data-top"))).toBeGreaterThan(size - 64 * 1024)
      await c.keyboard.press("Home")
      await expect(view.locator("[data-offset]").first()).toContainText("000000000")
      await c.keyboard.press("Control+f")
      await lister(c).getByLabel("Find", { exact: true }).fill("000123456 2026")
      await c.keyboard.press("Enter")
      await expect(view.getByTestId("find-mark")).toHaveText("000123456 2026", { timeout: 20_000 })
      await c.keyboard.press("Escape") // the find bar
      await c.keyboard.press("n") // binary.bin comes after big.log
      await expect(lister(c)).toHaveAttribute("data-mode", "hex")
      await closeLister(c)
      await expect(c.getByTestId("grid-left").locator("[data-cursor=true]")).toHaveAttribute(
        "data-id",
        (await fileRow(c, "big.log").getAttribute("data-id"))!,
      )
    } finally {
      await app.close()
    }
  })

  test("scenario 11: quick view follows the cursor (text, hex, images)", async () => {
    test.setTimeout(120_000)
    const text = textFixture()
    const images = imageFixture()
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", text)
      await cursorToFile(c, "utf16le.txt")
      await c.keyboard.press("Control+q")
      const quick = c.getByTestId("quick-view")
      await expect(quick.getByTestId("text-view").locator("[data-offset]").first()).toHaveText(
        SAMPLE,
      )
      await cursorToFile(c, "binary.bin")
      await expect(quick.getByTestId("hex-view")).toContainText("00 25 4a 6f")
      await expect(quick.getByTestId("quick-properties")).toContainText("4,096 bytes")
      await goTo(c, "left", images)
      await cursorTo(c, "left", "photo_0003")
      await expect(quick.getByTestId("image-viewer")).toHaveAttribute("data-layer", /fit|original/)
      await c.keyboard.press("Control+q")
      await expect(quick).toHaveCount(0)
      await expect(c.getByTestId("panel-right")).toBeVisible()
    } finally {
      await app.close()
    }
  })

  test("safety: programs ask first, shell actions are recorded, the viewer still cannot open non-media", async () => {
    test.setTimeout(120_000)
    const root = textFixture()
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      // The viewer's page by its origin: firstWindow() may be either app's view.
      const viewer = app.windows().find((p) => p.url().startsWith("app://fastview"))!
      expect(viewer).toBeDefined()
      await goTo(c, "left", root)
      const before = (await shellLog(app)).length

      // A program (tool.cmd on Windows, tool.sh elsewhere) never runs on Enter without the confirmation.
      const program = IS_WINDOWS ? "tool.cmd" : "tool.sh"
      await cursorToFile(c, program)
      await c.keyboard.press("Enter")
      const dialog = c.getByTestId("program-dialog")
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused()
      await c.keyboard.press("Enter") // Cancel has the focus
      await expect(dialog).toHaveCount(0)
      expect((await shellLog(app)).length).toBe(before)
      await expect(c.getByTestId("grid-left")).toBeFocused()
      await c.keyboard.press("Enter")
      await c.getByTestId("program-dialog").getByRole("button", { name: "Run" }).click()
      await expect
        .poll(async () => (await shellLog(app)).at(-1)?.value ?? "")
        .toMatch(new RegExp(`${program.replace(".", "\\.")}$`))
      expect((await shellLog(app)).at(-1)!.action).toBe("open")

      // A document opens with its default app (recorded); F4 starts the editor without a shell.
      await cursorToFile(c, "utf8.txt")
      await c.keyboard.press("Enter")
      await expect.poll(async () => (await shellLog(app)).at(-1)?.value ?? "").toMatch(/utf8\.txt$/)
      await c.keyboard.press("F4")
      const edit = IS_WINDOWS
        ? /^notepad\.exe\|.*utf8\.txt$/
        : process.platform === "darwin"
          ? /^open\|-t\|.*utf8\.txt$/
          : /utf8\.txt$/
      await expect.poll(async () => (await shellLog(app)).at(-1)?.value ?? "").toMatch(edit)

      // The id of a text file, as the commander sees it.
      const textId = Number(await fileRow(c, "utf8.txt").getAttribute("data-id"))
      // The commander's token for the file: readable by the commander only.
      const token = await c.evaluate(async (id) => {
        const r = await (window.fastview as unknown as CommanderApi).file.open(id)
        if (!r.ok) throw new Error(r.e.message)
        const res = await fetch(r.r.url, { headers: { Range: "bytes=0-4" } })
        return { url: r.r.url, status: res.status, body: await res.text() }
      }, textId)
      expect(token.status).toBe(206)
      expect(token.body.startsWith("Grü")).toBe(true)

      // The viewer's view: no file.open, no shell.edit, and shell.open / media.open refuse the text file.
      const fromViewer = await viewer.evaluate(
        async ({ id, url }) => {
          const api = window.fastview as unknown as Record<string, Record<string, unknown>>
          const open = await (
            api.shell!.open as (id: number) => Promise<{ ok: boolean; e?: { message: string } }>
          )(id)
          const media = await (api.media!.open as (id: number) => Promise<{ ok: boolean }>)(id)
          let fetched = "ok"
          try {
            await fetch(url, { headers: { Range: "bytes=0-4" } })
          } catch {
            fetched = "blocked"
          }
          return {
            file: typeof api.file,
            edit: typeof api.shell?.edit,
            open: open.ok,
            openMessage: open.e?.message ?? "",
            media: media.ok,
            fetched,
          }
        },
        { id: textId, url: token.url },
      )
      expect(fromViewer).toMatchObject({
        file: "undefined",
        edit: "undefined",
        open: false,
        media: false,
        fetched: "blocked",
      })
      expect(fromViewer.openMessage).toMatch(/cannot be opened from the viewer/)
    } finally {
      await app.close()
    }
  })

  test("bench: quick view follow, lister open and scroll on text-2g, memory while scrolling", async () => {
    test.setTimeout(300_000)
    const text = textFixture()
    const images = imageFixture()
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)

      // Quick view follow: one pass to fill the preview cache, then a measured pass.
      await goTo(c, "left", images)
      await cursorTo(c, "left", "photo_0000")
      await c.keyboard.press("Control+q")
      const follow = (count: number) =>
        c.evaluate(async (count) => {
          const grid = document.querySelector<HTMLElement>('[data-testid="grid-left"]')!
          const times: number[] = []
          for (let i = 0; i < count; i++) {
            const quick = document.querySelector<HTMLElement>('[data-testid="quick-view"]')!
            const before = quick.dataset.entry
            grid.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
            const t0 = performance.now()
            await new Promise<void>((resolve, reject) => {
              const tick = (): void => {
                const q = document.querySelector<HTMLElement>('[data-testid="quick-view"]')
                const layer = q?.querySelector<HTMLElement>('[data-testid="image-viewer"]')?.dataset
                  .layer
                if (q && q.dataset.entry !== before && (layer === "fit" || layer === "original"))
                  resolve()
                else if (performance.now() - t0 > 15_000) reject(new Error("image not shown"))
                else requestAnimationFrame(tick)
              }
              requestAnimationFrame(tick)
            })
            // The budget starts when the cursor has settled (150 ms after the key).
            times.push(performance.now() - t0 - 150)
          }
          return times
        }, count)
      await follow(30)
      await c.keyboard.press("Home")
      await cursorTo(c, "left", "photo_0000")
      const settled = (await follow(30)).sort((a, b) => a - b)
      const quickP95 = Math.round(settled[Math.floor(settled.length * 0.95)]!)
      await c.keyboard.press("Control+q")

      // Lister: open the 2 GB log, End, 200 × PageDown, jumps by the scroll bar.
      await goTo(c, "left", text)
      await cursorToFile(c, "big.log")
      const result = await c.evaluate(async () => {
        const wait = (test: () => boolean, ms = 15_000) =>
          new Promise<void>((resolve, reject) => {
            const t0 = performance.now()
            const tick = (): void => {
              if (test()) resolve()
              else if (performance.now() - t0 > ms) reject(new Error("timeout"))
              else requestAnimationFrame(tick)
            }
            tick()
          })
        const view = () =>
          document.querySelector<HTMLElement>('[data-testid="lister"] [data-testid="text-view"]')
        const heap = () =>
          (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
            ?.usedJSHeapSize ?? 0
        const long: number[] = []
        const po = new PerformanceObserver((l) =>
          l.getEntries().forEach((e) => long.push(e.duration)),
        )
        po.observe({ type: "longtask" })
        const heapBefore = heap()
        const grid = document.querySelector<HTMLElement>('[data-testid="grid-left"]')!
        let t0 = performance.now()
        grid.dispatchEvent(new KeyboardEvent("keydown", { key: "F3", bubbles: true }))
        await wait(() =>
          (view()?.querySelector("[data-offset]")?.textContent ?? "").startsWith("000000000"),
        )
        const openMs = performance.now() - t0
        const key = (k: string) =>
          view()!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }))
        t0 = performance.now()
        key("End")
        await wait(
          () => document.querySelector('[data-testid="lister-position"]')?.textContent === "100%",
        )
        const endMs = performance.now() - t0
        key("Home")
        await wait(() => view()!.dataset.top === "0")
        const pageTimes: number[] = []
        for (let i = 0; i < 200; i++) {
          const top = view()!.dataset.top
          const t = performance.now()
          key("PageDown")
          await wait(() => view()!.dataset.top !== top)
          pageTimes.push(performance.now() - t)
        }
        const bar = view()!.parentElement!.querySelector<HTMLElement>(
          '[data-testid="byte-scrollbar"]',
        )!
        const r = bar.getBoundingClientRect()
        const jumpTimes: number[] = []
        for (const f of [0.1, 0.9, 0.3, 0.7, 0.5, 0.05, 0.95, 0.42, 0.66, 0.2]) {
          const top = view()!.dataset.top
          const t = performance.now()
          bar.dispatchEvent(
            new PointerEvent("pointerdown", {
              bubbles: true,
              clientX: r.left + r.width / 2,
              clientY: r.top + r.height * f,
              pointerId: 1,
            }),
          )
          await wait(() => view()!.dataset.top !== top)
          jumpTimes.push(performance.now() - t)
        }
        await new Promise((r) => setTimeout(r, 300))
        po.disconnect()
        const p95 = (xs: number[]) => {
          const s = [...xs].sort((a, b) => a - b)
          return Math.round(s[Math.floor(s.length * 0.95)] ?? 0)
        }
        return {
          openMs: Math.round(openMs),
          endMs: Math.round(endMs),
          pageDownP95Ms: p95(pageTimes),
          jumpP95Ms: p95(jumpTimes),
          longTasks: long.length,
          longTaskMaxMs: Math.round(Math.max(0, ...long)),
          heapBeforeMb: Math.round(heapBefore / 1e5) / 10,
          heapAfterMb: Math.round(heap() / 1e5) / 10,
        }
      })
      const metrics = await app.evaluate(({ app }) =>
        app.getAppMetrics().map((m) => ({ type: m.type, kb: m.memory.workingSetSize })),
      )
      const record = {
        test: "viewers",
        quickViewFollow: { samples: settled.length, p95Ms: quickP95 },
        lister2g: { ...result, size: statSync(join(text, "big.log")).size },
        rendererWorkingSetMb: Math.round(
          Math.max(...metrics.filter((m) => m.type === "Tab").map((m) => m.kb)) / 1024,
        ),
      }
      writeResult(record)
      console.log(JSON.stringify(record))
      // Budgets (docs/commander/PERFORMANCE.md "Viewers and tools").
      expectWithinBudget(quickP95, 100, "C05 quick view follow p95 (ms)")
      expectWithinBudget(result.openMs, 200, "C05 lister open on 2 GB (ms)")
      expect(result.heapAfterMb - result.heapBeforeMb).toBeLessThan(32)
    } finally {
      await app.close()
    }
  })
})

test("the token protocol refuses fetch() from another origin and never exposes paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fastview-c05-"))
  writeFileSync(join(dir, "a.txt"), "hello")
  const { app } = await launch("commander")
  try {
    const c = await commanderOf(app)
    await goTo(c, "left", dir)
    const id = Number(await fileRow(c, "a.txt").getAttribute("data-id"))
    const r = await c.evaluate(async (id) => {
      const res = await (window.fastview as unknown as CommanderApi).file.open(id)
      return res.ok ? res.r : null
    }, id)
    expect(r).toMatchObject({ kind: "file", mime: "application/octet-stream", sizeBytes: 5 })
    expect(JSON.stringify(r)).not.toContain(dir)
    // Another origin (the viewer's) is refused by the protocol itself.
    const status = await app.evaluate(async ({ net }, url) => {
      const res = await net.fetch(url, { headers: { Origin: "app://fastview" } })
      return res.status
    }, r!.url)
    expect(status).toBe(403)
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
