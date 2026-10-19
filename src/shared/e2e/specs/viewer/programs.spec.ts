import { expect, test } from "@playwright/test"
import { ensureFixture } from "../../fixtures"
import {
  commanderEnv,
  launchApp,
  openSettingsWindow,
  showDialogFolder,
  waitForReady,
} from "../../launch"

// "Open with" programs (ADR-0044): a program is picked in main's dialog in
// Settings, offered in the tile menu, and started by main with the entry's
// path. PANELYTH_TEST_PROGRAM_PATH answers the dialog; PANELYTH_TEST_SHELL
// records the start instead of running it.

type ShellLog = { action: string; value: string }[]

test("a program added and renamed in Settings opens a picture and the open folder", async () => {
  const root = ensureFixture("c05-images", {
    files: 0,
    images: { count: 40, width: 1600, height: 1200 },
  }).root
  // Any program that exists: the test runner's own.
  const program = process.execPath
  // Settings opens from the app rail, which shows with both apps (as theme.spec.ts).
  const { app, page } = await launchApp({
    ...commanderEnv("viewer"),
    PANELYTH_TEST_DIALOG_PATH: root,
    PANELYTH_TEST_PROGRAM_PATH: program,
  })
  try {
    await waitForReady(page)

    // No renderer writes the list itself, not even the settings it may write.
    const planted = await page.evaluate(() =>
      window.panelyth!.library.setSetting("shared.programs", {
        v: 1,
        programs: [{ id: "sh", name: "sh", path: "/bin/sh", target: "both" }],
      }),
    )
    expect(planted).toMatchObject({ ok: false, e: { code: "PERMISSION_DENIED" } })

    const settings = await openSettingsWindow(app, page)
    await settings.getByRole("tab", { name: "Open with" }).click()
    await settings.getByTestId("add-program").click()
    const row = settings.getByTestId("program-row")
    await expect(row).toHaveCount(1)
    await expect(row.getByRole("textbox", { name: "Program name" })).toHaveValue("node")
    await expect(row.getByText(program)).toBeVisible()
    // A new name is saved without Enter: Esc closes the window on keydown with the name kept.
    await row.getByRole("textbox", { name: "Program name" }).fill("totalCommander")
    await settings.keyboard.down("Escape")
    await expect.poll(() => app.windows().some((p) => p === settings)).toBe(false)

    const launches = async (): Promise<ShellLog> =>
      (
        await app.evaluate(
          () => (globalThis as unknown as { __panelythShellLog: ShellLog }).__panelythShellLog,
        )
      ).filter((e) => e.action === "launch")

    await showDialogFolder(page)
    const tile = page.getByTestId("tile").first()
    await expect(tile).toBeVisible()
    await tile.click({ button: "right" })
    await page.getByRole("menuitem", { name: "Open with totalCommander" }).click()
    await expect
      .poll(launches)
      .toEqual([{ action: "launch", value: expect.stringContaining(`${program}|${root}`) }])

    // The empty area: the folder that is open.
    await page.keyboard.press("Escape")
    await page.getByTestId("tile-view").dispatchEvent("contextmenu", { bubbles: true })
    await page.getByRole("menuitem", { name: "Open with totalCommander" }).click()
    await expect.poll(async () => (await launches()).at(-1)?.value).toBe(`${program}|${root}`)
  } finally {
    await app.close()
  }
})
