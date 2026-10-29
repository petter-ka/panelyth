import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { expectWithinBudget, removeTemp, repoRoot } from "../../launch"
import { commanderOf, cursorTo, goTo, launch, mixedFolder, openFolder, type Side } from "./helpers"

// Stage C10.5: the tab bar and tab sets, the folder tree, and Compare by
// content for several files (docs/commander/stages/C10.5-tabs-tree-ftp-compare.md;
// scenarios 19, 20 and 22 of docs/commander/TESTING.md).
// Measurements: stage-C10.5-…-e2e-tabstree.

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(
    repoRoot,
    "src",
    "shared",
    "bench",
    "results",
    `stage-C10.5-${date}-e2e-tabstree.jsonl`,
  )
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

const grid = (c: Page, side: Side) => c.getByTestId(`grid-${side}`)
const path = (c: Page, side: Side) => c.getByTestId(`path-${side}`)
const tabs = (c: Page, side: Side) => c.getByTestId(`tabs-${side}`).getByRole("tab")
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const p95 = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]! * 10) / 10
}
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** A fresh profile reused across launches (library.db, the Electron profile). */
function profile() {
  const dir = mkdtempSync(join(tmpdir(), "panelyth-e2e-profile-"))
  return {
    dir,
    env: {
      PANELYTH_CONFIG_DIR: join(dir, "config"),
      PANELYTH_USER_DATA_DIR: join(dir, "user-data"),
    },
  }
}

/** A command of a tab's menu (right-click on the tab). */
async function tabMenu(c: Page, side: Side, index: number, command: string): Promise<void> {
  await c.getByTestId(`tab-${side}-${index}`).click({ button: "right" })
  await c.getByTestId(`tab-menu-${side}`).getByRole("menuitem", { name: command }).click()
}

const treeNode = (c: Page, id: string, folder: string) =>
  c.getByTestId(`tree-${id}`).locator(`[data-testid="tree-node"][aria-label="${folder}"]`)

/** The tree's node for the panel's folder (aria-current) has this path. */
async function expectTreeOn(c: Page, id: string, folder: string): Promise<void> {
  await expect
    .poll(async () =>
      (
        (await c
          .getByTestId(`tree-${id}`)
          .locator('[aria-current="location"]')
          .first()
          .getAttribute("data-path")
          .catch(() => null)) ?? ""
      ).toLowerCase(),
    )
    .toBe(folder.toLowerCase())
}

test.describe("tab bar, tab sets, folder tree, compare several files (Stage C10.5)", () => {
  test("scenario 19: tabs by mouse and key; a saved tab set survives a restart and opens again", async () => {
    test.setTimeout(120_000)
    const root = mixedFolder()
    const alpha = join(root, "alpha")
    const beta = join(root, "beta")
    const p = profile()
    let app: ElectronApplication | null = null
    try {
      app = (await launch("commander", p.env)).app
      let c = await commanderOf(app)
      await goTo(c, "left", root)
      // The tab bar is there with one tab; "+" adds a tab without a key.
      await expect(tabs(c, "left")).toHaveCount(1)
      await c.getByTestId("tab-new-left").click()
      await expect(tabs(c, "left")).toHaveCount(2)
      await goTo(c, "left", alpha)

      // A double-click renames the tab in place.
      await c.getByTestId("tab-left-1").dblclick()
      const field = c.getByRole("textbox", { name: "Tab name" })
      await field.fill("Trip")
      await field.press("Enter")
      await expect(c.getByTestId("tab-left-1")).toContainText("Trip")
      // The keys are back in the panel.
      await expect(grid(c, "left")).toBeFocused()

      // Duplicate, close with ×, bring it back with Ctrl+Shift+T.
      await tabMenu(c, "left", 0, "Duplicate tab")
      await expect(tabs(c, "left")).toHaveCount(3)
      await c.getByTestId("tab-left-1").hover()
      await c.getByTestId("tab-left-1").getByRole("button").click()
      await expect(tabs(c, "left")).toHaveCount(2)
      await grid(c, "left").focus()
      await c.keyboard.press("Control+Shift+T")
      await expect(tabs(c, "left")).toHaveCount(3)
      await c.keyboard.press("Control+w")
      await expect(tabs(c, "left")).toHaveCount(2)

      // Lock the first tab and save both as a set.
      await tabMenu(c, "left", 0, "Lock tab")
      await tabMenu(c, "left", 0, "Save tabs…")
      const save = c.getByRole("dialog", { name: "Save tabs" })
      await save.getByRole("textbox", { name: "Name" }).fill("Holiday")
      await save.getByRole("button", { name: "Save" }).click()
      await expect(c.getByTestId("files-notice")).toContainText("Tab set “Holiday” saved.")
      await openFolder(c, "right", beta)
      await c.waitForTimeout(800) // commander.panels is written after a quiet period
      await app.close()

      // After a restart: the tabs and the title are back, and so is the set.
      app = (await launch("commander", p.env)).app
      c = await commanderOf(app)
      await expect(tabs(c, "left")).toHaveCount(2)
      await expect(c.getByTestId("tab-left-1")).toContainText("Trip")
      await expect(c.getByTestId("tab-left-0")).toHaveAttribute("data-locked", "true")
      await expect(path(c, "right")).toHaveText(beta)

      // The right panel opens the set in place of its tab: the set's shown tab shows.
      await tabMenu(c, "right", 0, "Tab sets…")
      const sets = c.getByRole("dialog", { name: "Tab sets" })
      await expect(sets.getByRole("option", { name: /Holiday/ })).toContainText("2 tabs")
      await sets.getByRole("button", { name: "Open" }).click()
      await expect(tabs(c, "right")).toHaveCount(2)
      await expect(path(c, "right")).toHaveText(alpha)
      await expect(c.getByTestId("tab-right-1")).toContainText("Trip")
      await expect(c.getByTestId("tab-right-0")).toHaveAttribute("data-locked", "true")
      // The first tab of the set shows its folder when it is shown.
      await c.getByTestId("tab-right-0").click()
      await expect(path(c, "right")).toHaveText(root)

      // Added after the current tabs; a locked tab is never closed without being asked.
      await tabMenu(c, "right", 0, "Tab sets…")
      await sets.getByRole("button", { name: "Add to the tabs" }).click()
      await expect(tabs(c, "right")).toHaveCount(4)
      await tabMenu(c, "right", 0, "Tab sets…")
      await sets.getByRole("button", { name: "Open" }).click()
      await expect(sets.getByRole("alert")).toContainText("locked tab")
      await c.keyboard.press("Escape")
      await expect(sets).toHaveCount(0)
      await expect(tabs(c, "right")).toHaveCount(4)
    } finally {
      await app?.close().catch(() => undefined)
      removeTemp(p.dir)
      removeTemp(root)
    }
  })

  test("scenario 20: the folder tree follows the panel, opens folders and stays bounded", async () => {
    test.setTimeout(120_000)
    const root = mixedFolder()
    const alpha = join(root, "alpha")
    const beta = join(root, "beta")
    // A folder with 1,000 subfolders.
    const wide = join(root, "wide")
    mkdirSync(wide)
    for (let i = 0; i < 1000; i++) mkdirSync(join(wide, `d${String(i).padStart(4, "0")}`))
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      // The left panel is opened last, so it is the active one.
      await openFolder(c, "right", beta)
      await goTo(c, "left", root)
      await grid(c, "left").focus()
      await expect(c.getByTestId("tree-one")).toHaveCount(0)

      // Ctrl+Shift+F8: one tree, on the active panel's folder.
      await c.keyboard.press("Control+Shift+F8")
      await expect(c.getByTestId("tree-one")).toBeVisible()
      await expectTreeOn(c, "one", root)
      // The panel's folder is shown, not opened: its arrow lists its subfolders.
      await treeNode(c, "one", basename(root)).getByRole("button").click()
      // A click in the tree opens the folder in the panel.
      await treeNode(c, "one", "alpha").click()
      await expect(path(c, "left")).toHaveText(alpha)
      await expectTreeOn(c, "one", alpha)

      // Shift+Tab: the keys go to the tree; ↓ moves its cursor, Enter opens and returns.
      await grid(c, "left").focus()
      await c.keyboard.press("Shift+Tab")
      await expect(c.getByTestId("tree-rows-one")).toBeFocused()
      await c.keyboard.press("ArrowDown")
      await expect(treeNode(c, "one", "beta")).toHaveAttribute("aria-selected", "true")
      // The panel has not moved with the tree's cursor.
      await expect(path(c, "left")).toHaveText(alpha)
      await c.keyboard.press("Enter")
      await expect(path(c, "left")).toHaveText(beta)
      await expect(grid(c, "left")).toBeFocused()

      // Type-ahead and → : the wide folder expands; the rows stay bounded.
      await c.keyboard.press("Shift+Tab")
      await c.keyboard.type("wi")
      await expect(treeNode(c, "one", "wide")).toHaveAttribute("aria-selected", "true")
      await c.keyboard.press("ArrowRight")
      await expect(treeNode(c, "one", "d0000")).toBeVisible()
      const mounted = await c.getByTestId("tree-one").locator('[data-testid="tree-node"]').count()
      const visible = await c
        .getByTestId("tree-rows-one")
        .evaluate((el) => Math.ceil(el.clientHeight / 22))
      // The rows in view (one may be cut at each end) and the overscan of 8 on both sides.
      expect(mounted).toBeLessThanOrEqual(visible + 1 + 2 * 8)
      // Letters reach a node far down without mounting what lies between.
      await c.keyboard.type("d0999")
      await expect(treeNode(c, "one", "d0999")).toHaveAttribute("aria-selected", "true")
      // ← goes to the parent, ← again collapses it; Esc gives the keys back.
      await c.keyboard.press("ArrowLeft")
      await expect(treeNode(c, "one", "wide")).toHaveAttribute("aria-selected", "true")
      await c.keyboard.press("ArrowLeft")
      await expect(treeNode(c, "one", "d0000")).toHaveCount(0)
      await c.keyboard.press("Escape")
      await expect(grid(c, "left")).toBeFocused()

      // Tab: the one tree follows the other panel.
      await c.keyboard.press("Tab")
      await expectTreeOn(c, "one", beta)

      // A tree per panel, each on its own folder; then none.
      await c.keyboard.press("Control+Shift+F8")
      await expect(c.getByTestId("tree-one")).toHaveCount(0)
      await expectTreeOn(c, "right", beta)
      await goTo(c, "left", alpha)
      await expectTreeOn(c, "left", alpha)
      await expectTreeOn(c, "right", beta)
      await grid(c, "left").focus()
      await c.keyboard.press("Control+Shift+F8")
      await expect(c.getByTestId("tree-left")).toHaveCount(0)
      await expect(c.getByTestId("tree-right")).toHaveCount(0)
    } finally {
      await app.close().catch(() => undefined)
      removeTemp(root)
    }
  })

  test("scenario 22: compare two files, one of each panel, and many against the other panel", async () => {
    test.setTimeout(120_000)
    const root = mkdtempSync(join(tmpdir(), "panelyth-c105-"))
    const left = join(root, "left")
    const right = join(root, "right")
    mkdirSync(left)
    mkdirSync(right)
    for (let i = 0; i < 20; i++) {
      const name = `f${String(i).padStart(2, "0")}.txt`
      const text = `line one\nfile ${i} has words\nline three\n`
      writeFileSync(join(left, name), text)
      // f03 and f07 differ in one word; f11 and f15 are not on the right.
      if (i === 11 || i === 15) continue
      writeFileSync(join(right, name), i === 3 || i === 7 ? text.replace("words", "birds") : text)
    }
    writeFileSync(join(right, "other.txt"), "line one\nfile 0 has birds\nline three\n")
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", left)
      await goTo(c, "right", right)
      const compare = c.getByTestId("quick-actions").getByRole("button", {
        name: "Compare by content",
      })

      // One marked file in each panel: those two, side by side, the change marked in the line.
      // (The Full view shows the name and the extension in columns of their own.)
      await cursorTo(c, "left", "f00")
      await c.keyboard.press("Insert")
      await cursorTo(c, "right", "other")
      await c.keyboard.press("Insert")
      await compare.click()
      const diff = c.getByTestId("diff-dialog")
      await expect(diff).toContainText("f00.txt")
      await expect(diff).toContainText("other.txt")
      await expect(c.getByTestId("diff-status")).toContainText("1 difference")
      // "words" and "birds" end alike: what differs inside the line is "wo" and "bi".
      await expect(c.getByTestId("diff-rows").locator("mark")).toHaveText(["wo", "bi"])
      await diff.getByRole("button", { name: "Close" }).click()

      // All twenty files of the left panel against the right panel: one job, a result list.
      // (A click in the left panel makes it the active one again.)
      await cursorTo(c, "left", "f01")
      await c.keyboard.press("Control+a")
      await compare.click()
      const many = c.getByTestId("compare-many")
      await expect(c.getByTestId("compare-many-status")).toContainText(
        "Identical: 16 · Not identical: 4",
        { timeout: 20_000 },
      )
      await expect(many.getByRole("button", { name: "Different 2" })).toBeVisible()
      await expect(many.getByRole("button", { name: "Missing 2" })).toBeVisible()
      const rows = c.getByTestId("compare-many-rows").getByRole("option")
      await expect(rows).toHaveCount(4)
      // Only what differs: the missing ones hide with their filter.
      await many.getByRole("button", { name: "Missing 2" }).click()
      await expect(rows).toHaveCount(2)
      await expect(rows.first()).toContainText("f03.txt")
      // Enter: that pair side by side; Shift+N steps to the next file that differs.
      await c.getByTestId("compare-many-rows").focus()
      await c.keyboard.press("Enter")
      await expect(diff).toContainText("f03.txt")
      await expect(c.getByTestId("diff-rows").locator("mark")).toHaveText(["wo", "bi"])
      await c.getByTestId("diff-rows").locator("[data-side=left][role=region]").focus()
      await c.keyboard.press("Shift+N")
      await expect(diff).toContainText("f07.txt")
      await diff.getByRole("button", { name: "Back to the list" }).click()
      await expect(rows).toHaveCount(2)
      await many.getByRole("button", { name: "Close" }).click()
      await expect(many).toHaveCount(0)
    } finally {
      await app.close().catch(() => undefined)
      removeTemp(root)
    }
  })
})

test.describe("benchmarks (Stage C10.5)", () => {
  test("the folder tree: expanding wide folders, a held arrow key, and folder enters beside it", async () => {
    test.setTimeout(300_000)
    const root = mkdtempSync(join(tmpdir(), "panelyth-c105-tree-"))
    // Ten folders of 1,000 subfolders each: 10,000 nodes once all are expanded.
    const WIDE = 10
    for (let w = 0; w < WIDE; w++) {
      const dir = join(root, `w${w}`)
      mkdirSync(dir)
      for (let i = 0; i < 1000; i++) mkdirSync(join(dir, `d${String(i).padStart(4, "0")}`))
    }
    // Two folders of 1,000 files to enter back and forth.
    const enter = [join(root, "x-a"), join(root, "x-b")]
    for (const dir of enter) {
      mkdirSync(dir)
      for (let i = 0; i < 1000; i++)
        writeFileSync(join(dir, `f${String(i).padStart(4, "0")}.txt`), "")
    }
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", root)
      // Folder enters without the tree (both folders listed once first).
      for (const dir of enter) await goTo(c, "left", dir)
      const without: number[] = []
      for (let i = 0; i < 12; i++) without.push(await goTo(c, "left", enter[i % 2]!))

      await goTo(c, "left", root)
      await grid(c, "left").focus()
      await c.keyboard.press("Control+Shift+F8")
      await expectTreeOn(c, "one", root)
      await treeNode(c, "one", basename(root)).getByRole("button").click()
      await expect(treeNode(c, "one", "w0")).toBeVisible()

      // Expand each wide folder: click on its arrow → its first subfolder painted.
      const expand: number[] = []
      for (let w = 0; w < WIDE; w++) {
        expand.push(
          await c.evaluate((name) => {
            const pane = document.querySelector('[data-testid="tree-one"]')!
            const node = pane.querySelector(`[data-testid="tree-node"][aria-label="${name}"]`)!
            const t0 = performance.now()
            node.querySelector("button")!.click()
            return new Promise<number>((resolve, reject) => {
              const tick = (): void => {
                const open = pane
                  .querySelector(`[data-testid="tree-node"][aria-label="${name}"]`)
                  ?.getAttribute("aria-expanded")
                const child = pane.querySelector(
                  `[data-testid="tree-node"][aria-level="${Number(node.getAttribute("aria-level")) + 1}"]`,
                )
                if (open === "true" && child) resolve(performance.now() - t0)
                else if (performance.now() - t0 > 20_000) reject(new Error(`${name} not expanded`))
                else requestAnimationFrame(tick)
              }
              requestAnimationFrame(tick)
            })
          }, `w${w}`),
        )
        // Collapse it again so the next one is in view; its listing stays in the tree.
        await treeNode(c, "one", `w${w}`).getByRole("button").click()
        await expect(treeNode(c, "one", `w${w}`)).toHaveAttribute("aria-expanded", "false")
      }

      // All ten expanded: 10,000 nodes below the root. A held ↓ for 3 s.
      // From the last one up, so the ones still to expand stay in view.
      for (let w = WIDE - 1; w >= 0; w--) {
        await treeNode(c, "one", `w${w}`).getByRole("button").click()
        await expect(treeNode(c, "one", `w${w}`)).toHaveAttribute("aria-expanded", "true")
      }
      await c.getByTestId("tree-rows-one").focus()
      await c.keyboard.press("Home")
      const held = await c.evaluate(async () => {
        const tree = document.querySelector<HTMLElement>('[data-testid="tree-rows-one"]')!
        const long: number[] = []
        const po = new PerformanceObserver((l) =>
          l.getEntries().forEach((e) => long.push(e.duration)),
        )
        po.observe({ type: "longtask" })
        const gaps: number[] = []
        let mounted = 0
        let keys = 0
        await new Promise<void>((resolve) => {
          const start = performance.now()
          let last = start
          const tick = (t: number): void => {
            gaps.push(t - last)
            last = t
            // A held key repeats about 30 times a second: two per frame is more.
            for (let i = 0; i < 2; i++) {
              tree.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
              keys++
            }
            mounted = Math.max(mounted, tree.querySelectorAll('[data-testid="tree-node"]').length)
            if (t - start < 3000) requestAnimationFrame(tick)
            else resolve()
          }
          requestAnimationFrame(tick)
        })
        await new Promise((r) => setTimeout(r, 300))
        po.disconnect()
        const sorted = gaps.slice(1).sort((a, b) => a - b)
        return {
          keys,
          frames: sorted.length,
          p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
          maxFrameGapMs: Math.round(sorted.at(-1) ?? 0),
          longTasks: long.length,
          longTaskMaxMs: Math.round(Math.max(0, ...long)),
          maxMountedNodes: mounted,
          visibleRows: Math.ceil(tree.clientHeight / 22),
        }
      })

      // Folder enters with the tree shown (it follows after each).
      await grid(c, "left").focus()
      const withTree: number[] = []
      for (let i = 0; i < 12; i++) withTree.push(await goTo(c, "left", enter[i % 2]!))
      await expectTreeOn(c, "one", enter[1]!)

      const result = {
        name: "tree",
        expand1000: { runs: expand.map(Math.round), medianMs: median(expand), p95Ms: p95(expand) },
        heldArrow10k: held,
        enter1kWithoutTree: { medianMs: Math.round(median(without)), p95Ms: p95(without) },
        enter1kWithTree: { medianMs: Math.round(median(withTree)), p95Ms: p95(withTree) },
      }
      writeResult(result)
      console.log(JSON.stringify(result))
      expectWithinBudget(p95(expand), 100, "expand a node with 1,000 subfolders, p95 ms")
      expect(held.maxMountedNodes).toBeLessThanOrEqual(held.visibleRows + 1 + 2 * 8)
      expectWithinBudget(held.longTaskMaxMs, 51, "held arrow in a 10,000-node tree: longest task")
      // The cached-folder budget of docs/commander/PERFORMANCE.md, with the tree beside the panel.
      expectWithinBudget(p95(withTree), 50, "enter a cached 1k folder with the tree shown, p95 ms")
    } finally {
      await app.close().catch(() => undefined)
      removeTemp(root)
    }
  })

  test("a tab set of 16 tabs opens with one folder listed; 1,000 pairs compare as one job", async () => {
    test.setTimeout(300_000)
    const root = mkdtempSync(join(tmpdir(), "panelyth-c105-sets-"))
    const folders: string[] = []
    for (let i = 0; i < 16; i++) {
      const dir = join(root, `t${String(i).padStart(2, "0")}`)
      mkdirSync(dir)
      for (let f = 0; f < 50; f++) writeFileSync(join(dir, `f${f}.txt`), "")
      folders.push(dir)
    }
    // Compare: 1,000 files of 1 KiB on both sides; 30 differ, 10 are missing on the right.
    const left = join(root, "left")
    const right = join(root, "right")
    mkdirSync(left)
    mkdirSync(right)
    const body = "0123456789abcdef".repeat(64)
    for (let i = 0; i < 1000; i++) {
      const name = `c${String(i).padStart(4, "0")}.bin`
      writeFileSync(join(left, name), body)
      if (i % 100 === 99) continue
      writeFileSync(join(right, name), i % 33 === 0 ? `X${body.slice(1)}` : body)
    }
    const p = profile()
    let app: ElectronApplication | null = null
    try {
      app = (await launch("commander", p.env)).app
      let c = await commanderOf(app)
      await goTo(c, "left", root)
      // The set is written as the app stores it; it is read at the next start.
      await c.evaluate(
        ({ folders }) =>
          (
            window as unknown as {
              panelyth: { library: { setSetting(key: string, value: unknown): Promise<unknown> } }
            }
          ).panelyth.library.setSetting("commander.tabSets", {
            v: 1,
            sets: [
              {
                id: 1,
                name: "Sixteen",
                panels: [{ tabs: folders.map((path) => ({ path })), active: 9 }],
              },
            ],
          }),
        { folders },
      )
      await c.waitForTimeout(800) // commander.panels is written after a quiet period
      await app.close()
      app = (await launch("commander", p.env)).app
      c = await commanderOf(app)
      await expect(path(c, "left")).toHaveText(root)

      await tabMenu(c, "left", 0, "Tab sets…")
      const target = folders[9]!
      const openMs = await c.evaluate(
        ({ target }) => {
          const button = [
            ...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button"),
          ].find((b) => b.textContent === "Open")!
          const t0 = performance.now()
          button.click()
          return new Promise<number>((resolve, reject) => {
            const tick = (): void => {
              const shown = document.querySelector('[data-testid="path-left"]')?.textContent ?? ""
              const rows = document
                .querySelector('[data-testid="grid-left"]')
                ?.querySelector("[data-id]")
              if (shown.toLowerCase() === target.toLowerCase() && rows)
                resolve(performance.now() - t0)
              else if (performance.now() - t0 > 20_000) reject(new Error("the set did not open"))
              else requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
          })
        },
        { target },
      )
      await expect(tabs(c, "left")).toHaveCount(16)
      expect(same(await path(c, "left").innerText(), target)).toBe(true)
      // Another tab of the set lists its folder only when it is shown.
      await c.getByTestId("tab-left-0").click()
      await expect(path(c, "left")).toHaveText(folders[0]!)

      // Compare 1,000 marked files with the other panel.
      // The left panel is opened last, so it is the active one.
      await goTo(c, "right", right)
      await goTo(c, "left", left)
      await grid(c, "left").focus()
      await c.keyboard.press("Control+a")
      const compared = await c.evaluate(() => {
        const long: number[] = []
        const po = new PerformanceObserver((l) =>
          l.getEntries().forEach((e) => long.push(e.duration)),
        )
        po.observe({ type: "longtask" })
        const button = document.querySelector<HTMLButtonElement>(
          '[data-testid="quick-actions"] button[aria-label="Compare by content"]',
        )!
        const t0 = performance.now()
        button.click()
        return new Promise<{ ms: number; longTasks: number; longTaskMaxMs: number; rows: number }>(
          (resolve, reject) => {
            const tick = (): void => {
              const status =
                document.querySelector('[data-testid="compare-many-status"]')?.textContent ?? ""
              const rows = document.querySelectorAll(
                '[data-testid="compare-many-rows"] [role=option]',
              ).length
              if (status.startsWith("Identical:") && rows > 0) {
                const ms = performance.now() - t0
                setTimeout(() => {
                  po.disconnect()
                  resolve({
                    ms,
                    longTasks: long.length,
                    longTaskMaxMs: Math.round(Math.max(0, ...long)),
                    rows,
                  })
                }, 300)
              } else if (performance.now() - t0 > 60_000) reject(new Error(`compare: ${status}`))
              else requestAnimationFrame(tick)
            }
            requestAnimationFrame(tick)
          },
        )
      })
      await expect(c.getByTestId("compare-many-status")).toContainText(
        "Identical: 960 · Not identical: 40",
      )
      await expect(
        c.getByTestId("compare-many").getByRole("button", { name: "Missing 10" }),
      ).toBeVisible()

      const result = {
        name: "tabsets-compare",
        tabSet16OpenMs: Math.round(openMs),
        compare1000: { ...compared, ms: Math.round(compared.ms) },
        folder: basename(root),
      }
      writeResult(result)
      console.log(JSON.stringify(result))
      // An uncached folder of 50 entries, with fifteen more tabs as records.
      expectWithinBudget(openMs, 150, "open a tab set of 16 tabs → the shown tab painted, ms")
      expect(compared.rows).toBeLessThanOrEqual(40)
      expectWithinBudget(
        compared.longTaskMaxMs,
        51,
        "comparing 1,000 pairs: longest task in the renderer",
      )
    } finally {
      await app?.close().catch(() => undefined)
      removeTemp(p.dir)
      removeTemp(root)
    }
  })
})
