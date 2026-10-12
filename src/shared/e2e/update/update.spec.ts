import { execFileSync, spawnSync } from "node:child_process"
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join, normalize } from "node:path"
import { _electron, expect, test } from "@playwright/test"
import { desktopDir, repoRoot, waitForReady } from "../launch"

// Stage P06 (ADR-0038): the product is installed, updates itself from inside
// the app and is removed, with the real installer and the real update
// library. Two versions are packaged against a feed on this machine
// (PANELYTH_UPDATE_URL); the older one is installed silently, finds the newer
// one in Settings → About, downloads it, restarts into it and is uninstalled.
//
// Windows only: an unsigned macOS app cannot install an update (it offers the
// download page), and the Linux AppImage path has no test yet.
//
// It installs and removes a real program for the current user, so it runs
// only when asked for (`pnpm test:update`) and refuses a machine where
// Panelyth is installed. After the update the installer starts the new
// version itself, in the user's own session: that instance runs with the
// account's normal Panelyth profile (nothing of this test's environment
// reaches it) until the test closes it a few seconds later. A release runner
// has no such profile; on a developer's machine it is as if the app had been
// opened and closed once.

const FROM = "0.9.0"
const TO = "0.9.1"
const PORT = 47615
const NOTES = "Update smoke: the newer version."

const out = (version: string): string => join(desktopDir, "release", `update-${version}`)

function packageVersion(version: string): void {
  if (process.env.PANELYTH_UPDATE_REUSE === "1" && existsSync(join(out(version), "latest.yml"))) {
    return
  }
  execFileSync(
    process.execPath,
    [
      join(repoRoot, "scripts", "package.mjs"),
      `-c.directories.output=release/update-${version}`,
      `-c.releaseInfo.releaseNotes=${NOTES}`,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        PANELYTH_VERSION: version,
        PANELYTH_UPDATE_URL: `http://127.0.0.1:${PORT}/`,
        // The update is the same with or without the 160 MB of ffmpeg.
        PANELYTH_MEDIA_TOOLS: "skip",
      },
    },
  )
}

/** A static file server over one folder: the update feed. */
function serve(dir: string): Promise<Server> {
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "/").split("?")[0]!.slice(1))
    const file = normalize(join(dir, name))
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { "content-length": statSync(file).size })
    createReadStream(file).pipe(res)
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(PORT, "127.0.0.1", () => resolve(server))
  })
}

const installedElsewhere = (): boolean =>
  spawnSync(
    "reg",
    [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
      "/s",
      "/f",
      "Panelyth",
      "/d",
    ],
    { encoding: "utf8" },
  ).stdout.includes("DisplayName")

/** Every running Panelyth.exe, with the path Windows reports for it. */
function running(): { pid: number; path: string }[] {
  const script = `Get-CimInstance Win32_Process -Filter "Name='Panelyth.exe'" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`
  const result = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" })
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.includes("|"))
    .map((line) => ({
      pid: Number(line.slice(0, line.indexOf("|"))),
      path: line.slice(line.indexOf("|") + 1).trim(),
    }))
}

/** Processes started from the install folder (the app after the update restarted it). */
const runningFrom = (dir: string): number[] =>
  running()
    .filter((p) => p.path.toLowerCase().startsWith(dir.toLowerCase()))
    .map((p) => p.pid)

const until = async (what: string, done: () => boolean, ms: number): Promise<void> => {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

test("install, update from inside the app, uninstall", async () => {
  test.skip(process.platform !== "win32", "the installer and update test is Windows only for now")
  test.setTimeout(30 * 60_000)
  expect(installedElsewhere(), "Panelyth is installed here; this test would replace it").toBe(false)

  packageVersion(FROM)
  packageVersion(TO)
  const installer = join(out(FROM), `Panelyth-${FROM}-win-x64.exe`)
  expect(existsSync(installer)).toBe(true)
  expect(existsSync(join(out(TO), `Panelyth-${TO}-win-x64.exe`))).toBe(true)

  // The temp folder by its long name. A runner's TEMP is an 8.3 path (C:\Users\RUNNER~1\…);
  // the installer starts the updated app through its Start Menu shortcut, which holds the
  // long path, and that is the path the process then reports (runningFrom).
  const scratch = mkdtempSync(join(realpathSync.native(tmpdir()), "panelyth-update-"))
  const installDir = join(scratch, "app")
  const exe = join(installDir, "Panelyth.exe")
  const uninstaller = join(installDir, "Uninstall Panelyth.exe")
  const updaterCache = join(process.env.LOCALAPPDATA ?? scratch, "panelyth-updater")
  const hadUpdaterCache = existsSync(updaterCache)
  const env = {
    ...(process.env as Record<string, string>),
    PANELYTH_CACHE_DIR: join(scratch, "cache"),
    PANELYTH_CONFIG_DIR: join(scratch, "config"),
  }
  delete (env as Record<string, string | undefined>).ELECTRON_RUN_AS_NODE
  const server = await serve(out(TO))
  try {
    // Install: silently, for this user, into a folder of the test (/D must come last, unquoted).
    execFileSync(installer, ["/S", `/D=${installDir}`], { stdio: "inherit" })
    await until("the installed app", () => existsSync(exe) && existsSync(uninstaller), 120_000)

    const app = await _electron.launch({
      executablePath: exe,
      args: [`--user-data-dir=${join(scratch, "user-data")}`],
      env,
    })
    const page = await app.firstWindow()
    await waitForReady(page)
    expect(await app.evaluate(({ app: a }) => a.getVersion())).toBe(FROM)

    // Settings → About: this is an installed, updating build.
    await page.getByTestId("app-settings").click()
    await page.getByRole("tab", { name: "About" }).click()
    await expect(page.getByTestId("about-version")).toHaveText(`Version ${FROM}`)
    const status = page.getByTestId("update-status")
    // Asked for by hand, or already found by the automatic check 15 s after start.
    const check = page.getByTestId("update-check")
    if (await check.isVisible()) await check.click()
    await expect(status).toHaveText(`Version ${TO} is available.`, { timeout: 60_000 })
    await expect(page.getByTestId("update-notes")).toContainText(NOTES)

    await page.getByTestId("update-download").click()
    await expect(status).toHaveAttribute("data-phase", "ready", { timeout: 5 * 60_000 })

    // Restart to update: the app quits, the installer replaces it and starts the new version.
    const closed = new Promise<void>((resolve) => app.once("close", () => resolve()))
    await page.getByTestId("update-install").click()
    await closed
    await until(
      "the updated app to start",
      () => runningFrom(installDir).length > 0,
      3 * 60_000,
    ).catch((error: Error) => {
      // What is running instead says whether the installer started nothing or something else.
      throw new Error(
        `${error.message} from ${installDir}; running Panelyth.exe: ${JSON.stringify(running())}`,
      )
    })
    // Closed as a user closes it (the window is asked to close), so it shuts down in
    // order; forced only if it does not.
    for (const pid of runningFrom(installDir)) spawnSync("taskkill", ["/PID", String(pid)])
    await until(
      "the updated app to close",
      () => runningFrom(installDir).length === 0,
      20_000,
    ).catch(() => {
      for (const pid of runningFrom(installDir)) {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"])
      }
    })
    await until("the updated app to exit", () => runningFrom(installDir).length === 0, 30_000)

    // The installed program is the new version, with the sidecar of that version.
    const updated = await _electron.launch({
      executablePath: exe,
      args: [`--user-data-dir=${join(scratch, "user-data")}`],
      env,
    })
    try {
      const window = await updated.firstWindow()
      const sidecar = await waitForReady(window)
      expect(await updated.evaluate(({ app: a }) => a.getVersion())).toBe(TO)
      expect(sidecar.version?.split("+")[0]).toBe(TO)
    } finally {
      await updated.close()
    }
  } finally {
    server.close()
    // Uninstall whatever happened above (`_?=` makes the uninstaller wait instead of forking).
    if (existsSync(uninstaller)) {
      spawnSync(uninstaller, ["/S", `_?=${installDir}`], { stdio: "inherit" })
    }
    if (!hadUpdaterCache) rmSync(updaterCache, { recursive: true, force: true })
  }

  // Removed: the program is gone and no longer registered; what the user made stays.
  expect(existsSync(exe)).toBe(false)
  expect(installedElsewhere()).toBe(false)
  expect(readdirSync(join(scratch, "config")).length).toBeGreaterThan(0)
  rmSync(scratch, { recursive: true, force: true })
})
