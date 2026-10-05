import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { isAlive, launchApp, repoRoot, sidecarStatus, waitForExit, waitForReady } from "../launch"

test("app starts, renders the shell and the renderer can ping Go", async () => {
  const { app, page } = await launchApp()
  try {
    await expect(page).toHaveTitle("FastView")
    expect(page.url()).toBe("app://fastview/index.html")
    await waitForReady(page)
    await expect(page.getByText("No folder open")).toBeVisible()
    await expect(page.getByTestId("sidecar-status")).toContainText("Backend ready")
    await expect(page.getByTestId("ping")).toHaveText(/ping \d+\.\d ms/)

    const pong = await page.evaluate(() => window.fastview!.system.ping())
    expect(pong).toMatchObject({ ok: true, r: { pong: true } })
    const marks = await page.evaluate(() => performance.getEntriesByName("fv:first-render").length)
    expect(marks).toBe(1)
  } finally {
    await app.close()
  }
})

test("renderer is isolated: no Node, no ipcRenderer, narrow API only", async () => {
  const { app, page } = await launchApp()
  try {
    const probe = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      return {
        require: typeof w.require,
        process: typeof w.process,
        ipcRenderer: typeof w.ipcRenderer,
        electron: typeof w.electron,
        apiKeys: Object.keys(window.fastview ?? {}).sort(),
        systemKeys: Object.keys(window.fastview?.system ?? {}).sort(),
      }
    })
    expect(probe).toEqual({
      require: "undefined",
      process: "undefined",
      ipcRenderer: "undefined",
      electron: "undefined",
      apiKeys: [
        "app",
        "clip",
        "clipboard",
        "dialog",
        "dir",
        "entry",
        "folder",
        "fs",
        "jobs",
        "library",
        "media",
        "onEvent",
        "places",
        "preview",
        "props",
        "query",
        "selection",
        "shell",
        "sidecar",
        "system",
      ],
      systemKeys: ["info", "ping"],
    })
    // Unknown event channels are refused by preload.
    const unknownChannel = await page.evaluate(() => {
      try {
        window.fastview!.onEvent("nope" as never, () => {})
        return "accepted"
      } catch {
        return "rejected"
      }
    })
    expect(unknownChannel).toBe("rejected")
    // The production CSP (served by the app:// handler) blocks inline script.
    const inlineRan = await page.evaluate(() => {
      const s = document.createElement("script")
      s.textContent = "window.__inlineRan = true"
      document.head.append(s)
      return (window as unknown as { __inlineRan?: boolean }).__inlineRan === true
    })
    expect(inlineRan).toBe(false)
  } finally {
    await app.close()
  }
})

test("sidecar crash is recovered and the renderer keeps working", async () => {
  const { app, page } = await launchApp()
  try {
    const first = await waitForReady(page)
    process.kill(first.pid!)
    const second = await waitForReady(page, first.pid)
    expect(second.restarts).toBe(1)
    expect(await waitForExit(first.pid!)).toBe(true)
    const pong = await page.evaluate(() => window.fastview!.system.ping())
    expect(pong.ok).toBe(true)
    await expect(page.getByTestId("sidecar-status")).toContainText("Backend ready")
  } finally {
    await app.close()
  }
})

test("quitting the app terminates the sidecar", async () => {
  const { app, page } = await launchApp()
  const { pid } = await waitForReady(page)
  expect(isAlive(pid!)).toBe(true)
  await app.close()
  expect(await waitForExit(pid!)).toBe(true)
})

test("dev-only methods are absent unless explicitly enabled", async () => {
  const off = await launchApp()
  try {
    await waitForReady(off.page)
    expect(await off.page.evaluate(() => typeof window.fastview!.dev)).toBe("undefined")
  } finally {
    await off.app.close()
  }
  const on = await launchApp({ FASTVIEW_DEV_METHODS: "1" })
  try {
    await waitForReady(on.page)
    const echo = await on.page.evaluate(() => window.fastview!.dev!.echo("hi"))
    expect(echo).toEqual({ ok: true, r: { payload: "hi" } })
    expect((await sidecarStatus(on.page)).state).toBe("ready")
  } finally {
    await on.app.close()
  }
})

test("built bundles contain no synchronous IPC", () => {
  const roots = ["apps/desktop/dist", "apps/renderer/dist"].map((d) => join(repoRoot, d))
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith(".js") || p.endsWith(".cjs")) files.push(p)
    }
  }
  roots.forEach(walk)
  expect(files.length).toBeGreaterThan(2)
  for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/\bsendSync\b/)
})
