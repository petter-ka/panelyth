import { appendFileSync, cpSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { expect, test, type ElectronApplication, type Page } from "@playwright/test"
import { ensureFixture } from "../fixtures"
import {
  desktopDir,
  electronPath,
  launchApp,
  launchEnv,
  removeTemp,
  repoRoot,
  shellState,
  waitForReady,
} from "../launch"

// "Open with" (ADR-0033 amended): a picture or video the OS hands to the app
// opens in a full-screen media window of its own, without the app's window
// behind it; a double-click takes it into the viewer, at its folder.
// Measurements: adr-0033-…-e2e-openwith.

function writeResult(result: object): void {
  const date = new Date().toISOString().slice(0, 10)
  const file = join(
    repoRoot,
    "src",
    "shared",
    "bench",
    "results",
    `adr-0033-${date}-e2e-openwith.jsonl`,
  )
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...result }) + "\n")
}

/** A folder of real pictures (and a text file the viewer does not show); their names in order. */
function pictures(): { dir: string; names: string[] } {
  const fx = ensureFixture("editor-640", {
    files: 0,
    images: { count: 6, width: 640, height: 480 },
  })
  const dir = join(mkdtempSync(join(tmpdir(), "panelyth-openwith-")), "photos")
  cpSync(fx.root, dir, { recursive: true })
  writeFileSync(join(dir, "notes.txt"), "not a picture")
  const names = readdirSync(dir)
    .filter((n) => /\.(jpe?g|png)$/i.test(n))
    .sort()
  return { dir, names }
}

const env = { PANELYTH_COMMANDER: "1" }

/** The media window's page, once its picture is decoded and on screen. */
async function pictureShown(page: Page, name: string): Promise<void> {
  await expect(page.getByTestId("media-viewer")).toContainText(name)
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLImageElement>('[data-testid="image-viewer"] img')].some(
          (img) => img.complete && img.naturalWidth > 0,
        ),
      ),
    )
    .toBe(true)
}

const windowUrls = (app: ElectronApplication): string[] => app.windows().map((w) => w.url())

test.describe("a file opened from the OS", () => {
  test("shows full screen with no app window behind it; a double-click opens the viewer on it", async () => {
    const { dir, names } = pictures()
    const second = names[1]!
    const { app, page } = await launchApp(env, [join(dir, second)])
    try {
      // The only window is the media window, on the commander's narrow profile.
      expect(page.url()).toContain("app://commander/media.html")
      expect(page.url()).toContain("alone=1")
      // No path is in what the page was given.
      expect(page.url()).not.toContain(basename(dir))
      await pictureShown(page, second)
      expect(windowUrls(app).filter((u) => u.startsWith("app://panelyth/"))).toEqual([])
      expect(await shellState(app)).toMatchObject({ active: null, commanderCreated: false })

      // Next and previous are the folder's pictures by name; the text file is not among them.
      await page.keyboard.press("ArrowRight")
      await pictureShown(page, names[2]!)
      await page.keyboard.press("ArrowLeft")
      await page.keyboard.press("ArrowLeft")
      await pictureShown(page, names[0]!)
      await page.keyboard.press("ArrowLeft")
      await expect(page.getByTestId("media-viewer")).toContainText(names[0]!)
      await page.keyboard.press("ArrowRight")
      await pictureShown(page, second)

      // A double-click: the viewer opens on the folder with this picture selected, and this window goes.
      const opened = app.waitForEvent("window")
      await page.getByTestId("image-viewer").dblclick()
      const viewer = await opened
      await viewer.waitForLoadState("domcontentloaded")
      expect(viewer.url()).toBe("app://panelyth/index.html")
      await waitForReady(viewer)
      const selected = viewer.locator('[data-testid="tile"][aria-selected="true"]')
      await expect(selected).toHaveCount(1)
      await expect(selected).toHaveAttribute("aria-label", second)
      await expect(viewer.getByTestId("tile")).toHaveCount(names.length)
      await expect.poll(() => windowUrls(app).filter((u) => u.includes("media.html"))).toEqual([])
      expect(await shellState(app)).toMatchObject({ active: "viewer" })
    } finally {
      await app.close().catch(() => undefined)
      removeTemp(join(dir, ".."))
    }
  })

  test("while the app runs, a file from the OS opens its own window; a double-click shows it in the running viewer", async () => {
    const { dir, names } = pictures()
    const third = names[2]!
    // One environment for both launches: the second is the OS starting the app again with a file.
    const shared = launchEnv(env)
    const { app, page } = await launchApp(shared)
    try {
      await waitForReady(page)
      expect(page.url()).toBe("app://panelyth/index.html")
      const opened = app.waitForEvent("window")
      const second = spawn(electronPath, [desktopDir, join(dir, third)], {
        env: shared,
        stdio: "ignore",
      })
      const media = await opened
      // The second process hands the file over and ends; the running app shows it.
      await new Promise((resolve) => second.once("exit", resolve))
      expect(media.url()).toContain("media.html")
      expect(media.url()).toContain("alone=1")
      await pictureShown(media, third)
      // The viewer behind it did not move: it is not in the file's folder.
      await expect(page.locator(`[data-testid="tile"][aria-label="${third}"]`)).toHaveCount(0)

      await media.getByRole("button", { name: "Open in Panelyth" }).click()
      const selected = page.locator('[data-testid="tile"][aria-selected="true"]')
      await expect(selected).toHaveCount(1)
      await expect(selected).toHaveAttribute("aria-label", third)
      await expect.poll(() => windowUrls(app).filter((u) => u.includes("media.html"))).toEqual([])
      expect(windowUrls(app).filter((u) => u.startsWith("app://panelyth/"))).toHaveLength(1)
    } finally {
      await app.close().catch(() => undefined)
      removeTemp(join(dir, ".."))
    }
  })

  test("a file that is no picture or video opens the app as usual", async () => {
    const { dir } = pictures()
    const { app } = await launchApp(env, [join(dir, "notes.txt")])
    try {
      await expect
        .poll(() => windowUrls(app).filter((u) => u.startsWith("app://panelyth/")).length, {
          timeout: 15_000,
        })
        .toBe(1)
      await expect.poll(() => windowUrls(app).filter((u) => u.includes("media.html"))).toEqual([])
    } finally {
      await app.close().catch(() => undefined)
      removeTemp(join(dir, ".."))
    }
  })

  test("bench: a picture is on screen sooner than the app's window is ready", async () => {
    test.setTimeout(120_000)
    const { dir, names } = pictures()
    const file = join(dir, names[1]!)
    const runs = 3
    const withFile: number[] = []
    const usual: number[] = []
    try {
      for (let i = 0; i < runs; i++) {
        // Opened with a file: until the picture is decoded and shown.
        let t0 = Date.now()
        const a = await launchApp(env, [file])
        // Checked every frame: the usual polling is too coarse for half a second.
        await a.page.waitForFunction(
          () =>
            [
              ...document.querySelectorAll<HTMLImageElement>('[data-testid="image-viewer"] img'),
            ].some((img) => img.complete && img.naturalWidth > 0),
          undefined,
          { polling: "raf" },
        )
        withFile.push(Date.now() - t0)
        const windows = windowUrls(a.app).length
        await a.app.close()
        expect(windows).toBe(1)

        // An ordinary start: until the viewer's window can be used.
        t0 = Date.now()
        const b = await launchApp(env)
        await b.page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="sidecar-status"]')
              ?.textContent?.includes("Backend ready") === true,
          undefined,
          { polling: "raf" },
        )
        usual.push(Date.now() - t0)
        await b.app.close()
      }
      const best = (xs: number[]): number => Math.min(...xs)
      writeResult({
        bench: "open-with",
        launchToPictureMs: withFile,
        launchToAppReadyMs: usual,
        bestPictureMs: best(withFile),
        bestAppReadyMs: best(usual),
        note: "wall time from the launch call; the app-ready number has no folder open and no picture decoded",
      })
      // The picture alone must not cost more than starting the whole app.
      expect(best(withFile)).toBeLessThan(best(usual) + 500)
    } finally {
      removeTemp(join(dir, ".."))
    }
  })
})
