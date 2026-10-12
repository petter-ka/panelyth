import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { expectWithinBudget, repoRoot } from "../../launch"
import { commanderOf, cursorTo, goTo, launch, type Side } from "./helpers"

// Stage C09: multi-rename with its preview and undo, attributes and dates,
// properties (docs/commander/stages/C09-multi-rename-and-attributes.md;
// scenario 15 of docs/commander/TESTING.md). Measurements go to
// stage-C09-…-e2e-rename.

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(
    repoRoot,
    "src",
    "shared",
    "bench",
    "results",
    `stage-C09-${date}-e2e-rename.jsonl`,
  )
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

const grid = (c: Page, side: Side) => c.getByTestId(`grid-${side}`)
const names = (dir: string): string[] => readdirSync(dir).sort()

/** The context menu of a panel's cursor entry (the Menu key), and one of its commands. */
async function menu(c: Page, side: Side, command: string): Promise<void> {
  await grid(c, side).focus()
  await grid(c, side).evaluate((el) =>
    (el.querySelector("[data-cursor=true]") ?? el.firstElementChild ?? el).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 0 }),
    ),
  )
  await c.getByRole("menuitem", { name: command }).click()
}

/** The preview's mounted rows as "old | new | status". */
const previewRows = (c: Page) =>
  c
    .getByTestId("rename-preview")
    .locator("[role=row]")
    .evaluateAll((rows) =>
      rows.map((r) =>
        [...r.querySelectorAll("[role=cell]")]
          .map((cell) => cell.textContent ?? "")
          .filter((text) => text !== "")
          .join(" | "),
      ),
    )

test.describe("multi-rename, attributes and properties (Stage C09)", () => {
  test("scenario 15: multi-rename preview, apply, undo; dates and properties", async () => {
    test.setTimeout(180_000)
    const fixture = ensureFixture("rename-set-c09", { files: 0, rename: { scenario: true } })
    // The test renames the files: it works on a copy (with the fixture's dates).
    const root = mkdtempSync(join(tmpdir(), "panelyth-c09-"))
    cpSync(join(fixture.root, "scenario"), root, { recursive: true, preserveTimestamps: true })
    const original = names(root)
    expect(original).toEqual([
      "Album",
      "IMG_0001.JPG",
      "IMG_0002.JPG",
      "IMG_0003.JPG",
      "notes.txt",
      "taken.txt",
    ])
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", root)

      // The three pictures, marked; Ctrl+M shows them as they are.
      await cursorTo(c, "left", "IMG_0001")
      for (let i = 0; i < 3; i++) await c.keyboard.press("Insert")
      await c.keyboard.press("Control+m")
      const dialog = c.getByTestId("multi-rename-dialog")
      await expect.poll(() => previewRows(c)).toHaveLength(3)
      await expect(c.getByTestId("rename-summary")).toHaveText("0 of 3 names will change")
      const start = dialog.getByRole("button", { name: "Start" })
      await expect(start).toBeDisabled()

      // Names that are not free are said so, and nothing can be started.
      await dialog.getByLabel("Name mask").fill("taken")
      await dialog.getByLabel("Extension mask").fill("txt")
      await expect
        .poll(() => previewRows(c))
        .toEqual([
          "IMG_0001.JPG | taken.txt | Same name twice",
          "IMG_0002.JPG | taken.txt | Same name twice",
          "IMG_0003.JPG | taken.txt | Same name twice",
        ])
      await expect(start).toBeDisabled()
      // One of them alone would still take the name of a file that stays.
      await dialog.getByLabel("Name mask").fill("taken[C]")
      await dialog.getByLabel("Start at").fill("0")
      await dialog.getByLabel("Search for").fill("taken0")
      await dialog.getByLabel("Replace with").fill("taken")
      await expect
        .poll(() => previewRows(c))
        .toEqual([
          "IMG_0001.JPG | taken.txt | Name is taken",
          "IMG_0002.JPG | taken1.txt",
          "IMG_0003.JPG | taken2.txt",
        ])
      await expect(c.getByTestId("rename-summary")).toHaveText(
        "2 of 3 names will change · 1 name is not free",
      )
      // A mask that cannot be used says why.
      await dialog.getByLabel("Name mask").fill("[N")
      await expect(dialog.getByRole("alert")).toContainText("a [ has no ]")
      await expect(start).toBeDisabled()

      // The date of each picture, text, and a counter from 10 in steps of 5.
      await dialog.getByLabel("Search for").fill("")
      await dialog.getByLabel("Replace with").fill("")
      await dialog.getByLabel("Extension mask").fill("[E]")
      await dialog.getByLabel("Name mask").fill("[Y]-[M]-[D] Trip ")
      await dialog.getByRole("button", { name: "[C]" }).click()
      await expect(dialog.getByLabel("Name mask")).toHaveValue("[Y]-[M]-[D] Trip [C]")
      await dialog.getByLabel("Start at").fill("10")
      await dialog.getByLabel("Step").fill("5")
      await dialog.getByLabel("Digits").fill("3")
      await dialog.getByLabel("Case", { exact: true }).selectOption("lower")
      await expect(c.getByTestId("rename-summary")).toHaveText("3 of 3 names will change")
      const rows = await previewRows(c)
      expect(rows[0]).toMatch(/^IMG_0001\.JPG \| \d{4}-\d\d-\d\d trip 010\.jpg$/)
      expect(rows[2]).toMatch(/^IMG_0003\.JPG \| \d{4}-\d\d-\d\d trip 020\.jpg$/)
      await start.click()
      await expect(dialog).toHaveCount(0)
      await expect(c.getByTestId("files-notice")).toHaveText("Renamed 3 items.", {
        timeout: 30_000,
      })
      const renamed = names(root)
      expect(renamed.filter((n) => /^\d{4}-\d\d-\d\d trip 0(10|15|20)\.jpg$/.test(n))).toHaveLength(
        3,
      )
      expect(renamed.some((n) => n.startsWith("IMG_"))).toBe(false)
      // The panel shows the new names; the marks are gone.
      await expect(grid(c, "left").locator("[data-id]", { hasText: "trip 010" })).toHaveCount(1)
      await expect(grid(c, "left").locator("[data-marked=true]")).toHaveCount(0)

      // Undo last: offered whatever the tool is opened for.
      await cursorTo(c, "left", "notes")
      await c.keyboard.press("Control+m")
      await dialog.getByRole("button", { name: "Undo last" }).click()
      await expect(dialog).toHaveCount(0)
      await expect(c.getByTestId("files-notice")).toHaveText("3 names are back.", {
        timeout: 30_000,
      })
      expect(names(root)).toEqual(original)
      await expect(grid(c, "left").locator("[data-id]", { hasText: "IMG_0002" })).toHaveCount(1)
      // One level: the button is gone.
      await c.keyboard.press("Control+m")
      await expect.poll(() => previewRows(c)).toHaveLength(1)
      await expect(dialog.getByRole("button", { name: "Undo last" })).toHaveCount(0)
      await c.keyboard.press("Escape")
      await expect(dialog).toHaveCount(0)
      await expect(grid(c, "left")).toBeFocused()

      // Change attributes: a new modified date for the notes.
      await cursorTo(c, "left", "notes")
      await menu(c, "left", "Change attributes…")
      const attributes = c.getByTestId("attributes-dialog")
      await expect(c.getByTestId("attributes-current")).toContainText("Now:")
      await attributes.getByLabel("Modified").fill("2021-04-05T06:07:08")
      await attributes.getByRole("button", { name: "Change", exact: true }).click()
      await expect(attributes).toHaveCount(0)
      await expect(c.getByTestId("files-notice")).toHaveText("Changed 1 item.", { timeout: 30_000 })
      expect(statSync(join(root, "notes.txt")).mtime.getTime()).toBe(
        new Date(2021, 3, 5, 6, 7, 8).getTime(),
      )

      // Properties (Alt+Enter): the entry as it is now, with its attributes.
      await grid(c, "left").focus()
      await c.keyboard.press("Alt+Enter")
      const properties = c.getByTestId("properties")
      await expect(properties.getByTestId("props-path")).toHaveText(join(root, "notes.txt"))
      await expect(properties.getByTestId("props-attrs")).not.toBeEmpty()
      await expect(properties).toContainText("9 B (9 bytes)")
      // Its checksum button leads to the checksum dialog.
      await c.getByRole("button", { name: "Checksums…" }).click()
      await expect(c.getByTestId("checksum-dialog")).toBeVisible()
      await c.keyboard.press("Escape")
      await expect(c.getByTestId("checksum-dialog")).toHaveCount(0)
      expect(existsSync(join(root, "notes.txt"))).toBe(true)
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("10k files: the preview follows typing and a rename keeps the UI responsive (benchmark)", async () => {
    test.setTimeout(600_000)
    const fixture = ensureFixture("rename-10k-c09", {
      files: 0,
      rename: { files: 10_000, folders: 1_000 },
    })
    const root = mkdtempSync(join(tmpdir(), "panelyth-c09-bench-"))
    cpSync(join(fixture.root, "files"), root, { recursive: true, preserveTimestamps: true })
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", root)
      // The whole folder is listed before it is marked.
      await expect(c.getByTestId("status-left")).toContainText("10,000", { timeout: 60_000 })
      await cursorTo(c, "left", "IMG_000001")
      await c.keyboard.press("Control+a")
      await expect(c.getByTestId("status-left")).toContainText("10,000 of 10,000 marked")

      // Ctrl+M → the first rows of the preview (in-page clock).
      const openMs = await c.evaluate(() => {
        const g = document.querySelector<HTMLElement>('[data-testid="grid-left"]')!
        g.focus()
        const t0 = performance.now()
        g.dispatchEvent(new KeyboardEvent("keydown", { key: "m", ctrlKey: true, bubbles: true }))
        return new Promise<number>((resolve, reject) => {
          const tick = (): void => {
            if (document.querySelector('[data-testid="rename-preview"] [role=cell]'))
              resolve(performance.now() - t0)
            else if (performance.now() - t0 > 30_000) reject(new Error("no preview"))
            else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
      })
      await expect(c.getByTestId("rename-summary")).toHaveText("0 of 10,000 names will change")
      const mounted = await c.getByTestId("rename-preview").locator("[role=row]").count()
      expect(mounted).toBeLessThan(80)

      // A key press in the mask → the visible rows show the new names.
      const typed = await c.evaluate(async () => {
        const input = document.querySelector<HTMLInputElement>('input[aria-label="Name mask"]')!
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
        const table = document.querySelector('[data-testid="rename-preview"]')!
        const firstNew = (): string =>
          table.querySelectorAll("[role=row]")[0]?.querySelectorAll("[role=cell]")[1]
            ?.textContent ?? ""
        const out: number[] = []
        let mask = "[Y]-[M]-[D] [N] "
        for (const ch of "holiday-2024-[C:5]".split("")) {
          mask += ch
          const before = firstNew()
          const t0 = performance.now()
          setValue.call(input, mask)
          input.dispatchEvent(new Event("input", { bubbles: true }))
          await new Promise<void>((resolve, reject) => {
            const observer = new MutationObserver(() => {
              if (firstNew() !== before) {
                observer.disconnect()
                resolve()
              }
            })
            observer.observe(table, { subtree: true, childList: true, characterData: true })
            setTimeout(() => {
              observer.disconnect()
              // A key that leaves the mask unusable ("[", "[C") changes no row.
              if (firstNew() === before) resolve()
              else reject(new Error("the preview did not follow"))
            }, 400)
          }).then(() => {
            if (firstNew() !== before) out.push(performance.now() - t0)
          })
        }
        return out.map((ms) => Math.round(ms * 10) / 10)
      })
      expect(typed.length).toBeGreaterThan(10)
      const sorted = [...typed].sort((a, b) => a - b)
      const median = sorted[Math.floor(sorted.length / 2)]!
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!
      await expect(c.getByTestId("rename-summary")).toHaveText("10,000 of 10,000 names will change")

      // Start → the job's end, with the long tasks of the renderer meanwhile.
      const apply = await c.evaluate(() => {
        const api = window.panelyth as unknown as {
          onEvent(
            ch: string,
            l: (p: {
              kind: string
              state: string
              startedMs: number
              finishedMs: number
              done: number
              failed: number
            }) => void,
          ): () => void
        }
        const long: number[] = []
        const po = new PerformanceObserver((l) =>
          l.getEntries().forEach((e) => long.push(e.duration)),
        )
        po.observe({ type: "longtask" })
        const button = [
          ...document.querySelectorAll<HTMLButtonElement>(
            '[data-testid="multi-rename-dialog"] button',
          ),
        ].find((b) => b.textContent === "Start")!
        return new Promise<{
          jobMs: number
          done: number
          failed: number
          longTasks: number
          longTaskMaxMs: number
        }>((resolve) => {
          const off = api.onEvent("job.progress", (p) => {
            if (p.kind !== "multiRename" || p.state !== "completed") return
            off()
            // The listing's refresh after the last batch belongs to it.
            setTimeout(() => {
              po.disconnect()
              resolve({
                jobMs: p.finishedMs - p.startedMs,
                done: p.done,
                failed: p.failed,
                longTasks: long.length,
                longTaskMaxMs: Math.round(Math.max(0, ...long)),
              })
            }, 500)
          })
          button.click()
        })
      })
      expect(apply.done).toBe(10_000)
      expect(apply.failed).toBe(0)
      expect(
        names(root).every((n) => /^\d{4}-\d\d-\d\d IMG_\d{6} holiday-2024-\d{5}\.jpg$/.test(n)),
      ).toBe(true)

      // The undo, measured the same way.
      await grid(c, "left").focus()
      const undoMs = await c.evaluate(() => {
        const api = window.panelyth as unknown as {
          onEvent(
            ch: string,
            l: (p: { kind: string; state: string; startedMs: number; finishedMs: number }) => void,
          ): () => void
          files: { start(p: { kind: "undoRename" }): Promise<unknown> }
        }
        return new Promise<number>((resolve) => {
          const off = api.onEvent("job.progress", (p) => {
            if (p.kind !== "undoRename" || p.state !== "completed") return
            off()
            resolve(p.finishedMs - p.startedMs)
          })
          void api.files.start({ kind: "undoRename" })
        })
      })
      expect(names(root)[0]).toBe("IMG_000001.jpg")
      expect(names(root)).toHaveLength(10_000)

      // The sizes of a panel of 1,000 folders (Go's job timestamps).
      await goTo(c, "right", join(fixture.root, "folders"))
      const sizes = await c.evaluate(async () => {
        const api = window.panelyth as unknown as {
          onEvent(
            ch: string,
            l: (p: {
              kind: string
              state: string
              startedMs: number
              finishedMs: number
              done: number
            }) => void,
          ): () => void
        }
        const g = document.querySelector<HTMLElement>('[data-testid="grid-right"]')!
        g.focus()
        return new Promise<{ ms: number; folders: number }>((resolve) => {
          const off = api.onEvent("job.progress", (p) => {
            if (p.kind === "dirSize" && p.state === "completed") {
              off()
              resolve({ ms: p.finishedMs - p.startedMs, folders: p.done })
            }
          })
          g.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              altKey: true,
              shiftKey: true,
              bubbles: true,
            }),
          )
        })
      })
      expect(sizes.folders).toBe(1_000)
      // Every folder shows its size: 20 files of 1 KiB.
      await expect(grid(c, "right").locator("[data-id]").first()).toContainText("20.0 KB")

      writeResult({
        metric: "multi-rename of 10,000 files: preview, apply, undo; sizes of 1,000 folders",
        openMs: Math.round(openMs),
        keyPressMs: typed,
        keyPressMedianMs: median,
        keyPressP95Ms: p95,
        mountedRows: mounted,
        apply,
        undoMs,
        folderSizes: sizes,
      })
      expectWithinBudget(p95, 50, "C09 preview after a key press, p95 (ms; one frame is the aim)")
      expectWithinBudget(
        apply.longTaskMaxMs,
        50 + 1,
        "C09 longest renderer task while 10,000 files are renamed (ms)",
      )
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
