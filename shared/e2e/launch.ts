import { mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { SidecarStatus } from "@fastview/contracts"
import { _electron, expect, type ElectronApplication, type Page } from "@playwright/test"

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
export const desktopDir = join(repoRoot, "shared", "desktop")
const electronPath = createRequire(import.meta.url)("electron") as unknown as string

export interface Launched {
  app: ElectronApplication
  page: Page
}

/**
 * Launches the production build with isolated cache, config and Electron
 * profile directories. Pass FASTVIEW_USER_DATA_DIR in `env` to reuse a
 * profile across launches.
 */
export async function launchApp(env: Record<string, string> = {}): Promise<Launched> {
  const scratch = mkdtempSync(join(tmpdir(), "fastview-e2e-"))
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [desktopDir],
    env: {
      ...(process.env as Record<string, string>),
      FASTVIEW_CACHE_DIR: join(scratch, "cache"),
      FASTVIEW_CONFIG_DIR: join(scratch, "config"),
      FASTVIEW_USER_DATA_DIR: join(scratch, "user-data"),
      FASTVIEW_RENDERER_URL: "",
      // Record shell/clipboard calls instead of opening apps (main exposes __fastviewShellLog).
      FASTVIEW_TEST_SHELL: "record",
      ...env,
    },
  })
  const page = await app.firstWindow()
  return { app, page }
}

export function sidecarStatus(page: Page): Promise<SidecarStatus> {
  return page.evaluate(async () => {
    const res = await window.fastview!.sidecar.getStatus()
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
          __fastviewShellState?: () => {
            active: string | null
            commanderCreated: boolean
            commanderEnabled: boolean
          }
        }
      ).__fastviewShellState?.() ?? {
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
    const page = app.windows().find((p) => p.url().startsWith("app://commander"))
    if (page) return page
    if (Date.now() > deadline) throw new Error("commander view not found")
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** Environment for a launch with the commander enabled (the feature flag), optionally shown first. */
export const commanderEnv = (
  startApp: "viewer" | "commander" = "viewer",
): Record<string, string> => ({
  FASTVIEW_COMMANDER: "1",
  FASTVIEW_START_APP: startApp,
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
