import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import { expectWithinBudget, removeTemp, repoRoot, shellState } from "../../launch"
import { commanderOf, cursorTo, goTo, launch, type Side } from "./helpers"

// Stage C10: the command line, user commands, the toolbar, settings and the
// Thumbnails view (docs/commander/stages/C10-command-line-and-customization.md;
// scenario 17 of docs/commander/TESTING.md). Commands are recorded, never
// run (PANELYTH_TEST_SHELL=record, set by launchApp). Measurements go to
// stage-C10-…-e2e-tools.

const IS_WINDOWS = process.platform === "win32"

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(
    repoRoot,
    "src",
    "shared",
    "bench",
    "results",
    `stage-C10-${date}-e2e-tools.jsonl`,
  )
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

const grid = (c: Page, side: Side) => c.getByTestId(`grid-${side}`)
const path = (c: Page, side: Side) => c.getByTestId(`path-${side}`)
const line = (c: Page) => c.getByRole("textbox", { name: "Command line" })
const samePath = (a: string, b: string): boolean =>
  IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b

interface Recorded {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

/** What main recorded instead of running (the test hook of PANELYTH_TEST_SHELL=record). */
const shellLog = (app: ElectronApplication) =>
  app.evaluate(
    () =>
      (globalThis as unknown as { __panelythShellLog: { action: string; value: string }[] })
        .__panelythShellLog,
  )
const runs = async (app: ElectronApplication): Promise<Recorded[]> =>
  (await shellLog(app))
    .filter((entry) => entry.action === "run")
    .map((entry) => JSON.parse(entry.value) as Recorded)

/** The text a recorded start hands to the shell. */
const commandOf = (run: Recorded): string => (IS_WINDOWS ? run.args[4]!.slice(1, -1) : run.args[1]!)

/**
 * A fresh profile reused across launches: library.db, the Electron profile and
 * the index, as on a user's machine (the shared context names folders by
 * their id in index.db).
 */
function profile() {
  const dir = mkdtempSync(join(tmpdir(), "panelyth-e2e-c10-"))
  return {
    dir,
    env: {
      PANELYTH_CACHE_DIR: join(dir, "cache"),
      PANELYTH_CONFIG_DIR: join(dir, "config"),
      PANELYTH_USER_DATA_DIR: join(dir, "user-data"),
    },
  }
}

// A step that cannot act says so, instead of running into the test's timeout.
test.use({ actionTimeout: 10_000 })

// Names a command must survive: an ampersand, a percent sign with a real
// variable's name, and one that reads like an option.
const HOSTILE = "a&b %PATH%.txt"
const OPTION = "-rf"

/** A folder with a subfolder, a plain file and the hostile names; and a second folder. */
function folders(): { root: string; other: string } {
  const base = mkdtempSync(join(tmpdir(), "panelyth-c10-"))
  const root = join(base, "work dir")
  const other = join(base, "target")
  mkdirSync(join(root, "alpha"), { recursive: true })
  mkdirSync(other)
  writeFileSync(join(root, "alpha", "inner.txt"), "x")
  writeFileSync(join(other, "kept.txt"), "x")
  for (const name of [OPTION, HOSTILE, "notes.txt"]) writeFileSync(join(root, name), "x")
  return { root, other }
}

/**
 * Waits until the session in library.db names `folder` for the left panel
 * (and, when given, its view): the session is written a moment after a change.
 */
async function sessionStored(c: Page, folder: string, view?: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const tab = await c.evaluate(async () => {
          const res = await window.panelyth!.library.get()
          const panels = res.ok
            ? (res.r.settings["commander.panels"] as
                { left?: { active: number; tabs: { path: string; view: string }[] } } | undefined)
            : undefined
          const shown = panels?.left?.tabs[panels.left.active]
          return shown ? { path: shown.path, view: shown.view } : null
        })
        return (
          tab !== null && samePath(tab.path, folder) && (view === undefined || tab.view === view)
        )
      },
      { timeout: 10_000 },
    )
    .toBe(true)
}

async function typeLine(c: Page, text: string): Promise<void> {
  await c.keyboard.press("Control+k")
  await expect(line(c)).toBeFocused()
  await line(c).fill(text)
}

async function viewerOf(app: ElectronApplication): Promise<Page> {
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    const page = app.windows().find((w) => w.url().startsWith("app://panelyth"))
    if (page) return page
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error("viewer view not found")
}

test.describe("command line (Stage C10, scenario 17)", () => {
  test("cd, a recorded command and the history; nothing runs without Enter", async () => {
    const { root } = folders()
    const p = profile()
    let app = (await launch("commander", p.env)).app
    try {
      let c = await commanderOf(app)
      await goTo(c, "left", root)
      await expect(c.getByTestId("command-prompt")).toContainText("work dir")

      // cd moves the panel and is never handed to the shell.
      await typeLine(c, "cd alpha")
      await c.keyboard.press("Enter")
      await expect(path(c, "left")).toHaveText(join(root, "alpha"))
      await expect(grid(c, "left")).toBeFocused()
      await typeLine(c, "cd ..")
      await c.keyboard.press("Enter")
      await expect(path(c, "left")).toHaveText(root)
      expect(await runs(app)).toEqual([])

      // Typing, leaving the field, the other panel, the history list: none of them runs a line.
      const command = 'echo "a & b" > out.txt'
      await typeLine(c, command)
      await c.keyboard.press("Tab")
      await expect(grid(c, "left")).toBeFocused()
      await c.keyboard.press("Tab")
      await expect(c.getByTestId("panel-right")).toHaveAttribute("data-active", "true")
      await c.keyboard.press("Tab")
      await expect(c.getByTestId("panel-left")).toHaveAttribute("data-active", "true")
      await c.keyboard.press("Alt+F8")
      await expect(c.getByRole("menu", { name: "Command history" })).toBeVisible()
      await c.keyboard.press("Escape")
      await expect(line(c)).toHaveValue(command)
      await c.waitForTimeout(200)
      expect(await runs(app)).toEqual([])

      // Enter in the command line: main gets the line and the panel's folder id.
      await c.keyboard.press("Control+k")
      await c.keyboard.press("Enter")
      await expect.poll(async () => (await runs(app)).length).toBe(1)
      const [run] = await runs(app)
      expect(samePath(run!.cwd, root)).toBe(true)
      expect(commandOf(run!)).toBe(command)
      if (IS_WINDOWS) {
        // cmd.exe by its full path, the line as typed between the outer quotes.
        expect(run!.file.toLowerCase()).toMatch(/^[a-z]:\\.*\\system32\\cmd\.exe$/)
        expect(run!.args.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"])
      } else {
        expect(run!.file).toBe("/bin/sh")
        expect(run!.args[0]).toBe("-c")
      }
      // Recorded, not run: the redirect wrote nothing.
      expect(existsSync(join(root, "out.txt"))).toBe(false)
      await expect(line(c)).toHaveValue("")
      await expect(grid(c, "left")).toBeFocused()

      // Shift+Enter asks for a console that stays open.
      await typeLine(c, "git status")
      await c.keyboard.press("Shift+Enter")
      await expect.poll(async () => (await runs(app)).length).toBe(2)
      const second = (await runs(app))[1]!
      if (IS_WINDOWS) {
        expect(second.args[1]).toBe("/v:on")
        expect(second.args[4]).toContain("/k")
        expect(second.args[4]).not.toContain("git status")
        expect(second.env.PANELYTH_RUN).toBe("git status")
      } else {
        expect(second.args.join(" ")).toContain("git status")
      }

      // The field clicked and empty: Shift+Enter opens a console in the folder and runs nothing.
      await line(c).click()
      await expect(line(c)).toBeFocused()
      await expect(line(c)).toHaveValue("")
      await c.keyboard.press("Enter")
      await c.waitForTimeout(150)
      expect((await runs(app)).length).toBe(2)
      await c.keyboard.press("Shift+Enter")
      await expect.poll(async () => (await runs(app)).length).toBe(3)
      const third = (await runs(app))[2]!
      expect(samePath(third.cwd, root)).toBe(true)
      if (IS_WINDOWS) {
        expect(third.args[4]).toBe('"start "Panelyth Commander" "!PANELYTH_SHELL!""')
        expect(third.env.PANELYTH_RUN).toBeUndefined()
      } else {
        expect(third.args.join(" ")).not.toContain("-c")
      }

      // Ctrl+Enter adds the name under the cursor, Ctrl+Shift+Enter its path.
      await cursorTo(c, "left", "notes")
      await c.keyboard.press("Control+Enter")
      await expect(line(c)).toHaveValue("notes.txt ")
      await c.keyboard.press("Control+Shift+Enter")
      await expect(line(c)).toHaveValue(
        `notes.txt ${IS_WINDOWS ? `"${join(root, "notes.txt")}"` : `'${join(root, "notes.txt")}'`} `,
      )
      await c.keyboard.press("Control+k")
      await c.keyboard.press("Escape")
      await expect(line(c)).toHaveValue("")

      // The history: newest first; a picked line waits for Enter.
      await c.keyboard.press("Alt+F8")
      const menu = c.getByRole("menu", { name: "Command history" })
      await expect(menu.getByRole("menuitem")).toHaveText([
        "git status",
        command,
        "cd ..",
        "cd alpha",
      ])
      await menu.getByRole("menuitem", { name: "cd alpha" }).click()
      await expect(line(c)).toHaveValue("cd alpha")
      await expect(line(c)).toBeFocused()
      await expect(path(c, "left")).toHaveText(root)
      expect((await runs(app)).length).toBe(3)
      await c.keyboard.press("Escape")

      // The history is still there after a restart.
      await sessionStored(c, root)
      await app.close()
      app = (await launch("commander", p.env)).app
      c = await commanderOf(app)
      await expect(path(c, "left")).toHaveText(root)
      await grid(c, "left").focus()
      await c.keyboard.press("Alt+F8")
      await expect(
        c.getByRole("menu", { name: "Command history" }).getByRole("menuitem"),
      ).toHaveText(["git status", command, "cd ..", "cd alpha"])
      expect(await runs(app)).toEqual([])
    } finally {
      await app.close()
      removeTemp(p.dir)
      removeTemp(join(root, ".."))
    }
  })

  test("main runs commands for the shown commander only; the viewer has no such call", async () => {
    const { root } = folders()
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", root)
      const dirId = Number(
        await grid(c, "left")
          .locator("[data-id]", { hasText: "alpha" })
          .first()
          .getAttribute("data-id"),
      )
      const fileId = Number(
        await grid(c, "left")
          .locator("[data-id]", { hasText: "notes" })
          .first()
          .getAttribute("data-id"),
      )
      const call = (page: Page, params: unknown) =>
        page.evaluate(async (p) => {
          const shell = (window.panelyth as unknown as { shell: Record<string, unknown> }).shell
          const run = shell.run as ((p: unknown) => Promise<unknown>) | undefined
          return run
            ? ((await run(p)) as { ok: boolean; e?: { code: string; details?: unknown } })
            : null
        }, params)

      // A file is not a folder; a path is not an id; nothing else crosses the bridge.
      expect(await call(c, { command: "calc", dirId: fileId })).toMatchObject({
        ok: false,
        e: { code: "PERMISSION_DENIED", details: { reason: "folder" } },
      })
      expect(await call(c, { command: "calc", dirId: root })).toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
      expect(await call(c, { command: "a\nb", dirId })).toMatchObject({
        ok: false,
        e: { code: "INVALID_ARGUMENT" },
      })
      // A valid call from the shown commander is accepted (and recorded).
      expect(await call(c, { command: "rem ok", dirId, cwd: "C:\\", env: { X: "1" } })).toEqual({
        ok: true,
        r: { ok: true },
      })
      expect((await runs(app)).length).toBe(1)
      expect(samePath((await runs(app))[0]!.cwd, join(root, "alpha"))).toBe(true)
      expect((await runs(app))[0]!.env).toEqual({})

      // The viewer's view: no shell.run at all, and it cannot store a command for the commander.
      await c.getByTestId("app-switch").click()
      await expect.poll(() => shellState(app)).toMatchObject({ active: "viewer" })
      const viewer = await viewerOf(app)
      expect(await call(viewer, { command: "calc", dirId })).toBeNull()
      const planted = await viewer.evaluate(async () => {
        const res = await window.panelyth!.library.setSetting("commander.tools", {
          v: 1,
          commands: [{ id: "x1", title: "x", command: "calc" }],
        })
        return res.ok ? "stored" : res.e.code
      })
      expect(planted).toBe("PERMISSION_DENIED")

      // While the viewer is shown, the hidden commander's call is refused.
      expect(await call(c, { command: "calc", dirId })).toMatchObject({
        ok: false,
        e: { code: "PERMISSION_DENIED", details: { reason: "hidden" } },
      })
      expect((await runs(app)).length).toBe(1)
    } finally {
      await app.close()
      removeTemp(join(root, ".."))
    }
  })
})

test.describe("user commands, toolbar and settings (Stage C10)", () => {
  test("a command of the toolbar gets hostile names as single arguments; settings persist", async () => {
    const { root, other } = folders()
    const p = profile()
    let app = (await launch("commander", p.env)).app
    try {
      let c = await commanderOf(app)
      await goTo(c, "left", root)
      await goTo(c, "right", other)
      await c.getByTestId("panel-left").click()

      // Settings → Editor and tools: a command with every placeholder.
      await c.keyboard.press("Control+,")
      const dialog = c.getByRole("dialog")
      await dialog.getByRole("button", { name: "Editor and tools" }).click()
      await dialog.getByRole("button", { name: "Add a command…" }).click()
      const form = dialog.getByTestId("tool-form")
      await form.getByLabel("Name").fill("Probe")
      await form.getByLabel("Command", { exact: true }).fill("probe-tool")
      await form.getByLabel("Parameters").fill('"%P%N" --to %T %S --list %L')
      await form.getByRole("button", { name: "Save command" }).click()
      await expect(dialog.getByRole("list", { name: "Your commands" })).toContainText("Probe")

      // Settings → Panels: no function-key bar; letters go to the command line.
      await dialog.getByRole("button", { name: "Panels" }).click()
      await dialog.getByRole("checkbox", { name: "Function-key bar" }).uncheck()
      await dialog.getByLabel("Go to the command line (quick search starts with Alt)").check()
      await c.keyboard.press("Escape")
      await expect(dialog).toHaveCount(0)
      await expect(c.getByTestId("function-keys")).toHaveCount(0)
      expect(await runs(app)).toEqual([])

      // Mark the two hostile names; the cursor ends on notes.txt.
      await cursorTo(c, "left", OPTION)
      await c.keyboard.press("Insert")
      await c.keyboard.press("Insert")
      await expect(c.getByTestId("panel-left")).toContainText("2 of")
      await expect(grid(c, "left").locator("[data-cursor=true]")).toContainText("notes")
      await c.getByTestId("quick-actions").getByRole("button", { name: "Probe" }).click()
      await expect.poll(async () => (await runs(app)).length).toBe(1)
      const [run] = await runs(app)
      expect(samePath(run!.cwd, root)).toBe(true)
      const text = commandOf(run!)
      let listFile: string
      if (IS_WINDOWS) {
        // No name is in the command text; cmd.exe reads each from its own variable.
        expect(text).toBe(
          'probe-tool "%PANELYTH_ARG0%" --to "%PANELYTH_ARG1%" "%PANELYTH_ARG2%" "%PANELYTH_ARG3%" --list "%PANELYTH_ARG4%"',
        )
        expect(samePath(run!.env.PANELYTH_ARG0!, join(root, "notes.txt"))).toBe(true)
        // A folder's last backslash is doubled so it cannot escape the closing quote.
        expect(samePath(run!.env.PANELYTH_ARG1!, `${other}\\\\`)).toBe(true)
        expect([run!.env.PANELYTH_ARG2, run!.env.PANELYTH_ARG3].sort()).toEqual(
          [`.\\${OPTION}`, HOSTILE].sort(),
        )
        listFile = run!.env.PANELYTH_ARG4!
      } else {
        const q = (s: string): string => `'${s}'`
        expect(
          text.startsWith(`probe-tool ${q(join(root, "notes.txt"))} --to ${q(other + sep)} `),
        ).toBe(true)
        expect(text).toContain(q(`./${OPTION}`))
        expect(text).toContain(q(HOSTILE))
        listFile = /--list '([^']+)'$/.exec(text)![1]!
      }
      // %L: the marked entries' full paths, one per line, in the profile's own folder.
      expect(listFile.startsWith(join(p.dir, "user-data"))).toBe(true)
      const listed = readFileSync(listFile, "utf8").split(/\r?\n/).filter(Boolean)
      expect(listed.map((l) => l.toLowerCase()).sort()).toEqual(
        [join(root, OPTION), join(root, HOSTILE)].map((l) => l.toLowerCase()).sort(),
      )

      // After a restart: the button, the hidden bar and the letters setting are back.
      await sessionStored(c, root)
      await app.close()
      app = (await launch("commander", p.env)).app
      c = await commanderOf(app)
      await expect(path(c, "left")).toHaveText(root)
      await expect(
        c.getByTestId("quick-actions").getByRole("button", { name: "Probe" }),
      ).toBeVisible()
      await expect(c.getByTestId("function-keys")).toHaveCount(0)
      await grid(c, "left").focus()
      await c.keyboard.press("d")
      await expect(line(c)).toBeFocused()
      await expect(line(c)).toHaveValue("d")
      await expect(c.getByTestId("quicksearch-left")).toHaveCount(0)
      expect(await runs(app)).toEqual([])
    } finally {
      await app.close()
      removeTemp(p.dir)
      removeTemp(join(root, ".."))
    }
  })
})

interface TileScroll {
  frames: number
  p95FrameMs: number
  maxFrameGapMs: number
  longTasks: number
  longTaskMaxMs: number
  maxMountedTiles: number
  scrolledPx: number
}

/** Scrolls a panel's Thumbnails view in the page: a fast fling phase, then a slow one. */
function scrollTiles(
  c: Page,
  side: Side,
  fastMs: number,
  fastPx: number,
  slowMs: number,
): Promise<TileScroll> {
  return c.evaluate(
    async ({ side, fastMs, fastPx, slowMs }) => {
      const el = document.querySelector<HTMLElement>(`[data-testid="grid-${side}"]`)!
      const long: number[] = []
      const po = new PerformanceObserver((l) =>
        l.getEntries().forEach((e) => long.push(e.duration)),
      )
      po.observe({ type: "longtask" })
      const gaps: number[] = []
      let maxTiles = 0
      const run = (ms: number, px: number) =>
        new Promise<void>((resolve) => {
          const start = performance.now()
          let last = start
          const tick = (t: number): void => {
            gaps.push(t - last)
            last = t
            maxTiles = Math.max(maxTiles, el.querySelectorAll("[data-row]").length)
            el.scrollTop += px
            if (t - start < ms) requestAnimationFrame(tick)
            else resolve()
          }
          requestAnimationFrame(tick)
        })
      const top = el.scrollTop
      await run(fastMs, fastPx)
      await run(slowMs, 12)
      await new Promise((r) => setTimeout(r, 300))
      po.disconnect()
      const sorted = gaps.slice(1).sort((a, b) => a - b)
      return {
        frames: sorted.length,
        p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
        maxFrameGapMs: Math.round(sorted.at(-1) ?? 0),
        longTasks: long.length,
        longTaskMaxMs: Math.round(Math.max(0, ...long)),
        maxMountedTiles: maxTiles,
        scrolledPx: Math.round(el.scrollTop - top),
      }
    },
    { side, fastMs, fastPx, slowMs },
  )
}

const ipcCounts = (app: ElectronApplication) =>
  app.evaluate(
    () =>
      (
        globalThis as { __panelythIpcCounts?: () => Record<string, number> }
      ).__panelythIpcCounts?.() ?? {},
  )

test.describe("Thumbnails view (Stage C10)", () => {
  test("shows a folder's pictures as tiles with the cursor and marks of the panel", async () => {
    test.setTimeout(180_000)
    const fx = ensureFixture("images-150", {
      files: 0,
      images: { count: 150, width: 1600, height: 1200, pngAlphaEvery: 10, rotatedEvery: 7 },
    })
    const p = profile()
    let app = (await launch("commander", p.env)).app
    try {
      let c = await commanderOf(app)
      await goTo(c, "left", fx.root)
      await grid(c, "left").focus()
      await c.keyboard.press("Control+Shift+F1")
      await expect(grid(c, "left")).toHaveAttribute("data-view", "thumbs")
      await expect(grid(c, "left")).toBeFocused()
      // Real thumbnails from the shared preview cache.
      await expect
        .poll(
          () =>
            grid(c, "left").evaluate(
              (el) => [...el.querySelectorAll("img")].filter((img) => img.naturalWidth > 0).length,
            ),
          { timeout: 60_000 },
        )
        .toBeGreaterThan(5)
      const src = await grid(c, "left").locator("img").first().getAttribute("src")
      expect(src).toMatch(/^panelyth-thumb:/)
      const mounted = await grid(c, "left").locator("[data-row]").count()
      expect(mounted).toBeLessThanOrEqual(300)

      // The cursor moves by tiles and rows; Insert marks, as in the other views.
      const perRow = Number(await grid(c, "left").getAttribute("data-per-row"))
      expect(perRow).toBeGreaterThan(1)
      const cursor = () =>
        grid(c, "left").locator("[data-cursor=true]").getAttribute("data-row").then(Number)
      await c.keyboard.press("Home")
      await c.keyboard.press("ArrowRight")
      expect(await cursor()).toBe(1)
      await c.keyboard.press("ArrowDown")
      expect(await cursor()).toBe(1 + perRow)
      await c.keyboard.press("Insert")
      await expect(grid(c, "left").locator(`[data-row="${1 + perRow}"]`)).toHaveAttribute(
        "data-marked",
        "true",
      )
      await expect(c.getByTestId("panel-left")).toContainText("1 of")
      // The other panel is still a table.
      await expect(grid(c, "right")).toHaveAttribute("role", "grid")

      // The view comes back with the session.
      await sessionStored(c, fx.root, "thumbs")
      await app.close()
      app = (await launch("commander", p.env)).app
      c = await commanderOf(app)
      await expect(path(c, "left")).toHaveText(fx.root)
      await expect(grid(c, "left")).toHaveAttribute("data-view", "thumbs")
    } finally {
      await app.close()
      removeTemp(p.dir)
    }
  })

  // The viewer's tile parts moved to @panelyth/media-ui in this stage. Its own
  // e2e specs cannot open a folder since Stage C06 (the toolbar button they
  // use is gone), so the viewer gets its folder here the way a user gives it
  // one: carried over by the app switch.
  test("the viewer's tile view after the move: thumbnails, bounded tiles, no long tasks", async () => {
    test.setTimeout(300_000)
    const pictures = ensureFixture("images-150", {
      files: 0,
      images: { count: 150, width: 1600, height: 1200, pngAlphaEvery: 10, rotatedEvery: 7 },
    })
    const big = ensureFixture("flat-100k", { files: 100_000, nonMediaEvery: 10 })
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]!
        win.unmaximize()
        win.setContentSize(1920, 1100)
      })
      const viewerTiles = async (folder: string, entries: string): Promise<Page> => {
        await goTo(c, "left", folder)
        // The folder is listed completely before it is carried over.
        await expect(c.getByTestId("status-left")).toHaveText(new RegExp(`^${entries} entries`), {
          timeout: 120_000,
        })
        await c.getByTestId("app-switch").click()
        await expect.poll(() => shellState(app)).toMatchObject({ active: "viewer" })
        const viewer = await viewerOf(app)
        await expect(viewer.getByTestId("tile").first()).toBeVisible({ timeout: 60_000 })
        return viewer
      }

      // Real pictures: the tiles show thumbnails from the preview cache.
      const viewer = await viewerTiles(pictures.root, "150")
      await expect
        .poll(
          () =>
            viewer
              .getByTestId("tile-view")
              .evaluate(
                (el) => [...el.querySelectorAll("img")].filter((i) => i.naturalWidth > 0).length,
              ),
          { timeout: 60_000 },
        )
        .toBeGreaterThan(5)
      expect(await viewer.getByTestId("tile").count()).toBeLessThanOrEqual(300)
      // A selected tile still gets its frame (the style moved to the shared stylesheet).
      await viewer.getByTestId("tile").nth(1).click()
      const outline = await viewer
        .getByTestId("tile")
        .nth(1)
        .locator(".tile-selected")
        .evaluate((el) => getComputedStyle(el).outlineWidth)
      expect(outline).toBe("4px")

      // 90,000 media items: the viewer's tile budgets (docs/viewer/PERFORMANCE.md).
      await viewer.getByTestId("app-switch").click()
      await expect.poll(() => shellState(app)).toMatchObject({ active: "commander" })
      await viewerTiles(big.root, "100,000")
      await expect(viewer.getByTestId("folder-summary")).toHaveText(/^90,000 items/, {
        timeout: 120_000,
      })
      await viewer.waitForTimeout(500)
      const before = await ipcCounts(app)
      const scroll = await viewer.evaluate(async () => {
        const el = document.querySelector<HTMLElement>('[data-testid="tile-view"]')!
        const long: number[] = []
        const po = new PerformanceObserver((l) =>
          l.getEntries().forEach((e) => long.push(e.duration)),
        )
        po.observe({ type: "longtask" })
        const gaps: number[] = []
        let maxTiles = 0
        const run = (ms: number, px: number) =>
          new Promise<void>((resolve) => {
            const start = performance.now()
            let last = start
            const tick = (t: number): void => {
              gaps.push(t - last)
              last = t
              maxTiles = Math.max(
                maxTiles,
                document.querySelectorAll('[data-testid="tile"]').length,
              )
              el.scrollTop += px
              if (t - start < ms) requestAnimationFrame(tick)
              else resolve()
            }
            requestAnimationFrame(tick)
          })
        const top = el.scrollTop
        await run(3000, 400)
        await run(2000, 12)
        await new Promise((r) => setTimeout(r, 300))
        po.disconnect()
        const sorted = gaps.slice(1).sort((a, b) => a - b)
        return {
          frames: sorted.length,
          p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
          maxFrameGapMs: Math.round(sorted.at(-1) ?? 0),
          longTasks: long.length,
          longTaskMaxMs: Math.round(Math.max(0, ...long)),
          maxMountedTiles: maxTiles,
          scrolledPx: Math.round(el.scrollTop - top),
        }
      })
      const after = await ipcCounts(app)
      const result = {
        test: "viewer-scroll-100k-after-move",
        ...scroll,
        ensureCalls: (after["preview.ensure"] ?? 0) - (before["preview.ensure"] ?? 0),
      }
      writeResult(result)
      test.info().annotations.push({ type: "metrics", description: JSON.stringify(result) })
      expect(scroll.scrolledPx).toBeGreaterThan(100_000)
      expect(scroll.maxMountedTiles).toBeLessThanOrEqual(300)
      expectWithinBudget(scroll.longTaskMaxMs, 50, "longest task while the viewer scrolls (ms)")
      expect(result.ensureCalls).toBeLessThanOrEqual(10)
    } finally {
      await app.close()
    }
  })
})

test.describe("C10 benchmarks", () => {
  test("Thumbnails view scroll on 100k entries; the command line's start cost", async () => {
    test.setTimeout(300_000)
    const fx = ensureFixture("flat-100k", { files: 100_000, nonMediaEvery: 10 })
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]!
        win.unmaximize()
        win.setContentSize(1920, 1100)
      })
      await goTo(c, "left", fx.root)
      await expect(c.getByTestId("panel-left")).toContainText("100,000", { timeout: 120_000 })
      await grid(c, "left").focus()
      const t0 = Date.now()
      await c.keyboard.press("Control+Shift+F1")
      await expect(grid(c, "left")).toHaveAttribute("data-view", "thumbs")
      await expect(grid(c, "left").locator("[data-row][data-id]").first()).toBeVisible()
      const switchMs = Date.now() - t0
      await c.waitForTimeout(500)

      // The viewer's tile budgets (docs/viewer/PERFORMANCE.md): at most 300
      // mounted tiles, no long task over 50 ms, thumbnail requests per settled range.
      const before = await ipcCounts(app)
      const scroll = await scrollTiles(c, "left", 3000, 400, 2000)
      const after = await ipcCounts(app)
      const delta = (m: string): number => (after[m] ?? 0) - (before[m] ?? 0)
      const result = {
        test: "thumbs-scroll-100k",
        perRow: Number(await grid(c, "left").getAttribute("data-per-row")),
        switchToTilesMs: switchMs,
        ...scroll,
        ensureCalls: delta("preview.ensure"),
        pageCalls: delta("query.page"),
      }
      writeResult(result)
      test.info().annotations.push({ type: "metrics", description: JSON.stringify(result) })
      expect(scroll.scrolledPx).toBeGreaterThan(100_000)
      expect(scroll.maxMountedTiles).toBeLessThanOrEqual(300)
      expectWithinBudget(scroll.longTaskMaxMs, 50, "longest task while scrolling tiles (ms)")
      expect(result.ensureCalls).toBeLessThanOrEqual(10)

      // Enter in the command line → main has built and handed over the start
      // (recorded here; the cost of the shell process itself is measured by
      // the desktop package's BENCH_STAGE=C10 test).
      const dirId = await c.evaluate(async (root) => {
        const res = await window.panelyth!.dir.open({ path: root, recursive: false })
        return res.ok ? res.r.dirId : 0
      }, fx.root)
      const times = await c.evaluate(async (dirId) => {
        const shell = (
          window.panelyth as unknown as { shell: { run(p: unknown): Promise<unknown> } }
        ).shell
        const out: number[] = []
        for (let i = 0; i < 40; i++) {
          const start = performance.now()
          await shell.run({ command: "rem bench", dirId })
          out.push(performance.now() - start)
        }
        return out
      }, dirId)
      const sorted = times.slice(5).sort((a, b) => a - b)
      const round = (n: number): number => Math.round(n * 100) / 100
      const cost = {
        test: "command-line-start",
        runs: sorted.length,
        medianMs: round(sorted[Math.floor(sorted.length / 2)]!),
        p95Ms: round(sorted[Math.floor(sorted.length * 0.95)]!),
        maxMs: round(sorted.at(-1)!),
      }
      writeResult(cost)
      test.info().annotations.push({ type: "metrics", description: JSON.stringify(cost) })
      // One round trip to main and one to the sidecar: well inside a frame.
      expectWithinBudget(cost.p95Ms, 16, "Enter → the command handed to the shell (ms)")
    } finally {
      await app.close()
    }
  })
})
