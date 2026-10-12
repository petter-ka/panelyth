import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { _electron, expect, test, type Page } from "@playwright/test"
import { ensureFixture } from "../fixtures"
import { desktopDir, isAlive, waitForExit, waitForReady } from "../launch"

// Stage P04: the packaged product launches, opens a folder, previews an
// image, switches to the commander and back, lists, copies a file and quits
// cleanly. Packaged builds ignore the test hooks of unpackaged ones (canned
// dialogs, recorded shell calls, PANELYTH_USER_DATA_DIR), so the test drives
// the UI and isolates the profile with --user-data-dir.

/** The unpacked app electron-builder wrote for this OS (`pnpm package --dir`). */
function packagedApp(): string {
  const override = process.env.PANELYTH_PACKAGED_APP
  if (override) return override
  const release = join(desktopDir, "release")
  const candidates = {
    win32: [join(release, "win-unpacked", "Panelyth.exe")],
    darwin: [`mac-${process.arch}`, "mac", "mac-arm64", "mac-x64"].map((d) =>
      join(release, d, "Panelyth.app", "Contents", "MacOS", "Panelyth"),
    ),
    linux: [join(release, "linux-unpacked", "panelyth")],
  }[process.platform as "win32" | "darwin" | "linux"]
  const found = candidates?.find((p) => existsSync(p))
  if (!found) throw new Error(`no packaged app under ${release}; run \`pnpm package --dir\``)
  return found
}

/** The package's resources folder: beside the executable, or in the bundle on macOS. */
function resourcesDir(): string {
  const exe = packagedApp()
  return process.platform === "darwin"
    ? join(dirname(dirname(exe)), "Resources")
    : join(dirname(exe), "resources")
}

// Stage P06: what a release package must hold and say about itself.
test("packaged: one version, our menu, the update feed, notices and media tools", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "panelyth-smoke-about-"))
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env as Record<string, string>
  const app = await _electron.launch({
    executablePath: packagedApp(),
    args: [`--user-data-dir=${join(scratch, "user-data")}`],
    env: {
      ...inherited,
      PANELYTH_CACHE_DIR: join(scratch, "cache"),
      PANELYTH_CONFIG_DIR: join(scratch, "config"),
    },
  })
  try {
    const page = await app.firstWindow()
    const status = await waitForReady(page)
    const version = await app.evaluate(({ app: a }) => a.getVersion())
    // One product version: the sidecar reports the shell's, with its commit after "+".
    expect(status.version?.split("+")[0]).toBe(version)
    const named = process.env.PANELYTH_VERSION
    if (named) expect(version).toBe(named)

    // The native menu is the product's; a release has no Reload and no developer tools.
    const menu = await app.evaluate(({ Menu }) => {
      const ids: string[] = []
      const roles: string[] = []
      const walk = (items: Electron.MenuItem[]): void => {
        for (const item of items) {
          if (item.id) ids.push(item.id)
          if (item.role) roles.push(String(item.role).toLowerCase())
          if (item.submenu) walk(item.submenu.items)
        }
      }
      walk(Menu.getApplicationMenu()?.items ?? [])
      return { ids, roles }
    })
    expect(menu.ids).toEqual(expect.arrayContaining(["about", "settings", "open-notices"]))
    expect(menu.roles).not.toContain("reload")
    expect(menu.roles).not.toContain("toggledevtools")

    // The package names its update feed; what it can do with a newer version depends on the OS.
    const resources = resourcesDir()
    const feed = join(resources, "app-update.yml")
    // macOS installs only into a Developer ID signed app (the packaging step's certificate);
    // a Linux folder that is no AppImage offers the download page.
    const macSigned = Boolean(process.env.CSC_LINK || process.env.CSC_NAME)
    const expected = !existsSync(feed)
      ? "off"
      : process.platform === "win32" || (process.platform === "darwin" && macSigned)
        ? "auto"
        : "manual"
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const res = await window.panelyth!.update.get()
          return res.ok ? res.r.mode : null
        }),
      )
      .toBe(expected)
    // electron-builder writes the feed for installer targets only, never for `--dir`:
    // the release workflow, which builds installers, asks for it.
    if (process.env.PANELYTH_SMOKE_FEED === "1") {
      expect(existsSync(feed), "the package has no update feed (app-update.yml)").toBe(true)
    }

    // Settings → About, through the UI.
    await page.getByTestId("app-settings").click()
    await page.getByRole("tab", { name: "About" }).click()
    await expect(page.getByTestId("about-version")).toHaveText(`Version ${version}`)
    await expect(page.getByTestId("about-details")).toContainText(`Sidecar ${version}`)

    // The licence notices are in the package and name what it holds.
    const notices = readFileSync(join(resources, "THIRD-PARTY-NOTICES.txt"), "utf8")
    for (const name of ["Electron", "react", "modernc.org/sqlite", "Inter (typeface)"]) {
      expect(notices, `${name} is missing from the notices`).toContain(name)
    }
    // ffmpeg beside the sidecar, whole or not at all, and then in the notices.
    const exe = process.platform === "win32" ? ".exe" : ""
    const bundled = existsSync(join(resources, "bin", "FFMPEG-BUILD.txt"))
    for (const tool of ["ffmpeg", "ffprobe"]) {
      expect(existsSync(join(resources, "bin", tool + exe)), `${tool} in the package`).toBe(bundled)
    }
    expect(notices.includes("FFmpeg")).toBe(bundled)
    if (process.env.PANELYTH_SMOKE_MEDIA_TOOLS === "1") expect(bundled).toBe(true)
  } finally {
    await app.close()
  }
})

test("packaged: open, preview, switch, list, copy, quit", async () => {
  const fx = ensureFixture("images-smoke-4", {
    files: 0,
    images: { count: 4, width: 800, height: 600 },
  })
  const scratch = mkdtempSync(join(tmpdir(), "panelyth-smoke-"))
  const dst = mkdtempSync(join(tmpdir(), "panelyth-smoke-dst-"))
  // A VS Code extension host sets ELECTRON_RUN_AS_NODE for its children; with
  // it Electron runs as plain Node and the app never starts (as in launchEnv).
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env as Record<string, string>
  const app = await _electron.launch({
    executablePath: packagedApp(),
    args: [`--user-data-dir=${join(scratch, "user-data")}`],
    env: {
      ...inherited,
      PANELYTH_CACHE_DIR: join(scratch, "cache"),
      PANELYTH_CONFIG_DIR: join(scratch, "config"),
      PANELYTH_COMMANDER: "1",
    },
  })
  let sidecarPid: number
  try {
    const page = await app.firstWindow()
    expect(await app.evaluate(({ app: a }) => a.isPackaged)).toBe(true)
    sidecarPid = (await waitForReady(page)).pid ?? 0
    expect(sidecarPid).toBeGreaterThan(0)
    await expect(page.getByRole("toolbar", { name: "Navigation" })).toBeVisible()

    // Commander: list the fixture, copy one image to the other panel (F5).
    await page.getByTestId("app-switch").click()
    const c = await commanderOf(app)
    await openPath(c, "left", fx.root)
    const name = readdirSync(fx.root)
      .filter((n) => n.endsWith(".jpg"))
      .sort()[0]!
    const row = c
      .getByTestId("grid-left")
      .locator("[data-id]", { hasText: name.replace(/\.jpg$/, "") })
      .first()
    await expect(row).toBeVisible({ timeout: 30_000 })
    await openPath(c, "right", dst)
    await row.click()
    await expect(c.getByTestId("grid-left").locator("[data-cursor=true]")).toContainText(
      name.replace(/\.jpg$/, ""),
    )
    await c.getByTestId("grid-left").focus()
    await c.keyboard.press("F5")
    await expect(c.getByRole("dialog")).toBeVisible()
    await c.keyboard.press("Enter")
    await expect.poll(() => existsSync(join(dst, name)), { timeout: 30_000 }).toBe(true)
    expect(readFileSync(join(dst, name))).toEqual(readFileSync(join(fx.root, name)))

    // Back to the viewer: the folder carries over; preview an image.
    await c.getByTestId("app-switch").click()
    const tile = page.locator('[data-testid="tile"][data-kind="image"]').first()
    await expect(tile).toBeVisible({ timeout: 30_000 })
    await tile.dblclick()
    // The picture opens in the media window (ADR-0033), a window of its own.
    await expect
      .poll(() => app.windows().some((w) => w.url().includes("media.html")), { timeout: 15_000 })
      .toBe(true)
    const media = app.windows().find((w) => w.url().includes("media.html"))!
    await expect(media.getByTestId("media-viewer").getByTestId("image-viewer")).toHaveAttribute(
      "data-layer",
      "fit",
      { timeout: 30_000 },
    )
  } finally {
    await app.close()
  }
  // Quit cleanly: the sidecar exits with the shell.
  expect(await waitForExit(sidecarPid, 10_000)).toBe(true)
  expect(isAlive(sidecarPid)).toBe(false)
})

async function commanderOf(app: Awaited<ReturnType<typeof _electron.launch>>): Promise<Page> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const c = app.windows().find((p) => p.url().startsWith("app://commander"))
    if (c) {
      await expect(c.getByTestId("sidecar-status")).toHaveAttribute("data-state", "ready", {
        timeout: 15_000,
      })
      return c
    }
    if (Date.now() > deadline) throw new Error("commander view not found")
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function openPath(c: Page, side: "left" | "right", path: string): Promise<void> {
  await c.getByTestId(`path-${side}`).click()
  await c.getByRole("textbox", { name: "Path" }).fill(path)
  await c.keyboard.press("Enter")
  await expect(c.getByTestId(`path-${side}`)).toHaveText(path)
}
