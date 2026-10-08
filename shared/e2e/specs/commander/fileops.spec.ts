import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { expect, test, type Page } from "@playwright/test"
import { expectWithinBudget, repoRoot } from "../../launch"
import { commanderOf, cursorTo, goTo, launch, openFolder, type Side } from "./helpers"

// Stage C04: file operations (docs/commander/stages/C04-file-operations.md;
// scenarios 8, 9 and 10 of docs/commander/TESTING.md). Measurements:
// stage-C04-…-e2e-fileops.

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(repoRoot, "shared", "bench", "results", `stage-C04-${date}-e2e-fileops.jsonl`)
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

const grid = (c: Page, side: Side) => c.getByTestId(`grid-${side}`)
const jobRows = (c: Page) => c.getByTestId("queue").locator("li[data-state]")

/** A second volume for cross-volume moves and slow (HDD) copies, when the machine has one. */
function otherVolume(): string | null {
  if (process.platform !== "win32") return null
  for (const d of ["D:\\", "E:\\"])
    if (existsSync(d) && !tmpdir().toUpperCase().startsWith(d)) return d
  return null
}

function bigFile(path: string, mb: number): void {
  const chunk = randomBytes(8 << 20)
  writeFileSync(path, "")
  for (let i = 0; i < mb / 8; i++) appendFileSync(path, chunk)
}

/** Waits until the queue's newest job reaches one of the states; returns it. */
async function lastJobState(c: Page, states: string[], timeout = 60_000) {
  await expect
    .poll(async () => (await jobRows(c).last().getAttribute("data-state")) ?? "", { timeout })
    .toMatch(new RegExp(`^(${states.join("|")})$`))
  return jobRows(c).last()
}

/**
 * Presses Enter in an open copy, move or delete dialog and waits for the new
 * job's row (the queue is kept expanded, oldest first), then for one of the
 * states.
 */
async function confirmJob(c: Page, states: string[], timeout = 60_000) {
  // The queue exists only while jobs do: never wait for it to appear here.
  const expanded = async (): Promise<string | null> =>
    (await c.getByTestId("queue").count()) > 0
      ? c.getByTestId("queue").getAttribute("data-expanded")
      : null
  if ((await expanded()) === "false") await c.keyboard.press("Control+j")
  const before = await jobRows(c).count()
  await c.keyboard.press("Enter")
  await expect.poll(() => jobRows(c).count(), { timeout: 10_000 }).toBeGreaterThan(before)
  if ((await expanded()) === "false") await c.keyboard.press("Control+j")
  return lastJobState(c, states, timeout)
}

test.describe("file operations (Stage C04)", () => {
  test("scenario 8: copy a large file and many small files; pause, resume and cancel remove partial files", async () => {
    test.setTimeout(240_000)
    const src = mkdtempSync(join(tmpdir(), "fastview-c04-src-"))
    const vol = otherVolume()
    const dst = mkdtempSync(join(vol ?? tmpdir(), "fastview-c04-dst-"))
    bigFile(join(src, "big.bin"), vol ? 1024 : 2048)
    mkdirSync(join(src, "small"))
    for (let i = 0; i < 2000; i++)
      writeFileSync(join(src, "small", `s${String(i).padStart(4, "0")}.txt`), randomBytes(10_000))
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", src)
      await openFolder(c, "right", dst)
      // Large file: F5, Enter; pause as soon as bytes move.
      await cursorTo(c, "left", "big")
      await grid(c, "left").focus()
      await c.keyboard.press("F5")
      await expect(c.getByTestId("copy-dialog")).toBeVisible()
      await expect(c.getByRole("dialog")).toContainText("Copy big.bin")
      await expect(c.getByLabel("Destination")).toHaveValue(dst)
      // On APFS the copy is a clone and completes at once: nothing to pause.
      const row = await confirmJob(c, ["running", "completed"])
      let pauseMs = 0
      if ((await row.getAttribute("data-state")) === "running") {
        await row.getByRole("button", { name: "Pause" }).click()
        const pausedAt = Date.now()
        await lastJobState(c, ["paused", "completed"])
        pauseMs = Date.now() - pausedAt
      }
      const state = await row.getAttribute("data-state")
      if (state === "paused") {
        const partial = readdirSync(dst).find((n) => n.endsWith(".fastview-partial"))
        expect(partial, "the partial file is kept while paused").toBeTruthy()
        const size1 = statSync(join(dst, partial!)).size
        await c.waitForTimeout(500)
        expect(statSync(join(dst, partial!)).size).toBe(size1)
        await row.getByRole("button", { name: "Resume" }).click()
      }
      await lastJobState(c, ["completed"], 180_000)
      expect(statSync(join(dst, "big.bin")).size).toBe(statSync(join(src, "big.bin")).size)
      // Cancel mid-copy: a second copy (rename new) is cancelled; nothing is left.
      await grid(c, "left").focus()
      await c.keyboard.press("F5")
      await c.getByLabel("If the name exists").selectOption("renameNew")
      const second = await confirmJob(c, ["running", "completed"])
      if ((await second.getAttribute("data-state")) === "running") {
        await second.getByRole("button", { name: "Cancel" }).click()
        await lastJobState(c, ["cancelled", "completed"])
      }
      if ((await second.getAttribute("data-state")) === "cancelled") {
        await expect
          .poll(() => readdirSync(dst).filter((n) => n.endsWith(".fastview-partial")))
          .toEqual([])
        expect(readdirSync(dst)).not.toContain("big (2).bin")
      }
      // Many small files: the folder "small".
      await cursorTo(c, "left", "small")
      await grid(c, "left").focus()
      await c.keyboard.press("F5")
      await confirmJob(c, ["completed"], 120_000)
      expect(readdirSync(join(dst, "small"))).toHaveLength(2000)
      writeResult({ test: "pause-latency", pauseMs, finalState: state })
    } finally {
      await app.close()
      rmSync(src, { recursive: true, force: true })
      rmSync(dst, { recursive: true, force: true })
    }
  })

  test("scenario 9: each conflict policy from the dialog; ask stops only its own job", async () => {
    test.setTimeout(180_000)
    const root = mkdtempSync(join(tmpdir(), "fastview-c04-conflict-"))
    const src = join(root, "src")
    mkdirSync(src)
    writeFileSync(join(src, "a.txt"), "new content")
    const old = new Date("2020-01-01T00:00:00Z")
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", src)
      const cases: [string, string, (dir: string) => void][] = [
        [
          "replace",
          "Overwrite",
          (d) => expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("new content"),
        ],
        ["skip", "Skip", (d) => expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("old")],
        [
          "replaceOlder",
          "Overwrite older",
          (d) => expect(readFileSync(join(d, "a.txt"), "utf8")).toBe("new content"),
        ],
        [
          "renameNew",
          "Rename new",
          (d) => expect(readFileSync(join(d, "a (2).txt"), "utf8")).toBe("new content"),
        ],
        [
          "renameExisting",
          "Rename existing",
          (d) => expect(readFileSync(join(d, "a (2).txt"), "utf8")).toBe("old"),
        ],
      ]
      for (const [policy, label, check] of cases) {
        const dst = join(root, `dst-${policy}`)
        mkdirSync(dst)
        writeFileSync(join(dst, "a.txt"), "old")
        const { utimesSync } = await import("node:fs")
        utimesSync(join(dst, "a.txt"), old, old)
        await openFolder(c, "right", dst)
        await cursorTo(c, "left", "a")
        await grid(c, "left").focus()
        await c.keyboard.press("F5")
        await c.getByLabel("If the name exists").selectOption({ label })
        await confirmJob(c, ["completed"])
        check(dst)
      }
      // ask: the dialog stops this job; another job runs to its end meanwhile.
      const askDst = join(root, "dst-ask")
      mkdirSync(askDst)
      writeFileSync(join(askDst, "a.txt"), "old")
      const freeDst = join(root, "dst-free")
      mkdirSync(freeDst)
      await openFolder(c, "right", askDst)
      await cursorTo(c, "left", "a")
      await grid(c, "left").focus()
      await c.keyboard.press("F5")
      await c.keyboard.press("Enter") // the default policy is Ask
      await expect(c.getByTestId("conflict-dialog")).toBeVisible()
      await expect(c.getByRole("dialog")).toContainText("“a.txt” already exists")
      await c.keyboard.press("Escape") // the question waits in the queue
      await expect(jobRows(c).last()).toHaveAttribute("data-state", "asking")
      await openFolder(c, "right", freeDst)
      await cursorTo(c, "left", "a")
      await grid(c, "left").focus()
      await c.keyboard.press("F5")
      await c.keyboard.press("Enter")
      await expect.poll(() => existsSync(join(freeDst, "a.txt"))).toBe(true)
      await c.keyboard.press("Control+j")
      const asking = c.getByTestId("queue").locator('li[data-state="asking"]')
      await expect(asking).toHaveCount(1)
      await asking.getByRole("button", { name: "Needs your decision" }).click()
      await c
        .getByTestId("conflict-dialog")
        .getByRole("button", { name: "Overwrite", exact: true })
        .click()
      await expect(c.getByTestId("queue").locator('li[data-state="asking"]')).toHaveCount(0)
      await expect.poll(() => readFileSync(join(askDst, "a.txt"), "utf8")).toBe("new content")
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("scenario 10: move across volumes, rename in place, nested new folder, delete with confirmation", async () => {
    test.setTimeout(180_000)
    const root = mkdtempSync(join(tmpdir(), "fastview-c04-misc-"))
    const vol = otherVolume()
    const away = mkdtempSync(join(vol ?? tmpdir(), "fastview-c04-away-"))
    writeFileSync(join(root, "move-me.txt"), "moved")
    writeFileSync(join(root, "photo.jpg"), "jpg")
    writeFileSync(join(root, "gone.txt"), "x")
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", root)
      await openFolder(c, "right", away)
      // F6 across volumes (Shift+drag would do the same).
      await cursorTo(c, "left", "move-me")
      await grid(c, "left").focus()
      await c.keyboard.press("F6")
      await expect(c.getByRole("dialog")).toContainText("Move move-me.txt")
      await confirmJob(c, ["completed"])
      expect(existsSync(join(root, "move-me.txt"))).toBe(false)
      expect(readFileSync(join(away, "move-me.txt"), "utf8")).toBe("moved")
      await expect(grid(c, "right").locator("[data-id]", { hasText: "move-me" })).toHaveCount(1)
      // F2: rename in place; the name is selected without the extension.
      await cursorTo(c, "left", "photo")
      await grid(c, "left").focus()
      await c.keyboard.press("F2")
      const field = c.getByTestId("rename-field")
      await expect(field).toBeFocused()
      await c.keyboard.type("beach") // replaces "photo", keeps ".jpg"
      await c.keyboard.press("Enter")
      await expect.poll(() => existsSync(join(root, "beach.jpg"))).toBe(true)
      await expect(grid(c, "left").locator("[data-cursor=true]")).toContainText("beach")
      // F7: a nested chain; the cursor lands on its first folder.
      await c.keyboard.press("F7")
      await c.getByLabel("Folder name").fill("2026/Trip/Raw")
      await c.keyboard.press("Enter")
      await expect.poll(() => existsSync(join(root, "2026", "Trip", "Raw"))).toBe(true)
      await expect(grid(c, "left").locator("[data-cursor=true]")).toContainText("2026")
      // F8: the trash dialog (cancelled here: the e2e run leaves the recycle bin alone).
      await cursorTo(c, "left", "gone")
      await grid(c, "left").focus()
      await c.keyboard.press("F8")
      await expect(c.getByRole("dialog")).toContainText("Move gone.txt to the trash?")
      await c.keyboard.press("Escape")
      await expect(grid(c, "left")).toBeFocused()
      expect(existsSync(join(root, "gone.txt"))).toBe(true)
      // Shift+Delete: permanent, after confirmation.
      await c.keyboard.press("Shift+Delete")
      await expect(c.getByRole("dialog")).toContainText("Delete gone.txt permanently?")
      await c.keyboard.press("Enter")
      await expect.poll(() => existsSync(join(root, "gone.txt"))).toBe(false)
      await expect(grid(c, "left").locator("[data-id]", { hasText: "gone" })).toHaveCount(0)
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
      rmSync(away, { recursive: true, force: true })
    }
  })

  test("benchmark: copies from the UI; long tasks and navigation while copying", async () => {
    test.setTimeout(400_000)
    const src = mkdtempSync(join(tmpdir(), "fastview-c04-bench-"))
    const dst = mkdtempSync(join(tmpdir(), "fastview-c04-bench-dst-"))
    mkdirSync(join(src, "small"))
    for (let i = 0; i < 10_000; i++)
      writeFileSync(join(src, "small", `f${String(i).padStart(5, "0")}.bin`), randomBytes(10_000))
    bigFile(join(src, "big.bin"), 2048)
    const nav = mkdtempSync(join(tmpdir(), "fastview-c04-nav-"))
    for (let i = 0; i < 1000; i++)
      writeFileSync(join(nav, `n${String(i).padStart(4, "0")}.txt`), "")
    // The fixtures were just written: let the drive flush them, or that
    // write-back lands in the first copy's time (see Stage P03's record).
    await new Promise((r) => setTimeout(r, 30_000))
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", src)
      await openFolder(c, "right", dst)
      const measure = async (name: string) => {
        await cursorTo(c, "left", name)
        await grid(c, "left").focus()
        await c.keyboard.press("F5")
        await expect(c.getByTestId("copy-dialog")).toBeVisible()
        // Long tasks and key latency in the right panel while the copy runs.
        const watch = c.evaluate(() => {
          const long: number[] = []
          const po = new PerformanceObserver((l) =>
            l.getEntries().forEach((e) => long.push(e.duration)),
          )
          po.observe({ type: "longtask" })
          ;(window as unknown as { __stopWatch: () => number[] }).__stopWatch = () => {
            po.disconnect()
            return long
          }
        })
        await watch
        const t0 = Date.now()
        await confirmJob(c, ["running", "completed"])
        // Navigate the other panel meanwhile: a folder and keys.
        const keyMs = await c.evaluate(async () => {
          const right = document.querySelector<HTMLElement>('[data-testid="grid-left"]')! // the source panel has rows
          right.focus()
          const out: number[] = []
          for (let i = 0; i < 20; i++) {
            const before = right.getAttribute("aria-activedescendant")
            const k0 = performance.now()
            right.dispatchEvent(
              new KeyboardEvent("keydown", { key: i % 2 ? "ArrowDown" : "ArrowUp", bubbles: true }),
            )
            await new Promise<void>((r) => {
              const tick = (): void => {
                if (
                  right.getAttribute("aria-activedescendant") !== before ||
                  performance.now() - k0 > 500
                )
                  r()
                else requestAnimationFrame(tick)
              }
              requestAnimationFrame(tick)
            })
            out.push(performance.now() - k0)
          }
          return out
        })
        await lastJobState(c, ["completed"], 240_000)
        const ms = Date.now() - t0
        const long = await c.evaluate(() =>
          (window as unknown as { __stopWatch: () => number[] }).__stopWatch(),
        )
        rmSync(join(dst, name.startsWith("small") ? "small" : "big.bin"), {
          recursive: true,
          force: true,
        })
        await c.waitForTimeout(10_000) // let the copy flush before the next one
        const sorted = keyMs.sort((a, b) => a - b)
        return {
          copyMs: ms,
          longTasks: long.length,
          longTaskMaxMs: Math.round(Math.max(0, ...long)),
          keyP95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)]!),
          keyMaxMs: Math.round(sorted.at(-1)!),
        }
      }
      const small = await measure("small")
      const big = await measure("big")
      // Panel navigation during a copy: enter a 1k folder in the right panel.
      await cursorTo(c, "left", "small")
      await grid(c, "left").focus()
      await c.keyboard.press("F5")
      await confirmJob(c, ["running", "completed"])
      const enterMs = await goTo(c, "right", nav)
      await lastJobState(c, ["completed"], 240_000)
      writeResult({
        test: "copy-from-ui",
        small10k: small,
        large2GB: big,
        enter1kWhileCopyingMs: Math.round(enterMs),
      })
      expectWithinBudget(small.longTasks + big.longTasks, 1, "C04 long tasks while copying")
    } finally {
      await app.close()
      for (const d of [src, dst, nav]) rmSync(d, { recursive: true, force: true })
    }
  })
})
