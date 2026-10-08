import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _electron, expect, test, type Page } from "@playwright/test"
import { ensureFixture } from "../fixtures"
import { desktopDir, isAlive, waitForExit, waitForReady } from "../launch"

// Stage P04: the packaged product launches, opens a folder, previews an
// image, switches to the commander and back, lists, copies a file and quits
// cleanly. Packaged builds ignore the test hooks of unpackaged ones (canned
// dialogs, recorded shell calls, FASTVIEW_USER_DATA_DIR), so the test drives
// the UI and isolates the profile with --user-data-dir.

/** The unpacked app electron-builder wrote for this OS (`pnpm package --dir`). */
function packagedApp(): string {
  const override = process.env.FASTVIEW_PACKAGED_APP
  if (override) return override
  const release = join(desktopDir, "release")
  const candidates = {
    win32: [join(release, "win-unpacked", "FastView.exe")],
    darwin: [`mac-${process.arch}`, "mac", "mac-arm64", "mac-x64"].map((d) =>
      join(release, d, "FastView.app", "Contents", "MacOS", "FastView"),
    ),
    linux: [join(release, "linux-unpacked", "fastview")],
  }[process.platform as "win32" | "darwin" | "linux"]
  const found = candidates?.find((p) => existsSync(p))
  if (!found) throw new Error(`no packaged app under ${release}; run \`pnpm package --dir\``)
  return found
}

test("packaged: open, preview, switch, list, copy, quit", async () => {
  const fx = ensureFixture("images-smoke-4", {
    files: 0,
    images: { count: 4, width: 800, height: 600 },
  })
  const scratch = mkdtempSync(join(tmpdir(), "fastview-smoke-"))
  const dst = mkdtempSync(join(tmpdir(), "fastview-smoke-dst-"))
  const app = await _electron.launch({
    executablePath: packagedApp(),
    args: [`--user-data-dir=${join(scratch, "user-data")}`],
    env: {
      ...(process.env as Record<string, string>),
      FASTVIEW_CACHE_DIR: join(scratch, "cache"),
      FASTVIEW_CONFIG_DIR: join(scratch, "config"),
      FASTVIEW_COMMANDER: "1",
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
    await expect(page.getByTestId("viewer").getByTestId("image-viewer")).toHaveAttribute(
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
