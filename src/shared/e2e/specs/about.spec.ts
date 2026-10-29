import { expect, test, type ElectronApplication } from "@playwright/test"
import {
  commanderEnv,
  commanderPage,
  launchApp,
  pressEscapeToClose,
  settingsWindow,
  shellState,
  waitForReady,
} from "../launch"

// Stage P06 (ADR-0038): Settings → About, updates and the native menu. An
// unpackaged build has no update feed, so main runs a scripted engine
// (PANELYTH_TEST_UPDATE): the state machine, the IPC and both apps' UI are the
// real ones; only the feed and the installer are stand-ins. The packaged
// smoke test covers the real feed file and the menu of a release build.

const UPDATE = JSON.stringify({
  version: "9.9.9",
  notes: "<h2>What changed</h2><ul><li>Faster folders</li><li>Fixes &amp; polish</li></ul>",
})

type ShellLog = { action: string; value: string }[]

const shellLog = (app: ElectronApplication): Promise<ShellLog> =>
  app.evaluate(() => (globalThis as unknown as { __panelythShellLog: ShellLog }).__panelythShellLog)

/** The native menu as main built it: top-level labels and the ids of every item. */
const menu = (app: ElectronApplication) =>
  app.evaluate(({ Menu }) => {
    const top = Menu.getApplicationMenu()?.items ?? []
    const ids: string[] = []
    const walk = (items: Electron.MenuItem[]): void => {
      for (const item of items) {
        if (item.id) ids.push(item.id)
        if (item.submenu) walk(item.submenu.items)
      }
    }
    walk(top)
    return {
      labels: top.map((i) => i.label),
      ids,
      roles: top.flatMap((i) => i.submenu?.items ?? []).map((i) => i.role),
    }
  })

/** Chooses a native menu item by id, as a click on it does. */
const choose = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, itemId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(itemId)
    if (!item) throw new Error(`no menu item ${itemId}`)
    item.click()
  }, id)

const menuLabel = (app: ElectronApplication, id: string) =>
  app.evaluate(
    ({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.label ?? null,
    id,
  )

test.describe("About, updates and the native menu (Stage P06)", () => {
  test("the menu is ours: About and the update check, no Electron links", async () => {
    const { app, page } = await launchApp({ ...commanderEnv(), PANELYTH_TEST_UPDATE: UPDATE })
    try {
      await waitForReady(page)
      const built = await menu(app)
      if (process.platform === "darwin") {
        expect(built.labels).toEqual(["Panelyth", "File", "Edit", "View", "Window", "Help"])
      } else {
        expect(built.labels).toEqual(["File", "Edit", "View", "Help"])
      }
      expect(built.ids).toEqual(
        expect.arrayContaining([
          "about",
          "update",
          "settings",
          "shortcuts",
          "app-viewer",
          "app-commander",
          "open-releases",
          "open-issues",
          "open-website",
          "open-logs",
          "open-notices",
        ]),
      )
      await expect.poll(() => menuLabel(app, "update")).toBe("Check for Updates…")

      // Help opens fixed places; in a test they are recorded, not opened.
      await choose(app, "open-logs")
      await choose(app, "open-releases")
      expect((await shellLog(app)).filter((e) => e.action === "openTarget")).toEqual([
        { action: "openTarget", value: "logs" },
        { action: "openTarget", value: "releases" },
      ])

      // View switches apps, and the mark follows the app on screen.
      await choose(app, "app-commander")
      await commanderPage(app)
      await expect.poll(async () => (await shellState(app)).active).toBe("commander")
      await expect
        .poll(() =>
          app.evaluate(
            ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("app-commander")?.checked,
          ),
        )
        .toBe(true)
    } finally {
      await app.close()
    }
  })

  test("About finds a version, shows what changed, downloads it and restarts to install", async () => {
    const { app, page } = await launchApp({ ...commanderEnv(), PANELYTH_TEST_UPDATE: UPDATE })
    try {
      await waitForReady(page)
      await expect(page.getByTestId("app-settings")).not.toHaveAttribute("data-update", "waiting")

      // Settings opens in a window of its own, on the About tab (ADR-0039).
      await choose(app, "about")
      const settings = await settingsWindow(app, "viewer")
      const about = settings.getByTestId("settings-about")
      await expect(about).toBeVisible()
      await expect(settings.getByRole("tab", { name: "About" })).toHaveAttribute(
        "aria-selected",
        "true",
      )
      const version = await app.evaluate(({ app: a }) => a.getVersion())
      await expect(settings.getByTestId("about-version")).toHaveText(`Version ${version}`)
      await expect(settings.getByTestId("about-details")).toContainText("Electron")
      // The sidecar is built with the product's version (one product version).
      await expect(settings.getByTestId("about-details")).toContainText(`Sidecar ${version}`)

      const status = settings.getByTestId("update-status")
      await expect(status).toHaveAttribute("data-phase", "idle")
      await settings.getByTestId("update-check").click()
      await expect(status).toHaveText("Version 9.9.9 is available.")
      // The feed's HTML arrives as text.
      const notes = settings.getByTestId("update-notes")
      await expect(notes).toContainText("What changed")
      await expect(notes).toContainText("• Faster folders")
      await expect(notes).toContainText("• Fixes & polish")
      expect(await notes.locator("ul, li, h2").count()).toBe(0)
      await expect.poll(() => menuLabel(app, "update")).toBe("Update Available…")

      // Nothing is downloaded until asked.
      expect((await shellLog(app)).some((e) => e.action === "update.install")).toBe(false)
      await settings.getByTestId("update-download").click()
      await expect(status).toHaveAttribute("data-phase", "ready")
      await expect(status).toContainText("Version 9.9.9 is ready")
      await expect.poll(() => menuLabel(app, "update")).toBe("Restart to Update…")

      await settings.getByTestId("update-install").click()
      await expect
        .poll(async () => (await shellLog(app)).filter((e) => e.action === "update.install"))
        .toEqual([{ action: "update.install", value: "9.9.9" }])

      // The rail marks the waiting version, in the other app too.
      await pressEscapeToClose(settings)
      await expect.poll(() => app.windows().includes(settings)).toBe(false)
      await expect(page.getByTestId("app-settings")).toHaveAttribute("data-update", "waiting")
      await page.getByTestId("app-switch").click()
      const commander = await commanderPage(app)
      await expect(commander.getByTestId("app-settings")).toHaveAttribute("data-update", "waiting")

      // The menu's update item goes to the app on screen: the commander's settings window.
      await choose(app, "update")
      const commanderSettings = await settingsWindow(app, "commander")
      await expect(commanderSettings.getByTestId("settings-about")).toBeVisible()
      await expect(commanderSettings.getByTestId("update-status")).toHaveAttribute(
        "data-phase",
        "ready",
      )
      expect(app.windows().filter((p) => p.url().includes("/settings.html"))).toHaveLength(1)
    } finally {
      await app.close()
    }
  })

  test("the automatic check is a shared setting, and the menu follows the language", async () => {
    const { app, page } = await launchApp({ ...commanderEnv(), PANELYTH_TEST_UPDATE: "{}" })
    try {
      await waitForReady(page)
      await choose(app, "update")
      const settings = await settingsWindow(app, "viewer")
      const status = settings.getByTestId("update-status")
      await expect(status).toHaveText("Panelyth is up to date.")

      const auto = settings.getByRole("switch", { name: "Check automatically" })
      await expect(auto).toHaveAttribute("aria-checked", "true")
      await auto.click()
      await expect(auto).toHaveAttribute("aria-checked", "false")
      // Main follows the setting, and it is stored.
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const res = await window.panelyth!.update.get()
            return res.ok ? res.r.auto : null
          }),
        )
        .toBe(false)
      const stored = await page.evaluate(async () => {
        const res = await window.panelyth!.library.get()
        return res.ok ? res.r.settings["shared.updates"] : null
      })
      expect(stored).toEqual({ v: 1, auto: false })

      // Settings → Appearance → Language reaches the native menu.
      await settings.getByRole("tab", { name: "Appearance" }).click()
      await settings.getByRole("combobox", { name: "Interface language" }).selectOption("hu")
      await expect.poll(async () => (await menu(app)).labels.at(-1)).toBe("Súgó")
      expect(await menuLabel(app, "about")).toBe("A Panelyth névjegye")
    } finally {
      await app.close()
    }
  })

  test("a development build has no updates, and says so", async () => {
    const { app, page } = await launchApp()
    try {
      await waitForReady(page)
      expect((await menu(app)).ids).not.toContain("update")
      // Without the commander there is no app switch in View.
      expect((await menu(app)).ids).not.toContain("app-commander")
      await choose(app, "about")
      const settings = await settingsWindow(app, "viewer")
      await expect(settings.getByTestId("update-status")).toHaveText(
        "This build does not update itself.",
      )
      await expect(settings.getByTestId("update-check")).toHaveCount(0)
      // A renderer cannot start a check or an install either.
      const state = await page.evaluate(async () => {
        await window.panelyth!.update.check()
        await window.panelyth!.update.download()
        const install = await window.panelyth!.update.install()
        const get = await window.panelyth!.update.get()
        return { install: install.ok && install.r.ok, phase: get.ok ? get.r.phase : null }
      })
      expect(state).toEqual({ install: false, phase: "idle" })
    } finally {
      await app.close()
    }
  })

  test("a renderer names a target, never a URL or a path", async () => {
    const { app, page } = await launchApp()
    try {
      await waitForReady(page)
      const refused = await page.evaluate(async () => {
        const open = window.panelyth!.app.openTarget as unknown as (
          target: string,
        ) => Promise<{ ok: boolean; e?: { code: string } }>
        const out: (string | undefined)[] = []
        for (const target of [
          "https://example.com",
          "C:\\Windows\\System32\\calc.exe",
          "../logs",
        ]) {
          out.push((await open(target)).e?.code)
        }
        return out
      })
      expect(refused).toEqual(["INVALID_ARGUMENT", "INVALID_ARGUMENT", "INVALID_ARGUMENT"])
      expect((await shellLog(app)).filter((e) => e.action === "openTarget")).toEqual([])
    } finally {
      await app.close()
    }
  })
})
