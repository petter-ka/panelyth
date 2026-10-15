import { mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { SidecarStatus } from "@panelyth/contracts"
import { _electron, expect, type ElectronApplication, type Page } from "@playwright/test"

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
export const desktopDir = join(repoRoot, "src", "shared", "desktop")
export const electronPath = createRequire(import.meta.url)("electron") as unknown as string

export interface Launched {
  app: ElectronApplication
  page: Page
}

/**
 * The environment of a launch: isolated cache, config and Electron profile
 * directories unless `env` names them. A second process started with the
 * same environment is a second launch of the same app (the OS opening a file
 * while it runs).
 */
export function launchEnv(env: Record<string, string> = {}): Record<string, string> {
  const scratch = mkdtempSync(join(tmpdir(), "panelyth-e2e-"))
  // A VS Code extension host sets ELECTRON_RUN_AS_NODE for its children; with
  // it Electron runs as plain Node and the app never starts.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env as Record<string, string>
  return {
    ...inherited,
    PANELYTH_CACHE_DIR: join(scratch, "cache"),
    PANELYTH_CONFIG_DIR: join(scratch, "config"),
    PANELYTH_USER_DATA_DIR: join(scratch, "user-data"),
    PANELYTH_RENDERER_URL: "",
    // Record shell/clipboard calls instead of opening apps (main exposes __panelythShellLog).
    PANELYTH_TEST_SHELL: "record",
    ...env,
  }
}

/**
 * Launches the production build with isolated cache, config and Electron
 * profile directories. Pass PANELYTH_USER_DATA_DIR in `env` to reuse a
 * profile across launches. `args` follow the app's folder on the command
 * line, as a file does when the OS opens it with the app.
 */
export async function launchApp(
  env: Record<string, string> = {},
  args: readonly string[] = [],
): Promise<Launched> {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [desktopDir, ...args],
    env: launchEnv(env),
  })
  return { app, page: await mainPage(app) }
}

/**
 * The page of the first window: the viewer's when the app's own window
 * opened. With the commander shown at start its view loads at the same
 * moment, and Playwright's first page is then sometimes the commander's;
 * a test that takes it for the viewer finds no tiles in it. A window that is
 * neither (a media window of a file opened from the OS) is returned as it is.
 */
async function mainPage(app: ElectronApplication): Promise<Page> {
  const first = await app.firstWindow()
  const deadline = Date.now() + 10_000
  while (first.url() === "about:blank" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
  if (!first.url().startsWith("app://commander/index.html")) return first
  for (;;) {
    const viewer = app.windows().find((p) => p.url().startsWith("app://panelyth/index.html"))
    if (viewer) return viewer
    if (Date.now() > deadline) return first
    await new Promise((r) => setTimeout(r, 25))
  }
}

export function sidecarStatus(page: Page): Promise<SidecarStatus> {
  return page.evaluate(async () => {
    const res = await window.panelyth!.sidecar.getStatus()
    if (!res.ok) throw new Error(res.e.message)
    return res.r
  })
}

export async function waitForReady(
  page: Page,
  notPid: number | null = null,
): Promise<SidecarStatus> {
  // The first start on a CI runner can be slow (a fresh binary, cold caches).
  const deadline = Date.now() + (process.env.CI ? 45_000 : 10_000)
  for (;;) {
    const status = await sidecarStatus(page)
    if (status.state === "ready" && status.pid !== notPid) return status
    if (Date.now() > deadline) throw new Error(`sidecar not ready: ${JSON.stringify(status)}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/**
 * Shows a folder in the viewer: the viewer opens the folder named in its
 * settings at start, so the folder is set there and the page reloaded. (The
 * toolbar has had no "Open folder…" button since the sidebar took over
 * navigation; a test that needs the open itself opens a folder tile.)
 */
export async function showViewerFolder(page: Page, dir: string): Promise<void> {
  await waitForReady(page)
  await page.evaluate(async (folder) => {
    await window.panelyth!.library.setSetting("viewer", {
      v: 1,
      startupFolder: "specified",
      specifiedFolder: folder,
    })
  }, dir)
  await page.reload()
  await waitForReady(page)
}

/**
 * Shows the folder the launch named in PANELYTH_TEST_DIALOG_PATH, for the
 * specs written when the toolbar had an "Open folder…" button over the
 * folder dialog: the dialog's canned answer is still what names the folder.
 */
export async function showDialogFolder(page: Page): Promise<void> {
  await waitForReady(page)
  const dir = await page.evaluate(async () => {
    const res = await window.panelyth!.dialog.openFolder()
    if (!res.ok) throw new Error(res.e.message)
    return res.r.path
  })
  if (!dir) throw new Error("the launch named no folder (PANELYTH_TEST_DIALOG_PATH)")
  await showViewerFolder(page, dir)
}

/**
 * Runs `install` in the page now and at the start of every later load, for
 * measurements that must not miss the first events after a reload.
 */
export async function atEveryLoad(page: Page, install: () => void): Promise<void> {
  await page.addInitScript(install)
  await page.evaluate(install)
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitForExit(pid: number, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 25))
  }
  return true
}

/** The shell's state (main process test hook): the visible app and whether the commander view exists. */
export function shellState(
  app: ElectronApplication,
): Promise<{ active: string | null; commanderCreated: boolean; commanderEnabled: boolean }> {
  return app.evaluate(
    () =>
      (
        globalThis as {
          __panelythShellState?: () => {
            active: string | null
            commanderCreated: boolean
            commanderEnabled: boolean
          }
        }
      ).__panelythShellState?.() ?? {
        active: null,
        commanderCreated: false,
        commanderEnabled: false,
      },
  )
}

/** The commander's app view page (ADR-0031); waits until the view exists. */
export async function commanderPage(app: ElectronApplication, timeoutMs = 10_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    // Not its media or settings window, which share the origin (ADR-0033, ADR-0039).
    const page = app.windows().find((p) => p.url().startsWith("app://commander/index.html"))
    if (page) return page
    if (Date.now() > deadline) throw new Error("commander view not found")
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** Environment for a launch with the commander enabled (the feature flag), optionally shown first. */
export const commanderEnv = (
  startApp: "viewer" | "commander" = "viewer",
): Record<string, string> => ({
  PANELYTH_COMMANDER: "1",
  PANELYTH_START_APP: startApp,
})

/**
 * A timing budget (milliseconds, or a long-task count) from a PERFORMANCE.md.
 * Budgets hold on the reference machine and fail the test there and on
 * developer machines. Shared CI runners are 2-4x slower and uneven (Stage
 * P04), so under CI an over-budget value is reported as a GitHub warning
 * annotation instead; the specs record every measured value either way.
 */
export function expectWithinBudget(value: number, budget: number, what: string): void {
  if (process.env.CI) {
    if (!(value < budget))
      console.log(
        `::warning title=Over budget::${what}: ${value} (budget < ${budget}, reference machine)`,
      )
    return
  }
  expect(value, what).toBeLessThan(budget)
}

/**
 * Removes a test's temporary folder. On Windows a profile's database can stay
 * locked for a while after the app closed; a folder left in the temp area is
 * harmless, so cleanup never fails a test (the packaged smoke test checks
 * that the sidecar exits with the app).
 */
export function removeTemp(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  } catch (error) {
    console.warn(`left ${path}: ${(error as Error).message}`)
  }
}

/**
 * Clicks what opens Settings in `page` and returns the settings window it
 * opens (ADR-0039): a native window of its own, on the app's origin. The
 * windows are polled: Playwright reports a new window once, and it may still
 * be about:blank then (it is on Linux), before settings.html is loaded.
 */
export async function openSettingsWindow(
  app: ElectronApplication,
  page: Page,
  timeoutMs = 10_000,
): Promise<Page> {
  await page.getByTestId("app-settings").click({ timeout: timeoutMs })
  const settings = await settingsWindow(app, undefined, timeoutMs)
  await settings.waitForLoadState("domcontentloaded")
  return settings
}

/**
 * The settings window that is open (ADR-0039), of `app` when named (its page
 * is settings.html on that app's origin); waits until it exists.
 */
export async function settingsWindow(
  app: ElectronApplication,
  of?: "viewer" | "commander",
  timeoutMs = 10_000,
): Promise<Page> {
  const origin = of === "commander" ? "app://commander/" : of === "viewer" ? "app://panelyth/" : ""
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const page = app
      .windows()
      .find((p) => p.url().includes("/settings.html") && p.url().startsWith(origin))
    if (page) return page
    if (Date.now() > deadline) {
      const urls = app.windows().map((p) => p.url())
      throw new Error(`settings window not found; the windows: ${urls.join(", ")}`)
    }
    await new Promise((r) => setTimeout(r, 25))
  }
}
