import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { expect, test, type Page } from "@playwright/test"
import { goBinary } from "../../../../../scripts/go.mjs"
import { expectWithinBudget, removeTemp, repoRoot } from "../../launch"
import { commanderOf, cursorTo, goTo, launch, openFolder, scrollPanel, type Side } from "./helpers"

// Stage C10.5: connections to FTP and FTPS servers (CFR-31, ADR-0037;
// docs/commander/stages/C10.5-tabs-tree-ftp-compare.md; scenario 21 and the
// "Remote connections" safety list of docs/commander/TESTING.md). The server
// is cmd/ftpfixture on loopback: no test opens a connection to another host.
// Measurements: stage-C10.5-…-e2e-ftp.

const PASSWORD = "c0rrect-Horse_battery#staple"
const sidecarDir = join(repoRoot, "src", "shared", "sidecar")

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(
    repoRoot,
    "src",
    "shared",
    "bench",
    "results",
    `stage-C10.5-${date}-e2e-ftp.jsonl`,
  )
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

const grid = (c: Page, side: Side) => c.getByTestId(`grid-${side}`)
const path = (c: Page, side: Side) => c.getByTestId(`path-${side}`)
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const round = (x: number): number => Math.round(x * 10) / 10

// The fixture server ----------------------------------------------------------------

interface ServerStats {
  sessions: number
  clearPasswords: number
  commands: Record<string, number>
}

interface Ftp {
  host: string
  port: number
  fingerprint: string
  stats(): Promise<ServerStats>
  release(): Promise<void>
  stop(): void
}

let fixtureExe = ""

/** Builds cmd/ftpfixture once per run, beside the cached fixtures (one binary, replaced each run). */
function fixtureBinary(): string {
  if (fixtureExe) return fixtureExe
  const dir = join(tmpdir(), "panelyth-fixtures", "bin")
  mkdirSync(dir, { recursive: true })
  const exe = join(dir, process.platform === "win32" ? "ftpfixture.exe" : "ftpfixture")
  execFileSync(goBinary(), ["build", "-o", exe, "./cmd/ftpfixture"], {
    cwd: sidecarDir,
    timeout: 300_000,
  })
  return (fixtureExe = exe)
}

/** Serves `root` on loopback until stop(). */
async function startFtp(root: string, args: string[] = []): Promise<Ftp> {
  const child: ChildProcessWithoutNullStreams = spawn(fixtureBinary(), ["-root", root, ...args])
  const lines = createInterface({ input: child.stdout })
  const waiting: ((line: string) => void)[] = []
  const queued: string[] = []
  lines.on("line", (line) => {
    const next = waiting.shift()
    if (next) next(line)
    else queued.push(line)
  })
  const read = (): Promise<string> =>
    new Promise((resolve, reject) => {
      const line = queued.shift()
      if (line !== undefined) return resolve(line)
      const timer = setTimeout(() => reject(new Error("the FTP fixture did not answer")), 15_000)
      waiting.push((l) => {
        clearTimeout(timer)
        resolve(l)
      })
    })
  const ask = async <T>(command: string): Promise<T> => {
    child.stdin.write(command + "\n")
    return JSON.parse(await read()) as T
  }
  const started = JSON.parse(await read()) as { host: string; port: number; fingerprint: string }
  return {
    ...started,
    stats: () => ask<ServerStats>("stats"),
    release: async () => {
      await ask("release")
    },
    // Closing its input ends the server.
    stop: () => child.stdin.end(),
  }
}

/** The fingerprint as the certificate dialog shows it. */
const shown = (hex: string): string => (hex.toUpperCase().match(/.{1,2}/g) ?? []).join(":")

// The app ---------------------------------------------------------------------------

/** A profile kept across launches: library.db, the Electron profile (with the secret store's key), the cache and the logs. */
function profile() {
  const dir = mkdtempSync(join(tmpdir(), "panelyth-e2e-ftp-"))
  return {
    dir,
    env: {
      PANELYTH_CONFIG_DIR: join(dir, "config"),
      PANELYTH_USER_DATA_DIR: join(dir, "user-data"),
      PANELYTH_CACHE_DIR: join(dir, "cache"),
    },
  }
}

/** Every file below a folder that holds the text, in UTF-8 or UTF-16. */
function filesHolding(dir: string, text: string): string[] {
  const needles = [Buffer.from(text, "utf8"), Buffer.from(text, "utf16le")]
  const found: string[] = []
  const walk = (at: string): void => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      const p = join(at, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && statSync(p).size < 64 << 20) {
        let bytes: Buffer
        try {
          bytes = readFileSync(p)
        } catch {
          continue // locked by a process that is still closing
        }
        if (needles.some((n) => bytes.includes(n))) found.push(p)
      }
    }
  }
  walk(dir)
  return found
}

async function quickConnect(
  c: Page,
  side: Side,
  ftp: Ftp,
  o: { tls?: "explicit" | "none"; user?: string; password?: string } = {},
): Promise<void> {
  await grid(c, side).focus()
  await c.keyboard.press("Control+n")
  const form = c.getByTestId("quick-connect")
  await form.getByLabel("Server", { exact: true }).fill(ftp.host)
  await form.getByLabel("Port", { exact: true }).fill(String(ftp.port))
  await form.getByLabel("Encryption", { exact: true }).selectOption(o.tls ?? "none")
  if (o.user) await form.getByLabel("User name", { exact: true }).fill(o.user)
  if (o.password) await form.getByLabel("Password", { exact: true }).fill(o.password)
}

const url = (ftp: Ftp, user = ""): string =>
  `ftp://${user ? `${user}@` : ""}${ftp.host}:${ftp.port}`

/** Runs `act` in the page and returns the time until `side` shows `wanted` with entry rows painted. */
function untilRows(
  c: Page,
  side: Side,
  wanted: string,
  act: "submit-quick" | "enter" | "backspace",
): Promise<number> {
  return c.evaluate(
    ({ side, wanted, act }) => {
      const gridEl = document.querySelector<HTMLElement>(`[data-testid="grid-${side}"]`)!
      const t0 = performance.now()
      if (act === "submit-quick")
        document.querySelector<HTMLFormElement>('[data-testid="quick-connect"]')!.requestSubmit()
      else
        gridEl.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: act === "enter" ? "Enter" : "Backspace",
            bubbles: true,
          }),
        )
      return new Promise<number>((resolve, reject) => {
        const tick = (): void => {
          const at = document.querySelector(`[data-testid="path-${side}"]`)?.textContent ?? ""
          if (at === wanted && gridEl.querySelector("[data-id]")) resolve(performance.now() - t0)
          else if (performance.now() - t0 > 30_000) reject(new Error(`no rows for ${wanted}`))
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    },
    { side, wanted, act },
  )
}

/** The newest job's id in the queue (0 when it is empty): ids only grow. */
const newestJob = (c: Page): Promise<number> =>
  c.evaluate(() =>
    Math.max(
      0,
      ...[...document.querySelectorAll<HTMLElement>('[data-testid="queue"] li[data-state]')].map(
        (r) => Number(r.dataset.testid?.slice(4)),
      ),
    ),
  )

/** Waits until a job newer than `after` reaches one of the states; returns its id and state. */
async function newJob(
  c: Page,
  after: number,
  states: string[],
  timeout: number,
): Promise<{ jobId: number; state: string }> {
  const handle = await c
    .waitForFunction(
      ({ after, states }) => {
        const rows = [
          ...document.querySelectorAll<HTMLElement>('[data-testid="queue"] li[data-state]'),
        ]
        for (const r of rows) {
          const jobId = Number(r.dataset.testid?.slice(4))
          const state = r.dataset.state ?? ""
          if (jobId > after && states.includes(state)) return { jobId, state }
        }
        return null
      },
      { after, states },
      { polling: "raf", timeout },
    )
    .catch(async (error: unknown) => {
      // Say what the queue shows instead of only that time ran out.
      const rows = await c.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-testid="queue"] li[data-state]')].map(
          (r) => `${r.dataset.testid} ${r.dataset.state}: ${r.textContent}`,
        ),
      )
      throw new Error(`${String(error)}
queue (after job ${after}): ${JSON.stringify(rows)}`)
    })
  return (await handle.jsonValue()) as { jobId: number; state: string }
}

const ENDED = ["completed", "failed", "cancelled"]

/** Confirms an open copy or delete dialog and waits until the job it starts has ended; returns the time. */
async function runJob(c: Page, timeout = 120_000): Promise<{ ms: number; state: string }> {
  const after = await newestJob(c)
  const t0 = Date.now()
  // The dialog's own button: Enter does not submit while a list in it has focus.
  await c.evaluate(() =>
    document
      .querySelector<HTMLFormElement>('[data-testid="copy-dialog"], [data-testid="delete-dialog"]')!
      .requestSubmit(),
  )
  const job = await newJob(c, after, ENDED, timeout)
  return { ms: Date.now() - t0, state: job.state }
}

test.describe("FTP connections (Stage C10.5)", () => {
  test("scenario 21: save a connection, work on the server, restart, connect again", async () => {
    test.setTimeout(180_000)
    const root = mkdtempSync(join(tmpdir(), "panelyth-ftp-root-"))
    writeFileSync(join(root, "readme.txt"), "hello from the server")
    mkdirSync(join(root, "pub"))
    writeFileSync(join(root, "pub", "notes.txt"), "notes")
    const local = mkdtempSync(join(tmpdir(), "panelyth-ftp-local-"))
    writeFileSync(join(local, "upload.txt"), "from this computer")
    const ftp = await startFtp(root, ["-tls", "-user", "alice", "-password", PASSWORD])
    const p = profile()
    const home = `${url(ftp, "alice")}/`
    let { app } = await launch("commander", p.env)
    try {
      let c = await commanderOf(app)
      await goTo(c, "right", local)
      await openFolder(c, "left", local)
      await grid(c, "left").focus()

      // Save a connection, with its password. Saving connects to nothing.
      await c.keyboard.press("Control+Shift+N")
      await c.getByTestId("connections-dialog").getByRole("button", { name: "New…" }).click()
      const form = c.getByTestId("connection-form")
      await form.getByLabel("Name", { exact: true }).fill("Fixture")
      await form.getByLabel("Server", { exact: true }).fill(ftp.host)
      await form.getByLabel("Port", { exact: true }).fill(String(ftp.port))
      await form.getByLabel("User name", { exact: true }).fill("alice")
      await form.getByLabel("Password", { exact: true }).fill(PASSWORD)
      await expect(form.getByRole("checkbox", { name: /Save the password/ })).toBeChecked()
      await form.getByRole("button", { name: "Save", exact: true }).click()
      const list = c.getByTestId("connections-dialog")
      await expect(list.getByRole("option", { name: /Fixture/ })).toBeVisible()
      expect((await ftp.stats()).sessions).toBe(0)

      // Connect: the certificate is nobody's; its fingerprint is shown before anything else happens.
      await list.getByRole("button", { name: "Connect", exact: true }).click()
      const cert = c.getByTestId("certificate-prompt")
      await expect(cert.getByTestId("fingerprint")).toHaveText(shown(ftp.fingerprint))
      expect((await ftp.stats()).commands.PASS ?? 0).toBe(0)
      await cert.getByRole("button", { name: "Always trust this certificate" }).click()
      await expect(path(c, "left")).toHaveText(home)
      await expect(c.getByTestId("remote-left")).toHaveAttribute("data-encrypted", "true")
      await expect(grid(c, "left").locator("[data-id]", { hasText: "readme" })).toBeVisible()
      // The password crossed the wire under TLS only.
      const afterLogin = await ftp.stats()
      expect(afterLogin.clearPasswords).toBe(0)
      expect(afterLogin.commands.PASS).toBe(1)

      // Browse.
      await cursorTo(c, "left", "pub")
      await c.keyboard.press("Enter")
      await expect(path(c, "left")).toHaveText(`${home}pub`)
      await expect(grid(c, "left").locator("[data-id]", { hasText: "notes" })).toBeVisible()
      await c.keyboard.press("Backspace")
      await expect(path(c, "left")).toHaveText(home)
      await expect(grid(c, "left").locator("[data-cursor=true]")).toContainText("pub")

      // Download with F5; then the same file again with each answer to "the name exists".
      await cursorTo(c, "left", "readme")
      await c.keyboard.press("F5")
      await expect(c.getByRole("dialog")).toContainText("Download readme.txt")
      await expect(c.getByLabel("Destination", { exact: true })).toHaveValue(local)
      expect((await runJob(c)).state).toBe("completed")
      expect(readFileSync(join(local, "readme.txt"), "utf8")).toBe("hello from the server")
      writeFileSync(join(local, "readme.txt"), "changed here")
      await grid(c, "left").focus()
      await c.keyboard.press("F5")
      await c.getByLabel("If the name exists", { exact: true }).selectOption("skip")
      expect((await runJob(c)).state).toBe("completed")
      expect(readFileSync(join(local, "readme.txt"), "utf8")).toBe("changed here")
      await grid(c, "left").focus()
      await c.keyboard.press("F5")
      await c.getByLabel("If the name exists", { exact: true }).selectOption("replace")
      expect((await runJob(c)).state).toBe("completed")
      expect(readFileSync(join(local, "readme.txt"), "utf8")).toBe("hello from the server")
      // Nothing but the file itself is left beside it.
      expect(readdirSync(local).sort()).toEqual(["readme.txt", "upload.txt"])

      // Upload with F5 from the other panel: into the folder the server's panel shows.
      await cursorTo(c, "right", "upload")
      await c.keyboard.press("F5")
      await expect(c.getByRole("dialog")).toContainText("Upload upload.txt")
      await expect(c.getByLabel("Destination", { exact: true })).toHaveValue(home)
      expect((await runJob(c)).state).toBe("completed")
      expect(readFileSync(join(root, "upload.txt"), "utf8")).toBe("from this computer")
      // The server's folder is read again after the job.
      await expect(grid(c, "left").locator("[data-id]", { hasText: "upload" })).toBeVisible()

      // New folder, rename and delete act on the server.
      await cursorTo(c, "left", "readme")
      await c.keyboard.press("F7")
      await c.getByLabel("Folder name", { exact: true }).fill("inbox")
      await c.keyboard.press("Enter")
      await expect.poll(() => existsSync(join(root, "inbox"))).toBe(true)
      await expect(grid(c, "left").locator("[data-cursor=true]")).toContainText("inbox")
      await c.keyboard.press("F2")
      await c.getByLabel("New name", { exact: true }).fill("outbox")
      await c.keyboard.press("Enter")
      await expect.poll(() => existsSync(join(root, "outbox"))).toBe(true)
      expect(existsSync(join(root, "inbox"))).toBe(false)
      await expect(grid(c, "left").locator("[data-cursor=true]")).toContainText("outbox")
      await c.keyboard.press("F8")
      await expect(c.getByRole("dialog")).toContainText("Delete outbox on the server?")
      await expect(c.getByRole("dialog")).toContainText("A server has no trash.")
      expect((await runJob(c)).state).toBe("completed")
      expect(existsSync(join(root, "outbox"))).toBe(false)

      // What needs files of this computer says so, and starts nothing.
      await cursorTo(c, "left", "readme")
      await c.keyboard.press("Control+c")
      await expect(c.getByTestId("files-notice")).toContainText(
        "This is not available on a connection.",
      )

      // A wrong password: said, and asked again; Cancel leaves the panel alone.
      await quickConnect(c, "right", ftp, { tls: "explicit", user: "alice", password: "wrong" })
      await c
        .getByTestId("quick-connect")
        .getByRole("button", { name: "Connect", exact: true })
        .click()
      await c
        .getByTestId("certificate-prompt")
        .getByRole("button", { name: "Trust this time" })
        .click()
      const ask = c.getByTestId("password-prompt")
      await expect(ask).toContainText("The server refused the user name or the password.")
      await ask.getByRole("button", { name: "Cancel", exact: true }).click()
      await c
        .getByTestId("quick-connect")
        .getByRole("button", { name: "Cancel", exact: true })
        .click()
      await expect(path(c, "right")).toHaveText(local)

      // Restart: the tab remembers where it was, and nothing connects.
      await grid(c, "left").focus()
      await cursorTo(c, "left", "pub")
      await c.keyboard.press("Enter")
      await expect(path(c, "left")).toHaveText(`${home}pub`)
      await c.waitForTimeout(800) // the session is written after a pause
      await app.close()
      const before = await ftp.stats()

      // The clear password is in no file of the profile: not in library.db, not in a log, not in a setting.
      expect(filesHolding(p.dir, PASSWORD)).toEqual([])
      // The connection itself is there.
      expect(filesHolding(join(p.dir, "config"), "Fixture").length).toBeGreaterThan(0)

      ;({ app } = await launch("commander", p.env))
      c = await commanderOf(app)
      const idle = c.getByTestId("disconnected-left")
      await expect(idle).toContainText("Not connected")
      await expect(idle).toContainText(`${home}pub`)
      await c.waitForTimeout(1000)
      expect((await ftp.stats()).sessions).toBe(before.sessions)

      // Connect: the stored password and the remembered certificate; no question.
      await idle.getByRole("button", { name: "Connect", exact: true }).click()
      await expect(path(c, "left")).toHaveText(`${home}pub`)
      await expect(grid(c, "left").locator("[data-id]", { hasText: "notes" })).toBeVisible()
      await expect(c.getByTestId("password-prompt")).toHaveCount(0)
      await expect(c.getByTestId("certificate-prompt")).toHaveCount(0)
      const end = await ftp.stats()
      expect(end.sessions).toBeGreaterThan(before.sessions)
      expect(end.clearPasswords).toBe(0)

      // Disconnect: back to the folder of this computer.
      await grid(c, "left").focus()
      await c.keyboard.press("Control+Shift+F")
      await expect(path(c, "left")).toHaveText(local)
    } finally {
      await app.close().catch(() => undefined)
      ftp.stop()
      removeTemp(root)
      removeTemp(local)
      removeTemp(p.dir)
    }
  })

  test("a connection that asks for TLS never goes on without it, and no password is sent", async () => {
    const root = mkdtempSync(join(tmpdir(), "panelyth-ftp-root-"))
    writeFileSync(join(root, "readme.txt"), "x")
    const ftp = await startFtp(root, ["-user", "alice", "-password", PASSWORD])
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await quickConnect(c, "left", ftp, { tls: "explicit", user: "alice", password: PASSWORD })
      await c
        .getByTestId("quick-connect")
        .getByRole("button", { name: "Connect", exact: true })
        .click()
      await expect(c.getByTestId("quick-connect").getByRole("alert")).toHaveText(
        "The server does not offer encryption (TLS).",
      )
      const stats = await ftp.stats()
      expect(stats.commands.PASS ?? 0).toBe(0)
      expect(stats.clearPasswords).toBe(0)

      // Plain FTP is the user's choice, said where it is made and where they work.
      await c
        .getByTestId("quick-connect")
        .getByLabel("Encryption", { exact: true })
        .selectOption("none")
      await expect(c.getByTestId("quick-connect").getByRole("note")).toContainText("Not encrypted")
      await c
        .getByTestId("quick-connect")
        .getByRole("button", { name: "Connect", exact: true })
        .click()
      await expect(path(c, "left")).toHaveText(`${url(ftp, "alice")}/`)
      await expect(c.getByTestId("remote-left")).toHaveText("Not encrypted")
    } finally {
      await app.close().catch(() => undefined)
      ftp.stop()
      removeTemp(root)
    }
  })

  test("without a secret store a password is not saved, and the form says so", async () => {
    const root = mkdtempSync(join(tmpdir(), "panelyth-ftp-root-"))
    const ftp = await startFtp(root, ["-user", "alice", "-password", PASSWORD])
    const p = profile()
    const { app } = await launch("commander", {
      ...p.env,
      PANELYTH_TEST_NO_SECRET_STORE: "1",
    })
    try {
      const c = await commanderOf(app)
      await grid(c, "left").focus()
      await c.keyboard.press("Control+Shift+N")
      await c.getByTestId("connections-dialog").getByRole("button", { name: "New…" }).click()
      const form = c.getByTestId("connection-form")
      await expect(form).toContainText("This computer has no secure store for passwords.")
      await expect(form.getByRole("checkbox", { name: /Save the password/ })).toHaveCount(0)
      await form.getByLabel("Name", { exact: true }).fill("NoStore")
      await form.getByLabel("Server", { exact: true }).fill(ftp.host)
      await form.getByLabel("Port", { exact: true }).fill(String(ftp.port))
      await form.getByLabel("Encryption", { exact: true }).selectOption("none")
      await form.getByLabel("User name", { exact: true }).fill("alice")
      await form.getByLabel("Password", { exact: true }).fill(PASSWORD)
      await form.getByRole("button", { name: "Save", exact: true }).click()
      await expect(
        c.getByTestId("connections-dialog").getByRole("option", { name: /NoStore/ }),
      ).toBeVisible()
      // Connecting asks for the password each time.
      await c
        .getByTestId("connections-dialog")
        .getByRole("button", { name: "Connect", exact: true })
        .click()
      const ask = c.getByTestId("password-prompt")
      await expect(ask).toBeVisible()
      await expect(ask.getByRole("checkbox")).toHaveCount(0)
      await ask.getByLabel("Password", { exact: true }).fill(PASSWORD)
      await ask.getByRole("button", { name: "Connect", exact: true }).click()
      await expect(path(c, "left")).toHaveText(`${url(ftp, "alice")}/`)
      await c.waitForTimeout(800)
      await app.close()
      expect(filesHolding(p.dir, PASSWORD)).toEqual([])
    } finally {
      await app.close().catch(() => undefined)
      ftp.stop()
      removeTemp(root)
      removeTemp(p.dir)
    }
  })

  test("a server that stops answering: the other panel stays fluid, and Stop ends the wait", async () => {
    test.setTimeout(90_000)
    const root = mkdtempSync(join(tmpdir(), "panelyth-ftp-root-"))
    writeFileSync(join(root, "readme.txt"), "x")
    const local = mkdtempSync(join(tmpdir(), "panelyth-ftp-local-"))
    for (let i = 0; i < 2000; i++)
      writeFileSync(join(local, `f${String(i).padStart(5, "0")}.txt`), "")
    // It takes the login, then never answers a listing.
    const ftp = await startFtp(root, ["-stall", "LIST", "-no-mlsd"])
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "right", local)
      await openFolder(c, "left", local)
      await quickConnect(c, "left", ftp)
      await c
        .getByTestId("quick-connect")
        .getByRole("button", { name: "Connect", exact: true })
        .click()
      const waiting = c.getByTestId("remote-busy-left")
      await expect(waiting).toContainText("Waiting for the server…")
      // The panel still shows its folder.
      await expect(path(c, "left")).toHaveText(local)

      // The other panel while the server is silent: a held Down key.
      await grid(c, "right").locator("[data-id]").first().click()
      const held = await c.evaluate(async () => {
        const gridEl = document.querySelector<HTMLElement>('[data-testid="grid-right"]')!
        const long: number[] = []
        const po = new PerformanceObserver((l) =>
          l.getEntries().forEach((e) => long.push(e.duration)),
        )
        po.observe({ type: "longtask" })
        const gaps: number[] = []
        await new Promise<void>((resolve) => {
          const start = performance.now()
          let last = start
          const tick = (t: number): void => {
            gaps.push(t - last)
            last = t
            gridEl.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))
            if (t - start < 2000) requestAnimationFrame(tick)
            else resolve()
          }
          requestAnimationFrame(tick)
        })
        await new Promise((r) => setTimeout(r, 200))
        po.disconnect()
        const sorted = gaps.slice(1).sort((a, b) => a - b)
        const row = Number(
          gridEl.querySelector<HTMLElement>("[data-cursor=true]")?.dataset.row ?? 0,
        )
        return {
          frames: sorted.length,
          p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
          maxFrameGapMs: Math.round(sorted.at(-1) ?? 0),
          longTasks: long.length,
          cursorRow: row,
        }
      })
      expect(held.cursorRow).toBeGreaterThan(50)
      expect(held.longTasks).toBe(0)

      // Stop: the wait ends in the panel at once.
      const stopMs = await c.evaluate(() => {
        const chip = document.querySelector('[data-testid="remote-busy-left"]')!
        const t0 = performance.now()
        chip.querySelector("button")!.click()
        return new Promise<number>((resolve) => {
          const tick = (): void => {
            if (!document.querySelector('[data-testid="remote-busy-left"]'))
              resolve(performance.now() - t0)
            else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        })
      })
      await expect(path(c, "left")).toHaveText(local)
      await expect(c.getByTestId("error-left")).toHaveCount(0)
      writeResult({
        bench: "dead-server",
        otherPanel: held,
        stopMs: round(stopMs),
        budget: { otherPanelLongTasks: 0, stopMs: 200 },
      })
      expectWithinBudget(stopMs, 200, "Stop on a server that does not answer")
      expectWithinBudget(held.p95FrameMs, 34, "other panel's frame while a server hangs")
    } finally {
      await app.close().catch(() => undefined)
      ftp.stop()
      removeTemp(root)
      removeTemp(local)
    }
  })
})

// Benchmarks -------------------------------------------------------------------------

const BIG_MB = Number(process.env.PANELYTH_FTP_BIG_MB ?? 1024)

/** The benchmark tree, generated once per machine: many/ (10,000 files), small/ (1,000 × 10 KB), big.bin. */
function benchTree(): string {
  const root = join(tmpdir(), "panelyth-fixtures", "ftp-server")
  const marker = join(root, `.ready-v1-${BIG_MB}`)
  const whole =
    existsSync(marker) &&
    existsSync(join(root, "many", "f09999.txt")) &&
    existsSync(join(root, "small", "s0999.bin")) &&
    existsSync(join(root, "big.bin")) &&
    statSync(join(root, "big.bin")).size === BIG_MB << 20
  if (whole) return root
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, "many"), { recursive: true })
  for (let i = 0; i < 10_000; i++)
    writeFileSync(join(root, "many", `f${String(i).padStart(5, "0")}.txt`), "")
  mkdirSync(join(root, "small"))
  const block = Buffer.alloc(10_000, 7)
  for (let i = 0; i < 1000; i++)
    writeFileSync(join(root, "small", `s${String(i).padStart(4, "0")}.bin`), block)
  // Not zeros: nothing on the way can shortcut it.
  const chunk = Buffer.alloc(8 << 20)
  for (let i = 0; i < chunk.length; i += 4) chunk.writeUInt32LE((i * 2654435761) >>> 0, i)
  writeFileSync(join(root, "big.bin"), "")
  for (let i = 0; i < BIG_MB / 8; i++) appendFileSync(join(root, "big.bin"), chunk)
  writeFileSync(marker, "")
  return root
}

/** Seconds curl takes; null when there is no curl here. */
function curl(args: string[]): number | null {
  const t0 = performance.now()
  try {
    execFileSync("curl", ["-s", "-S", "--fail", ...args], { timeout: 300_000, stdio: "pipe" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  return (performance.now() - t0) / 1000
}

const sameBytes = (a: string, b: string): boolean => {
  // The first and the last megabyte and the size: enough to tell a whole copy.
  const size = statSync(a).size
  if (size !== statSync(b).size) return false
  const read = (file: string, at: number): Buffer => {
    const fd = openSync(file, "r")
    const out = Buffer.alloc(1 << 20)
    readSync(fd, out, 0, out.length, at)
    closeSync(fd)
    return out
  }
  return (
    read(a, 0).equals(read(b, 0)) &&
    read(a, Math.max(0, size - (1 << 20))).equals(read(b, Math.max(0, size - (1 << 20))))
  )
}

test.describe("FTP benchmarks (Stage C10.5)", () => {
  test("connect, a 10,000-entry folder, and transfers against curl", async () => {
    test.setTimeout(900_000)
    const root = benchTree()
    const up = `up-${process.pid}`
    mkdirSync(join(root, up), { recursive: true })
    const local = mkdtempSync(join(tmpdir(), "panelyth-ftp-bench-"))
    const scratch = mkdtempSync(join(tmpdir(), "panelyth-ftp-curl-"))
    // Uploads are received without their data being written: the upload numbers are the
    // app's (and curl's) sending, not this computer's disk. Against a server that writes
    // them here, both vary between 0.8 and 2.6 s per GiB, with stalls of many seconds.
    const ftp = await startFtp(root, ["-discard-uploads"])
    const base = url(ftp)
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await openFolder(c, "right", local)
      await openFolder(c, "left", local)

      // Connect → the first rows of the server's root.
      await quickConnect(c, "left", ftp)
      const connectMs = await untilRows(c, "left", `${base}/`, "submit-quick")

      // A folder of 10,000 entries → first rows; each time read from the server again.
      await cursorTo(c, "left", "many")
      const enters: number[] = []
      for (let i = 0; i < 7; i++) {
        enters.push(await untilRows(c, "left", `${base}/many`, "enter"))
        await expect(c.getByTestId("status-left")).toContainText("10,000")
        await untilRows(c, "left", `${base}/`, "backspace")
        await expect(grid(c, "left").locator("[data-cursor=true]")).toContainText("many")
      }
      await untilRows(c, "left", `${base}/many`, "enter")
      const scroll = await scrollPanel(c, "left", 2000, 600)
      await untilRows(c, "left", `${base}/`, "backspace")
      const listing = {
        bench: "remote-listing",
        entries: 10_000,
        connectToRowsMs: round(connectMs),
        enterMs: enters.map(round),
        enterMedianMs: round(median(enters)),
        enterMaxMs: round(Math.max(...enters)),
        scroll,
        budget: { enterMs: 500 },
      }
      writeResult(listing)

      // One large file up; the app and curl take turns, and each one's best run counts. The
      // source is the fixture's own file, shown in the other panel as a folder of this computer.
      const bytes = statSync(join(root, "big.bin")).size
      const haveCurl =
        curl([
          "-o",
          join(scratch, "probe.txt"),
          `ftp://${ftp.host}:${ftp.port}/many/f00000.txt`,
        ]) !== null
      await openFolder(c, "right", root)
      await cursorTo(c, "left", up)
      await c.keyboard.press("Enter")
      await expect(path(c, "left")).toHaveText(`${base}/${up}`)
      // What a job costs before and after its bytes: the same upload of a file of 1 KiB. A
      // gigabyte takes half a second here, so this fixed part is a third of the time; the
      // throughput below is of the bytes alone, for the app and for curl (its start and login).
      if (!existsSync(join(root, "tiny.bin")))
        writeFileSync(join(root, "tiny.bin"), Buffer.alloc(1024, 3))
      await grid(c, "right").focus()
      await c.keyboard.press("Control+r")
      const tinyUps: number[] = []
      const curlTinyUps: number[] = []
      for (let run = 0; run < 3; run++) {
        await cursorTo(c, "right", "tiny")
        await c.keyboard.press("F5")
        await expect(c.getByRole("dialog")).toContainText("Upload tiny.bin")
        await c.getByLabel("If the name exists", { exact: true }).selectOption("replace")
        const job = await runJob(c, 60_000)
        expect(job.state).toBe("completed")
        tinyUps.push(job.ms / 1000)
        if (haveCurl) {
          const s = curl([
            "-T",
            join(root, "tiny.bin"),
            `ftp://${ftp.host}:${ftp.port}/${up}/curl-tiny.bin`,
          ])
          if (s !== null) curlTinyUps.push(s)
        }
      }
      const ups: number[] = []
      const curlUps: number[] = []
      for (let run = 0; run < 3; run++) {
        await cursorTo(c, "right", "big")
        await c.keyboard.press("F5")
        await expect(c.getByRole("dialog")).toContainText("Upload big.bin")
        await c.getByLabel("If the name exists", { exact: true }).selectOption("replace")
        const job = await runJob(c, 300_000)
        expect(job.state).toBe("completed")
        ups.push(job.ms / 1000)
        // All of it arrived (its bytes are checked where a server writes them: scenario 21).
        expect(statSync(join(root, up, "big.bin")).size).toBe(bytes)
        if (haveCurl) {
          const s = curl([
            "-T",
            join(root, "big.bin"),
            `ftp://${ftp.host}:${ftp.port}/${up}/curl.bin`,
          ])
          if (s !== null) curlUps.push(s)
        }
      }
      rmSync(join(root, up, "big.bin"), { force: true })
      rmSync(join(root, up, "curl.bin"), { force: true })
      await openFolder(c, "right", local)
      await grid(c, "left").focus()
      await c.keyboard.press("Backspace")
      await expect(path(c, "left")).toHaveText(`${base}/`)
      await c.waitForTimeout(4000)

      // The same file down. During it: long tasks in the renderer.
      await cursorTo(c, "left", "big")
      const downs: number[] = []
      const curlDowns: number[] = []
      let longTasks: number[] = []
      for (let run = 0; run < 2; run++) {
        rmSync(join(local, "big.bin"), { force: true })
        await grid(c, "left").focus()
        await c.keyboard.press("F5")
        await expect(c.getByRole("dialog")).toContainText("Download big.bin")
        await c.evaluate(() => {
          const w = window as unknown as { __long: number[]; __po: PerformanceObserver }
          w.__long = []
          w.__po = new PerformanceObserver((l) =>
            l.getEntries().forEach((e) => w.__long.push(e.duration)),
          )
          w.__po.observe({ type: "longtask" })
        })
        const job = await runJob(c, 300_000)
        expect(job.state).toBe("completed")
        longTasks = longTasks.concat(
          await c.evaluate(() => {
            const w = window as unknown as { __long: number[]; __po: PerformanceObserver }
            w.__po.disconnect()
            return w.__long
          }),
        )
        downs.push(job.ms / 1000)
        await c.waitForTimeout(4000)
        if (haveCurl) {
          const s = curl(["-o", join(scratch, "big.bin"), `ftp://${ftp.host}:${ftp.port}/big.bin`])
          if (s !== null) curlDowns.push(s)
          await c.waitForTimeout(4000)
        }
      }
      expect(sameBytes(join(root, "big.bin"), join(local, "big.bin"))).toBe(true)
      rmSync(join(scratch, "big.bin"), { force: true })

      // Cancel a download that is under way: the partial file goes, the file that was there stays.
      await grid(c, "left").focus()
      await c.keyboard.press("F5")
      await c.getByLabel("If the name exists", { exact: true }).selectOption("replace")
      const afterJob = await newestJob(c)
      await c
        .getByTestId("copy-dialog")
        .getByRole("button", { name: "Download", exact: true })
        .click()
      const started = await newJob(c, afterJob, ["running", ...ENDED], 30_000)
      let cancelMs: number | null = null
      let cancelled = false
      if (started.state === "running") {
        await c
          .getByTestId(`job-${started.jobId}`)
          .getByRole("button", { name: "Cancel", exact: true })
          .click()
        const t0 = Date.now()
        const ended = await newJob(c, afterJob, ENDED, 30_000)
        cancelMs = Date.now() - t0
        cancelled = ended.state === "cancelled"
      }
      if (cancelled) {
        await expect.poll(() => readdirSync(local).sort()).toEqual(["big.bin"])
        expect(sameBytes(join(root, "big.bin"), join(local, "big.bin"))).toBe(true)
      }

      // 1,000 files of 10 KB: all marked, one download job.
      await cursorTo(c, "left", "small")
      await c.keyboard.press("Enter")
      await expect(path(c, "left")).toHaveText(`${base}/small`)
      await expect(c.getByTestId("status-left")).toContainText("1,000")
      mkdirSync(join(local, "small"))
      await openFolder(c, "right", join(local, "small"))
      await grid(c, "left").focus()
      await c.keyboard.press("Control+a")
      await c.keyboard.press("F5")
      await expect(c.getByRole("dialog")).toContainText("Download 1,000 items")
      const smallDown = await runJob(c, 300_000)
      expect(smallDown.state).toBe("completed")
      expect(readdirSync(join(local, "small")).length).toBe(1000)
      mkdirSync(join(scratch, "small"))
      const curlSmall = haveCurl
        ? curl([
            "--output-dir",
            join(scratch, "small"),
            "--remote-name-all",
            `ftp://${ftp.host}:${ftp.port}/small/s[0000-0999].bin`,
          ])
        : null

      const ms = (seconds: number[]): number[] => seconds.map((s) => Math.round(s * 1000))
      /** MiB/s of the best run; with `fixed`, of its bytes alone (less the best 1 KiB run). */
      const mbps = (seconds: number[], fixed: number[] = []): number | null =>
        seconds.length === 0
          ? null
          : round(
              bytes /
                (1 << 20) /
                (Math.min(...seconds) - (fixed.length === 0 ? 0 : Math.min(...fixed))),
            )
      const ratio = (ours: number | null, theirs: number | null): number | null =>
        ours === null || theirs === null ? null : Math.round((ours / theirs) * 100) / 100
      const transfers = {
        bench: "remote-transfers",
        bigMiB: BIG_MB,
        downloadSeconds: downs.map(round),
        curlDownloadSeconds: curlDowns.map(round),
        downloadMiBps: mbps(downs),
        curlDownloadMiBps: mbps(curlDowns),
        downloadVsCurl: ratio(mbps(downs), mbps(curlDowns)),
        uploadMs: ms(ups),
        curlUploadMs: ms(curlUps),
        tinyUploadMs: ms(tinyUps),
        curlTinyUploadMs: ms(curlTinyUps),
        // Of the whole job, and of the bytes alone (the job less a 1 KiB job).
        uploadJobMiBps: mbps(ups),
        curlUploadJobMiBps: mbps(curlUps),
        uploadMiBps: mbps(ups, tinyUps),
        curlUploadMiBps: mbps(curlUps, curlTinyUps),
        uploadVsCurl: ratio(mbps(ups, tinyUps), mbps(curlUps, curlTinyUps)),
        uploadJobVsCurl: ratio(mbps(ups), mbps(curlUps)),
        small: {
          files: 1000,
          bytesEach: 10_000,
          downloadSeconds: round(smallDown.ms / 1000),
          curlSeconds: curlSmall === null ? null : round(curlSmall),
        },
        rendererLongTasksDuringDownloads: longTasks.length,
        rendererLongTaskMaxMs: Math.round(Math.max(0, ...longTasks)),
        cancel: { cancelled, cancelMs },
        curl: haveCurl ? "present" : "missing",
        note: "best run of each, the two taking turns; uploads go to a server that does not write their data, downloads are written to disk by both",
        uploadsWrittenByServer: false,
        budget: { vsCurl: 0.8, longTasks: 0 },
      }
      writeResult(transfers)

      expectWithinBudget(median(enters), 500, "remote folder of 10,000 entries → first rows")
      expect(scroll.maxMountedRows).toBeLessThan(200)
      expect(longTasks.filter((d) => d > 50)).toEqual([])
      if (transfers.downloadVsCurl !== null && !process.env.CI)
        expect(transfers.downloadVsCurl, "download throughput against curl").toBeGreaterThan(0.8)
      if (transfers.uploadVsCurl !== null && !process.env.CI)
        expect(transfers.uploadVsCurl, "upload throughput against curl").toBeGreaterThan(0.8)
    } finally {
      await app.close().catch(() => undefined)
      ftp.stop()
      removeTemp(join(root, up))
      removeTemp(local)
      removeTemp(scratch)
    }
  })
})
