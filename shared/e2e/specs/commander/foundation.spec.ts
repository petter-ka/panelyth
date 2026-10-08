import { expect, test } from "@playwright/test"
import { commanderEnv, commanderPage, launchApp, shellState } from "../../launch"

// Stage C00: the commander as an app view in the shell (ADR-0031), with its own
// narrow API (ADR-0027).

test.describe("commander foundation (Stage C00)", () => {
  test("starts in the shell with two panels, the function-key bar and a ready backend", async () => {
    const { app } = await launchApp(commanderEnv("commander"))
    try {
      const page = await commanderPage(app)
      await expect(page.getByTestId("panel-left")).toHaveAttribute("data-active", "true")
      await expect(page.getByTestId("panel-right")).toBeVisible()
      await expect(page.getByTestId("function-keys")).toContainText("F5")
      await expect(page.getByTestId("sidecar-status")).toHaveAttribute("data-state", "ready", {
        timeout: 15_000,
      })
      expect(await shellState(app)).toMatchObject({ active: "commander", commanderCreated: true })
      const title = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getTitle(),
      )
      expect(title).toBe("Panelyth Commander")

      // Tab moves the active panel; the key reaches the commander, not the viewer behind it.
      await page.keyboard.press("Tab")
      await expect(page.getByTestId("panel-right")).toHaveAttribute("data-active", "true")
    } finally {
      await app.close()
    }
  })

  test("exposes only the commander's API and no Node or Electron internals", async () => {
    const { app } = await launchApp(commanderEnv("commander"))
    try {
      const page = await commanderPage(app)
      await expect(page.getByTestId("panel-left")).toBeVisible()
      const probe = await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>
        const api = (window.panelyth ?? {}) as unknown as Record<string, Record<string, unknown>>
        return {
          require: typeof w.require,
          process: typeof w.process,
          ipcRenderer: typeof w.ipcRenderer,
          apiKeys: Object.keys(api).sort(),
          app: Object.keys(api.app ?? {}).sort(),
          library: Object.keys(api.library ?? {}).sort(),
          query: Object.keys(api.query ?? {}).sort(),
          jobs: Object.keys(api.jobs ?? {}).sort(),
          files: Object.keys(api.files ?? {}).sort(),
          fs: Object.keys(api.fs ?? {}).sort(),
          clip: Object.keys(api.clip ?? {}).sort(),
          clipboard: Object.keys(api.clipboard ?? {}).sort(),
          media: Object.keys(api.media ?? {}).sort(),
          preview: Object.keys(api.preview ?? {}).sort(),
          props: Object.keys(api.props ?? {}).sort(),
          file: Object.keys(api.file ?? {}).sort(),
          shell: Object.keys(api.shell ?? {}).sort(),
        }
      })
      expect(probe).toEqual({
        require: "undefined",
        process: "undefined",
        ipcRenderer: "undefined",
        // Stage C01 added listing, free space, home and the shared context;
        // C02 marks (selection) and folder sizes (jobs); C04 file
        // operations (files, clip, clipboard, fs.mkdir, fs.canTrash); C05
        // quick view, lister, open and edit (media, preview, props, file,
        // shell, fs.mkfile); C07 archives.
        apiKeys: [
          "app",
          "archive",
          "clip",
          "clipboard",
          "context",
          "dir",
          "file",
          "files",
          "find",
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
        app: ["exit", "switch"],
        library: [
          "addBookmark",
          "get",
          "removeBookmark",
          "reorderBookmarks",
          "setSetting",
          "updateBookmark",
        ],
        query: ["close", "indexOf", "locate", "match", "open", "page"],
        jobs: ["cancel", "dirSize"],
        files: ["errors", "list", "pause", "rename", "resolve", "resume", "start", "startNow"],
        fs: ["canTrash", "mkdir", "mkfile", "volumes"],
        clip: ["get", "paste", "set"],
        clipboard: ["copyPaths", "copyText"],
        media: ["open"],
        preview: ["ensure"],
        props: ["get"],
        file: ["open"],
        shell: ["edit", "open"],
      })
    } finally {
      await app.close()
    }
  })
})
