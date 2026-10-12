import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { expectWithinBudget, repoRoot } from "../../launch"
import { commanderOf, cursorTo, goTo, launch, type Side } from "./helpers"

// Stage C08: compare, synchronize and checksums
// (docs/commander/stages/C08-compare-and-sync.md; scenario 14 of
// docs/commander/TESTING.md). Measurements go to stage-C08-…-e2e-compare.

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(
    repoRoot,
    "src",
    "shared",
    "bench",
    "results",
    `stage-C08-${date}-e2e-compare.jsonl`,
  )
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

const grid = (c: Page, side: Side) => c.getByTestId(`grid-${side}`)
const read = (path: string): string => readFileSync(path, "utf8")

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

/** The synchronize dialog's rows as "name action". */
const tableRows = (c: Page) =>
  c
    .getByTestId("sync-table")
    .locator("[role=option][data-action]")
    .evaluateAll((rows) =>
      rows.map((r) => `${r.firstElementChild?.textContent} ${r.getAttribute("data-action")}`),
    )

/** Opens the synchronize dialog, sets the options and compares. */
async function compare(c: Page, options: { mirror?: boolean; content?: boolean }) {
  await c.getByRole("button", { name: "Synchronize directories" }).click()
  const dialog = c.getByTestId("sync-dialog")
  if (options.mirror) await dialog.getByLabel(/Left to right only/).check()
  if (options.content) await dialog.getByLabel("Compare contents").check()
  await dialog.getByRole("button", { name: "Compare", exact: true }).click()
  await expect(c.getByTestId("sync-status")).toContainText("Compared", { timeout: 30_000 })
  return dialog
}

test.describe("compare, synchronize and checksums (Stage C08)", () => {
  test("scenario 14: compare and synchronize two trees; checksums create and verify", async () => {
    test.setTimeout(180_000)
    const fixture = ensureFixture("sync-pair-c08", { files: 0, sync: { pair: true } })
    // The test changes the trees: it works on a copy (with the fixture's dates).
    const root = mkdtempSync(join(tmpdir(), "panelyth-c08-"))
    const left = join(root, "left")
    const right = join(root, "right")
    cpSync(join(fixture.root, "left"), left, { recursive: true, preserveTimestamps: true })
    cpSync(join(fixture.root, "right"), right, { recursive: true, preserveTimestamps: true })
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "right", right)
      await goTo(c, "left", left)

      // Shift+F2: what is unique or newer in each panel is marked.
      await c.keyboard.press("Shift+F2")
      await expect(c.getByTestId("files-notice")).toContainText(
        "3 marked on the left, 3 on the right",
      )
      const marked = (side: Side) =>
        grid(c, side)
          .locator("[data-marked=true]")
          .evaluateAll((rows) => rows.map((r) => r.textContent ?? ""))
      const leftMarks = (await marked("left")).join(" ")
      for (const name of ["newer", "only-left", "size"]) expect(leftMarks).toContain(name)
      expect(leftMarks).not.toContain("same")
      const rightMarks = (await marked("right")).join(" ")
      for (const name of ["older", "only-right", "size"]) expect(rightMarks).toContain(name)
      await c.keyboard.press("Control+NumpadSubtract") // unmark all

      // Compare by content: the two readme files, side by side.
      await goTo(c, "right", join(right, "docs"))
      await goTo(c, "left", join(left, "docs"))
      await cursorTo(c, "left", "readme")
      await menu(c, "left", "Compare by content")
      const diff = c.getByTestId("diff-dialog")
      await expect(c.getByTestId("diff-status")).toHaveText("2 differences")
      await expect(diff.locator("[data-op=changed]")).toContainText("beta")
      await expect(diff.locator("[data-op=changed]")).toContainText("BETA (edited)")
      await expect(diff.locator("[data-op=added]")).toContainText("epsilon")
      await expect(diff.locator("[data-op=equal]").first()).toContainText("Panelyth sync fixture")
      await c.keyboard.press("Escape")
      await expect(diff).toHaveCount(0)
      await expect(grid(c, "left")).toBeFocused()
      await goTo(c, "right", right)
      await goTo(c, "left", left)

      // Synchronize: compare both trees (with contents), every difference with a direction.
      let dialog = await compare(c, { content: true })
      await expect(dialog.getByLabel("Left folder")).toHaveValue(left)
      await expect
        .poll(() => tableRows(c))
        .toEqual([
          "content.bin none",
          "empty/ copyLeft",
          "newer.txt copyRight",
          "old/ copyLeft",
          "older.txt copyLeft",
          "only-left.txt copyRight",
          "only-right.txt copyLeft",
          "photos/ copyRight",
          "size.txt none",
          "docs/readme.txt copyLeft",
          "old/gone.txt copyLeft",
          "photos/new/ copyRight",
          "photos/new/a.jpg copyRight",
          "photos/new/b.jpg copyRight",
        ])
      // The equal files are counted, not listed.
      await expect(c.getByTestId("sync-show-equal")).toContainText("2")

      // A direction for a row without one: content.bin goes right.
      const table = c.getByTestId("sync-table")
      await table.locator("[role=option]", { hasText: "content.bin" }).click()
      await c.keyboard.press("ArrowRight")
      await expect(table.locator("[role=option]", { hasText: "content.bin" })).toHaveAttribute(
        "data-action",
        "copyRight",
      )
      // A filter: without what goes left, then with it again.
      await c.getByTestId("sync-show-copyLeft").click()
      await expect.poll(async () => (await tableRows(c)).length).toBe(8)
      await c.getByTestId("sync-show-copyLeft").click()
      await expect.poll(async () => (await tableRows(c)).length).toBe(14)

      // The confirmation says what happens; nothing is deleted in this plan.
      await dialog.getByRole("button", { name: "Synchronize…" }).click()
      const confirm = c.getByTestId("sync-confirm")
      await expect(confirm).toContainText("Copy 5 files")
      await expect(confirm).toContainText(`to the right: ${right}`)
      await expect(confirm).toContainText("Copy 4 files")
      await expect(confirm).toContainText("Create 4 folders")
      await expect(confirm).not.toContainText("Delete")
      await confirm.getByRole("button", { name: "Synchronize", exact: true }).click()
      await expect(c.getByTestId("sync-dialog")).toHaveCount(0)
      await expect
        .poll(() => existsSync(join(left, "old", "gone.txt")), { timeout: 30_000 })
        .toBe(true)
      await expect
        .poll(() => existsSync(join(right, "photos", "new", "b.jpg")), { timeout: 30_000 })
        .toBe(true)
      await expect.poll(() => read(join(right, "newer.txt"))).toBe("the new text\n")
      await expect.poll(() => read(join(left, "older.txt"))).toBe("newer on the right\n")
      await expect.poll(() => read(join(right, "content.bin"))).toBe("AAAA")
      await expect.poll(() => read(join(left, "docs", "readme.txt"))).toContain("BETA (edited)")
      await expect.poll(() => existsSync(join(left, "empty"))).toBe(true)
      // The same date and another size had no direction: both sides keep theirs.
      expect(read(join(left, "size.txt"))).toBe("12345")
      expect(read(join(right, "size.txt"))).toBe("123456789")

      // Compared again, only that pair is left, with nothing to do.
      dialog = await compare(c, { content: true })
      await expect.poll(() => tableRows(c)).toEqual(["size.txt none"])
      await expect(c.getByTestId("sync-summary")).toContainText("Nothing to synchronize")
      await expect(dialog.getByRole("button", { name: "Synchronize…" })).toBeDisabled()
      await dialog.getByRole("button", { name: "Close" }).click()

      // A mirror: a stray file on the right is shown with × before it is deleted.
      writeFileSync(join(right, "stray.txt"), "not on the left\n")
      dialog = await compare(c, { mirror: true })
      await expect.poll(() => tableRows(c)).toEqual(["size.txt copyRight", "stray.txt deleteRight"])
      await expect(table.locator("[role=option]", { hasText: "stray.txt" })).toContainText("×")
      await dialog.getByRole("button", { name: "Synchronize…" }).click()
      await expect(confirm).toContainText(`Delete 1 entry on the right: ${right}`)
      // Not through the trash in a test.
      await confirm.getByLabel(/Delete permanently/).check()
      await confirm.getByRole("button", { name: "Synchronize", exact: true }).click()
      await expect.poll(() => existsSync(join(right, "stray.txt")), { timeout: 30_000 }).toBe(false)
      await expect.poll(() => read(join(right, "size.txt"))).toBe("12345")
      // The left side is the source of a mirror: untouched.
      expect(existsSync(join(left, "stray.txt"))).toBe(false)

      // Checksums: one list for everything in the left folder.
      // The cursor on an entry: the entry commands act on the marks.
      await cursorTo(c, "left", "newer")
      await c.keyboard.press("Control+a")
      await menu(c, "left", "Create checksums")
      const sums = c.getByTestId("checksum-dialog")
      await expect(sums.getByLabel("One list for all of them")).toBeChecked()
      await sums.getByLabel("List name").fill("all")
      await sums.getByRole("button", { name: "Create" }).click()
      await expect(c.getByTestId("files-notice")).toContainText("Checksums created for", {
        timeout: 30_000,
      })
      const list = read(join(left, "all.sha256"))
      expect(list).toMatch(/^[0-9a-f]{64} \*same\.txt$/m)
      expect(list).toMatch(/^[0-9a-f]{64} \*docs\/deep\/equal\.bin$/m)
      expect(list).toMatch(/^[0-9a-f]{64} \*photos\/new\/b\.jpg$/m)
      const listed = list.trim().split("\n").length

      // Verify: everything matches; then one changed file is listed.
      await cursorTo(c, "left", "all")
      await menu(c, "left", "Verify checksums")
      await expect(c.getByTestId("files-notice")).toContainText(
        `${listed} files verified: all match.`,
        { timeout: 30_000 },
      )
      writeFileSync(join(left, "same.txt"), "changed\n")
      await menu(c, "left", "Verify checksums")
      await expect(c.getByTestId("files-notice")).toContainText(
        `1 of ${listed} files did not verify`,
        { timeout: 30_000 },
      )
      const details = c.getByTestId("job-details")
      await expect(details).toContainText("same.txt")
      await expect(details).toContainText("checksum doesn't match")
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("two 100k-entry trees compare within the budget (benchmark)", async () => {
    test.setTimeout(600_000)
    const fixture = ensureFixture("sync-100k-c08", { files: 0, sync: { entries: 100_000 } })
    const keep = mkdtempSync(join(tmpdir(), "panelyth-c08-bench-"))
    writeFileSync(join(keep, "keep.txt"), "") // goTo waits for a row
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", keep)
      await c.getByRole("button", { name: "Synchronize directories" }).click()
      const dialog = c.getByTestId("sync-dialog")
      await dialog.getByLabel("Left folder").fill(join(fixture.root, "tree-a"))
      await dialog.getByLabel("Right folder").fill(join(fixture.root, "tree-b"))
      const runs: number[] = []
      for (let i = 0; i < 3; i++) {
        // Compare → the table's first rows (in-page clock).
        const ms = await c.evaluate(() => {
          const button = [
            ...document.querySelectorAll<HTMLButtonElement>('[data-testid="sync-dialog"] button'),
          ].find((b) => /^Compare/.test(b.textContent ?? ""))!
          const stale = new Set(
            document.querySelectorAll('[data-testid="sync-table"] [role=option][data-action]'),
          )
          const t0 = performance.now()
          button.click()
          return new Promise<number>((resolve, reject) => {
            const tick = (): void => {
              const row = document.querySelector(
                '[data-testid="sync-table"] [role=option][data-action]',
              )
              const status = document.querySelector('[data-testid="sync-status"]')?.textContent
              if (row && !stale.has(row) && status?.startsWith("Compared"))
                resolve(performance.now() - t0)
              else if (performance.now() - t0 > 120_000) reject(new Error("no rows"))
              else requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
          })
        })
        runs.push(Math.round(ms))
      }
      // About 3 % of the files differ: newer, missing, extra or another size.
      await expect(c.getByTestId("sync-show-copyRight")).not.toContainText(/^→\s*0$/)
      const counts = await c.getByTestId("sync-status").textContent()
      // The table stays virtualized whatever the number of rows.
      const mounted = await c.getByTestId("sync-table").locator("[role=option]").count()
      expect(mounted).toBeLessThan(80)
      const best = Math.min(...runs)
      writeResult({
        metric: "compare two 100k-entry trees, Compare → first rows",
        runsMs: runs,
        ms: best,
        budgetMs: 3000,
        status: counts,
        mountedRows: mounted,
      })
      expectWithinBudget(best, 3000, "C08 compare of two 100k-entry trees (ms)")
    } finally {
      await app.close()
      rmSync(keep, { recursive: true, force: true })
    }
  })
})
