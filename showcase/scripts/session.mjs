// Launches the built app on the demo library for the showcase's captures
// (capture.mjs). The app runs with a profile of its own, and its "places"
// point into the demo home, so nothing of the machine it runs on is shown.
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { demoRoot } from "./demo-library.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, "..", "..")
const desktop = join(repo, "src", "shared", "desktop")

// Playwright and Electron are the e2e package's (the showcase has no build-time dependencies of its own).
const e2e = createRequire(join(repo, "src", "shared", "e2e", "package.json"))
const { _electron } = e2e("@playwright/test")

/** The window's content size in CSS pixels, and the scale it is rendered at. */
export const VIEW = { width: 1440, height: 900, scale: 1.5 }

/**
 * The demo home as the app sees it. On Windows the library is mounted as a
 * drive of its own, so that paths read `U:\Users\user\Pictures` wherever the
 * checkout is.
 */
export function mountDemo(letter = "U") {
  if (!existsSync(join(demoRoot, ".generated"))) {
    throw new Error("no demo library: run node showcase/scripts/demo-library.mjs first")
  }
  if (process.platform !== "win32") return { home: join(demoRoot, "Users", "user"), unmount() {} }
  const drive = `${letter}:`
  if (!existsSync(`${drive}\\`)) execFileSync("subst", [drive, demoRoot])
  return {
    home: `${drive}\\Users\\user`,
    unmount() {
      try {
        execFileSync("subst", [drive, "/d"])
      } catch {
        // already gone
      }
    },
  }
}

export async function launch(home, start = "viewer") {
  const scratch = mkdtempSync(join(tmpdir(), "panelyth-showcase-"))
  // A VS Code extension host sets ELECTRON_RUN_AS_NODE; with it Electron runs as plain Node.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env
  const app = await _electron.launch({
    executablePath: e2e("electron"),
    args: [desktop, `--force-device-scale-factor=${VIEW.scale}`],
    env: {
      ...inherited,
      PANELYTH_CACHE_DIR: join(scratch, "cache"),
      PANELYTH_CONFIG_DIR: join(scratch, "config"),
      PANELYTH_USER_DATA_DIR: join(scratch, "user-data"),
      PANELYTH_RENDERER_URL: "",
      PANELYTH_COMMANDER: "1",
      PANELYTH_START_APP: start,
      PANELYTH_TEST_SHELL: "record",
    },
  })
  // The sidebar's places come from Electron's paths: point them into the demo home.
  await app.evaluate(
    ({ app, BrowserWindow }, { home, view }) => {
      const places = {
        home: "",
        desktop: "Desktop",
        documents: "Documents",
        downloads: "Downloads",
        pictures: "Pictures",
        videos: "Videos",
      }
      for (const [id, folder] of Object.entries(places)) {
        app.setPath(
          id,
          folder ? `${home}${process.platform === "win32" ? "\\" : "/"}${folder}` : home,
        )
      }
      const win = BrowserWindow.getAllWindows()[0]
      win.setContentSize(view.width, view.height)
      win.center()
    },
    { home, view: VIEW },
  )
  const viewer = await pageOf(app, "app://panelyth/")
  await ready(viewer)
  return { app, viewer, scratch }
}

export async function pageOf(app, prefix, timeout = 15_000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const page = app.windows().find((p) => p.url().includes(prefix))
    if (page) return page
    if (Date.now() > deadline) throw new Error(`no page for ${prefix}`)
    await sleep(25)
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function ready(page) {
  const deadline = Date.now() + 20_000
  for (;;) {
    const state = await page
      .evaluate(async () => {
        const res = await window.panelyth?.sidecar.getStatus()
        return res?.ok ? res.r.state : "starting"
      })
      .catch(() => "starting")
    if (state === "ready") return
    if (Date.now() > deadline) throw new Error("the sidecar did not start")
    await sleep(50)
  }
}

/** Opens a folder in the viewer: it is the folder the viewer starts in, and the page is reloaded. */
export async function showFolder(viewer, folder) {
  await viewer.evaluate(async (dir) => {
    await window.panelyth.library.setSetting("viewer", {
      v: 1,
      startupFolder: "specified",
      specifiedFolder: dir,
    })
  }, folder)
  await viewer.reload()
  await ready(viewer)
  await viewer.locator('[data-testid="tile"]').first().waitFor({ timeout: 12_000 })
}

/** Waits until the thumbnails in view are painted. */
export async function settled(page, selector = '[data-testid="tile"] img', quiet = 400) {
  const deadline = Date.now() + 20_000
  let last = -1
  let since = Date.now()
  for (;;) {
    const loaded = await page.evaluate(
      (sel) =>
        [...document.querySelectorAll(sel)].filter((i) => i.complete && i.naturalWidth).length,
      selector,
    )
    if (loaded !== last) {
      last = loaded
      since = Date.now()
    } else if (loaded > 0 && Date.now() - since > quiet) return
    if (Date.now() > deadline) return
    await sleep(60)
  }
}
