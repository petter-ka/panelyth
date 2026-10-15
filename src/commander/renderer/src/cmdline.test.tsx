import type { Crumb } from "@panelyth/contracts"
import { useInterfaceSizeStore } from "@panelyth/ui"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetBridgeCache } from "./bridge"
import { AppShell } from "./components/AppShell"
import { resetCarry, startPanels } from "./features/carry"
import {
  cdTarget,
  HISTORY_KEY,
  loadCommandHistory,
  readHistory,
  resetCommandLine,
  resolveFolder,
  shellWord,
  useCommandLine,
} from "./features/cmdline"
import { resetDrives } from "./features/drives"
import { resetFiles, useFilesStore } from "./features/files"
import { resetHotlist } from "./features/hotlist"
import { loadShortcuts, resetKeymap, SHORTCUTS_KEY, useKeymapStore } from "./features/keymap"
import { flushPersist, resetListing, useListingStore } from "./features/listing"
import { resetMarks } from "./features/marks"
import { configureCommanderMedia, resetMediaConfig } from "./features/media"
import { usePanelsStore } from "./features/panels"
import { resetQueue, startQueue } from "./features/queue"
import { PANELS_KEY } from "./features/session"
import {
  DEFAULT_SETTINGS,
  loadSettings,
  resetSettings,
  SETTINGS_KEY,
  useSettingsStore,
} from "./features/settings"
import { resetTabs } from "./features/tabs"
import { resetThumbs, startThumbs } from "./features/thumbs"
import {
  DEFAULT_TOOLBAR,
  loadTools,
  readToolbar,
  resetTools,
  TOOLBAR_KEY,
  useToolsStore,
} from "./features/tools"
import { resetViewers } from "./features/viewers"
import { folder, installFakeCommander, item, type FakeOptions } from "./test/fakeApi"
import { mockViewport } from "./test/viewport"

// Stage C10: the command line, user commands, the toolbar, settings and the
// Thumbnails view (docs/commander/stages/C10-command-line-and-customization.md).

const ROOT: Crumb = { name: "C:\\", path: "C:\\" }
const SRC: Crumb = { name: "src", path: "C:\\src" }
const SUB: Crumb = { name: "dir000000", path: "C:\\src\\dir000000" }
const DST: Crumb = { name: "Backup", path: "C:\\Backup" }
const PICS: Crumb = { name: "pics", path: "C:\\pics" }

const TOOLS_KEY = "commander.tools"
const PICTURES = 5000
// src: "..", dir000000, dir000001, file000000.txt … file000003.txt, my photo.jpg
const FILE_0 = 10_000_002
const SPACED = 10_000_100
const folders = () => [
  folder(10, SRC.path, [ROOT, SRC], 2, 4, [
    item(SPACED, "my photo.jpg", { kind: "image", sizeBytes: 2048 }),
  ]),
  folder(10_000_000, SUB.path, [ROOT, SRC, SUB], 0, 1),
  folder(20, DST.path, [ROOT, DST], 0, 2),
  folder(
    40,
    PICS.path,
    [ROOT, PICS],
    1,
    0,
    Array.from({ length: PICTURES }, (_, i) =>
      item(40_100_000 + i, `p${String(i).padStart(5, "0")}.${i % 7 === 3 ? "txt" : "jpg"}`, {
        kind: i % 7 === 3 ? "file" : "image",
        sizeBytes: 1000 + i,
      }),
    ),
  ),
  folder(50, ROOT.path, [ROOT], 3, 0),
]

const EDITOR = {
  id: "ed1",
  title: "Open in the editor",
  command: "code",
  params: "%P%N",
  dir: "",
  icon: "edit",
  menu: true,
  console: false,
}
const PACKER = {
  id: "pk2",
  title: "Pack marked",
  command: "7z a out.7z",
  params: "@%L",
  dir: "",
  icon: "tool",
  menu: false,
  console: true,
}

let stops: (() => void)[] = []

async function start(options: Partial<FakeOptions> = {}, left = SRC.path) {
  const { settings, ...rest } = options
  const fake = installFakeCommander({
    folders: folders(),
    home: SRC.path,
    settings: {
      [PANELS_KEY]: {
        v: 2,
        active: "left",
        left: { tabs: [{ path: left }] },
        right: { tabs: [{ path: DST.path }] },
      },
      ...settings,
    },
    ...rest,
  })
  configureCommanderMedia()
  render(<AppShell />)
  await act(async () => {
    // As main.tsx starts them: the commands before the shortcuts.
    await loadTools()
    await loadShortcuts()
    await loadCommandHistory()
    await loadSettings()
    stops.push(startQueue(), startThumbs())
    stops.push(await startPanels())
  })
  await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent(left))
  await waitFor(() => expect(screen.getByTestId("path-right")).toHaveTextContent(DST.path))
  return fake
}

const grid = (side: "left" | "right") => screen.getByTestId(`grid-${side}`)
const key = (side: "left" | "right", init: KeyboardEventInit & { key: string }) =>
  act(async () => {
    fireEvent.keyDown(grid(side), init)
  })
const line = () => screen.getByRole<HTMLInputElement>("textbox", { name: "Command line" })
const type = (text: string) =>
  act(async () => {
    fireEvent.change(line(), { target: { value: text } })
  })
const lineKey = (init: KeyboardEventInit & { key: string }) =>
  act(async () => {
    fireEvent.keyDown(line(), init)
  })
const cursorRow = (side: "left" | "right") =>
  grid(side).querySelector<HTMLElement>("[data-cursor=true]")
async function cursorTo(row: number) {
  await waitFor(() =>
    expect(grid("left").querySelector(`[data-row="${row}"][data-id]`)).not.toBeNull(),
  )
  await act(async () => {
    fireEvent.mouseDown(grid("left").querySelector(`[data-row="${row}"]`)!, { button: 0 })
  })
}
const toolbar = () => screen.getByTestId("quick-actions")
const openSettings = async (section?: string) => {
  await act(async () => {
    fireEvent.keyDown(window, { key: ",", ctrlKey: true })
  })
  const dialog = screen.getByRole("dialog")
  if (section) {
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: section }))
    })
  }
  return dialog
}

beforeEach(() => {
  mockViewport(800, 600)
  resetListing()
  resetCarry()
  resetBridgeCache()
  resetTabs()
  resetDrives()
  resetHotlist()
  resetSettings()
  resetKeymap()
  resetMarks()
  resetFiles()
  resetQueue()
  resetViewers()
  resetCommandLine()
  resetTools()
  resetThumbs()
  resetMediaConfig()
  usePanelsStore.setState({ active: "left", split: 50, layoutToken: 0 })
  useInterfaceSizeStore.setState({ size: "medium" })
})
afterEach(() => {
  stops.forEach((s) => s())
  stops = []
  vi.useRealTimers()
})

describe("the command line", () => {
  it("runs the typed line in the active panel's folder on Enter, and only then", async () => {
    const fake = await start()
    expect(screen.getByTestId("command-prompt")).toHaveTextContent(`${SRC.path}>`)
    await key("left", { key: "k", ctrlKey: true })
    expect(line()).toHaveFocus()
    await type("git status")
    // Typing, leaving the field and changing the panel run nothing.
    await lineKey({ key: "Tab" })
    await waitFor(() => expect(grid("left")).toHaveFocus())
    await key("left", { key: "Tab" })
    await waitFor(() => expect(usePanelsStore.getState().active).toBe("right"))
    await key("right", { key: "ArrowDown" })
    await act(async () => {
      fireEvent.blur(line())
      fireEvent.click(screen.getByTestId("command-line"))
    })
    expect(line()).toHaveValue("git status")
    expect(fake.api.shell.run).not.toHaveBeenCalled()
    expect(fake.runs).toEqual([])
    expect(screen.getByTestId("command-prompt")).toHaveTextContent(`${DST.path}>`)

    // Enter in the command line: the line, the active panel's folder id, no path.
    await key("right", { key: "k", ctrlKey: true })
    await lineKey({ key: "Enter" })
    await waitFor(() =>
      expect(fake.runs).toEqual([
        { action: "run", command: "git status", dirId: 20, console: false },
      ]),
    )
    expect(fake.api.shell.run).toHaveBeenCalledWith({ command: "git status", dirId: 20 })
    expect(line()).toHaveValue("")
    expect(fake.settings[HISTORY_KEY]).toEqual({ v: 1, items: ["git status"] })
    // The keys are back with the files.
    await waitFor(() => expect(grid("right")).toHaveFocus())
  })

  it("Shift+Enter asks for a console that stays open; on an empty line it opens one in the folder", async () => {
    const fake = await start()
    await key("left", { key: "k", ctrlKey: true })
    // Enter on an empty line does nothing.
    await lineKey({ key: "Enter" })
    await type("   ")
    await lineKey({ key: "Enter" })
    expect(fake.api.shell.run).not.toHaveBeenCalled()
    await type("  npm test  ")
    await lineKey({ key: "Enter", shiftKey: true })
    await waitFor(() =>
      expect(fake.runs).toEqual([{ action: "run", command: "npm test", dirId: 10, console: true }]),
    )
    // The field clicked, focused and empty: Shift+Enter opens a console in the
    // panel's folder. Nothing is run, and nothing goes into the history.
    await act(async () => {
      fireEvent.click(line())
      line().focus()
    })
    expect(line()).toHaveFocus()
    expect(line()).toHaveValue("")
    await lineKey({ key: "Enter", shiftKey: true })
    await waitFor(() => expect(fake.runs).toHaveLength(2))
    expect(fake.runs[1]).toEqual({ action: "run", command: "", dirId: 10, console: true })
    expect(fake.api.shell.run).toHaveBeenLastCalledWith({ command: "", dirId: 10, console: true })
    expect(useCommandLine.getState().history).toEqual(["npm test"])
  })

  it("Ctrl+Enter adds the name under the cursor and Ctrl+Shift+Enter its path; nothing runs", async () => {
    const fake = await start()
    await cursorTo(3)
    await key("left", { key: "Enter", ctrlKey: true })
    expect(line()).toHaveValue("file000000.txt ")
    await key("left", { key: "Enter", ctrlKey: true, shiftKey: true })
    expect(line()).toHaveValue("file000000.txt C:\\src\\file000000.txt ")
    // The keys stay with the files, so more names can follow.
    expect(grid("left")).not.toBe(document.activeElement && line())
    // A name with a space is one word.
    await cursorTo(7)
    await type("")
    await key("left", { key: "Enter", ctrlKey: true })
    expect(line()).toHaveValue('"my photo.jpg" ')
    // On "..": the panel's folder for the path, nothing for the name.
    await key("left", { key: "Home" })
    await type("")
    await key("left", { key: "Enter", ctrlKey: true })
    expect(line()).toHaveValue("")
    await key("left", { key: "Enter", ctrlKey: true, shiftKey: true })
    expect(line()).toHaveValue("C:\\src ")

    // In the field itself the name lands at the caret.
    await cursorTo(3)
    await type("copy  backup")
    await act(async () => {
      line().focus()
      line().setSelectionRange(5, 5)
    })
    await lineKey({ key: "Enter", ctrlKey: true })
    expect(line()).toHaveValue("copy file000000.txt  backup")
    expect(fake.api.shell.run).not.toHaveBeenCalled()
  })

  it("keeps a history: Alt+F8 lists it, a picked line waits for Enter", async () => {
    const fake = await start({
      settings: { [HISTORY_KEY]: { v: 1, items: ["dir /b", "git log"] } },
    })
    await key("left", { key: "F8", altKey: true })
    const menu = screen.getByRole("menu", { name: "Command history" })
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((m) => m.textContent),
    ).toEqual(["dir /b", "git log"])
    expect(menu).toHaveFocus()
    await act(async () => {
      fireEvent.click(within(menu).getByText("git log"))
    })
    expect(screen.queryByRole("menu")).toBeNull()
    expect(line()).toHaveValue("git log")
    await waitFor(() => expect(line()).toHaveFocus())
    // Picking is not running.
    expect(fake.api.shell.run).not.toHaveBeenCalled()
    await lineKey({ key: "Enter" })
    await waitFor(() => expect(fake.runs).toHaveLength(1))
    // The line used last comes first; no line is listed twice.
    expect(useCommandLine.getState().history).toEqual(["git log", "dir /b"])
    expect(fake.settings[HISTORY_KEY]).toEqual({ v: 1, items: ["git log", "dir /b"] })

    // Esc closes the list and runs nothing.
    await key("left", { key: "F8", altKey: true })
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
    })
    expect(screen.queryByRole("menu")).toBeNull()
    expect(fake.runs).toHaveLength(1)
  })

  it("cd changes the panel's folder and never reaches the shell", async () => {
    const fake = await start()
    const go = async (text: string, expected: string): Promise<void> => {
      await key("left", { key: "k", ctrlKey: true })
      await type(text)
      await lineKey({ key: "Enter" })
      await waitFor(() => expect(screen.getByTestId("path-left")).toHaveTextContent(expected))
      expect(line()).toHaveValue("")
    }
    await go("cd dir000000", SUB.path)
    await go("cd ..", SRC.path)
    await go('cd /d "C:\\Backup"', DST.path)
    await go("cd \\src\\dir000000\\..", SRC.path)
    await go("cd\\", ROOT.path)
    await go("chdir src", SRC.path)
    expect(useCommandLine.getState().history.slice(0, 2)).toEqual(["chdir src", "cd\\"])

    // A folder that is not there: said at the line, which keeps its text.
    await key("left", { key: "k", ctrlKey: true })
    await type("cd nowhere")
    await lineKey({ key: "Enter" })
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("This folder doesn't exist anymore."),
    )
    expect(line()).toHaveValue("cd nowhere")
    expect(screen.getByTestId("path-left")).toHaveTextContent(SRC.path)
    expect(fake.api.shell.run).not.toHaveBeenCalled()
    // Esc clears the line and the message; Esc again returns to the files.
    await lineKey({ key: "Escape" })
    expect(line()).toHaveValue("")
    expect(screen.queryByRole("alert")).toBeNull()
    await lineKey({ key: "Escape" })
    await waitFor(() => expect(grid("left")).toHaveFocus())
  })

  it("says why main refused, and keeps the line", async () => {
    const fake = await start({
      runFails: { code: "PERMISSION_DENIED", message: "no", reason: "unc" },
    })
    await key("left", { key: "k", ctrlKey: true })
    await type("dir")
    await lineKey({ key: "Enter" })
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("cmd.exe can't run in a network folder"),
    )
    expect(line()).toHaveValue("dir")
    expect(fake.runs).toEqual([])
    expect(useCommandLine.getState().history).toEqual([])
    // Typing again takes the message away.
    await type("dir /b")
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("takes typed letters when Settings say so; quick search then starts with Alt", async () => {
    const fake = await start({ settings: { [SETTINGS_KEY]: { v: 2, letters: "altLetters" } } })
    await key("left", { key: "g" })
    expect(screen.queryByTestId("quicksearch-left")).toBeNull()
    expect(line()).toHaveValue("g")
    await waitFor(() => expect(line()).toHaveFocus())
    await type("git st")
    expect(fake.api.shell.run).not.toHaveBeenCalled()
    await lineKey({ key: "ArrowDown" })
    await waitFor(() => expect(grid("left")).toHaveFocus())
    await key("left", { key: "f", altKey: true })
    await waitFor(() => expect(cursorRow("left")).toHaveTextContent("file000000"))
    expect(line()).toHaveValue("git st")
    expect(fake.api.shell.run).not.toHaveBeenCalled()
  })

  it("reads cd lines, folders and words", () => {
    expect(cdTarget("cd")).toBe("")
    expect(cdTarget("cd ..")).toBe("..")
    expect(cdTarget("cd..")).toBe("..")
    expect(cdTarget("CD /d D:\\x y")).toBe("D:\\x y")
    expect(cdTarget("chdir 'a b'")).toBe("a b")
    expect(cdTarget("d:")).toBe("D:\\")
    expect(cdTarget("d:", false)).toBeNull()
    // Other programs are not cd.
    for (const other of ["cdrecord x", "cd2", "code .", "echo cd x", "dir"]) {
      expect(cdTarget(other), other).toBeNull()
    }
    expect(resolveFolder("C:\\a\\b", "..\\c")).toBe("C:\\a\\c")
    expect(resolveFolder("C:\\a\\b", "\\x")).toBe("C:\\x")
    expect(resolveFolder("C:\\a\\b", "D:\\")).toBe("D:\\")
    expect(resolveFolder("C:\\a", "..\\..\\..")).toBe("C:\\")
    expect(resolveFolder("\\\\nas\\share\\a", "..\\b")).toBe("\\\\nas\\share\\b")
    expect(resolveFolder("/home/me", "../x/./y")).toBe("/home/x/y")
    expect(resolveFolder("/home/me", "/etc")).toBe("/etc")
    expect(resolveFolder("/", "..")).toBe("/")
    expect(shellWord("plain.txt", true)).toBe("plain.txt")
    expect(shellWord("a b & c.txt", true)).toBe('"a b & c.txt"')
    expect(shellWord("100%.txt", true)).toBe('"100%.txt"')
    expect(shellWord("it's $HOME.txt", false)).toBe(`'it'\\''s $HOME.txt'`)
    expect(shellWord("/usr/bin/x-1.2", false)).toBe("/usr/bin/x-1.2")
    expect(readHistory({ v: 1, items: ["ok", "", 5, "a\nb", "x".repeat(3000), "fine"] })).toEqual([
      "ok",
      "fine",
    ])
    expect(readHistory("nope")).toEqual([])
  })
})

describe("user commands", () => {
  const settings = {
    [TOOLS_KEY]: { v: 1, commands: [EDITOR, PACKER] },
    [TOOLBAR_KEY]: { v: 1, items: ["find.open", "|", "tool:ed1", "tool:gone", "bogus"] },
    [SHORTCUTS_KEY]: { v: 1, bindings: { "tool:ed1": ["Mod+e"], "tool:gone": ["Mod+g"] } },
  }

  it("run from the toolbar with the panel's ids, never a path", async () => {
    const fake = await start({ settings })
    // Stored buttons: the known action, the divider, the command that exists.
    expect(useToolsStore.getState().toolbar).toEqual(["find.open", "|", "tool:ed1"])
    const button = within(toolbar()).getByRole("button", { name: "Open in the editor" })
    await cursorTo(3)
    await act(async () => {
      fireEvent.click(button)
    })
    const query = useListingStore.getState().left.query!
    await waitFor(() =>
      expect(fake.runs).toEqual([
        {
          action: "runTool",
          toolId: "ed1",
          dirId: 10,
          otherDirId: 20,
          cursorId: FILE_0,
          selection: {
            queryId: query.queryId,
            version: query.version,
            ranges: [[2, 3]],
            include: [],
            exclude: [],
          },
        },
      ]),
    )
    // Only ids crossed the bridge.
    expect(JSON.stringify(fake.api.shell.runTool.mock.calls)).not.toContain("code")
    expect(JSON.stringify(fake.api.shell.runTool.mock.calls)).not.toContain("C:\\\\")
  })

  it("run from their key and from the menu of files; the marks are their selection", async () => {
    const fake = await start({ settings })
    expect(useKeymapStore.getState().keymap.chords["tool:ed1"]).toEqual(["Mod+e"])
    await cursorTo(3)
    await key("left", { key: "Insert" })
    await key("left", { key: "Insert" })
    await key("left", { key: "e", ctrlKey: true })
    await waitFor(() => expect(fake.runs).toHaveLength(1))
    expect(fake.runs[0]).toMatchObject({
      action: "runTool",
      toolId: "ed1",
      selection: { ranges: [], include: [FILE_0, FILE_0 + 1], exclude: [] },
    })
    // The menu of files lists the commands that ask for it.
    await act(async () => fireEvent.contextMenu(grid("left").firstElementChild!))
    const menu = screen.getByTestId("row-menu-left")
    expect(within(menu).queryByText("Pack marked")).toBeNull()
    await act(async () => {
      fireEvent.click(within(menu).getByText("Open in the editor"))
    })
    await waitFor(() => expect(fake.runs).toHaveLength(2))
    // The shortcuts dialog lists them under Tools.
    expect(
      useKeymapStore
        .getState()
        .actions.filter((a) => a.id.startsWith("tool:"))
        .map((a) => [a.id, a.label, a.group]),
    ).toEqual([
      ["tool:ed1", "Open in the editor", "Tools"],
      ["tool:pk2", "Pack marked", "Tools"],
    ])
  })

  it("say what is missing when main refuses", async () => {
    const fake = await start({
      settings,
      runFails: { code: "INVALID_ARGUMENT", message: "needs an entry", reason: "noEntry" },
    })
    await act(async () => {
      fireEvent.click(within(toolbar()).getByRole("button", { name: "Open in the editor" }))
    })
    await waitFor(() =>
      expect(screen.getByTestId("files-notice")).toHaveTextContent(
        "Open in the editor needs a file: put the cursor on one or mark some.",
      ),
    )
    expect(fake.runs).toEqual([])
    // On "..": no cursor entry and no selection were sent.
    expect(fake.api.shell.runTool).toHaveBeenCalledWith({
      toolId: "ed1",
      dirId: 10,
      otherDirId: 20,
    })
  })

  it("are added in Settings and stored as main reads them", async () => {
    const fake = await start()
    const dialog = await openSettings("Editor and tools")
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Add a command…" }))
    })
    const form = within(dialog).getByTestId("tool-form")
    // Nothing to run: not saved.
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Save command" }))
    })
    expect(within(form).getByRole("alert")).toHaveTextContent("Enter the command to run.")
    expect(fake.settings[TOOLS_KEY]).toBeUndefined()
    await act(async () => {
      fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Diff" } })
      fireEvent.change(within(form).getByLabelText("Command"), { target: { value: "  meld " } })
      fireEvent.change(within(form).getByLabelText("Parameters"), {
        target: { value: "%P%N %T%N" },
      })
      fireEvent.change(within(form).getByLabelText("Icon"), { target: { value: "compare" } })
    })
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "Save command" }))
    })
    const stored = fake.settings[TOOLS_KEY] as { v: number; commands: (typeof EDITOR)[] }
    expect(stored.v).toBe(1)
    expect(stored.commands).toHaveLength(1)
    const id = stored.commands[0]!.id
    expect(stored.commands[0]).toEqual({
      id,
      title: "Diff",
      command: "meld",
      params: "%P%N %T%N",
      dir: "",
      icon: "compare",
      menu: true,
      console: false,
    })
    // It is on the toolbar and can take a key.
    expect((fake.settings[TOOLBAR_KEY] as { items: string[] }).items.at(-1)).toBe(`tool:${id}`)
    expect(
      within(toolbar()).getByRole("button", { name: "Diff", hidden: true }),
    ).toBeInTheDocument()
    expect(useKeymapStore.getState().actions.some((a) => a.id === `tool:${id}`)).toBe(true)

    // Removing it takes its button along.
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove Diff" }))
    })
    expect(fake.settings[TOOLS_KEY]).toEqual({ v: 1, commands: [] })
    expect(within(toolbar()).queryByRole("button", { name: "Diff", hidden: true })).toBeNull()
    expect(fake.api.shell.runTool).not.toHaveBeenCalled()
  })
})

describe("the toolbar and the bars", () => {
  it("in edit mode its buttons move instead of running: drag, or right-click to move or remove", async () => {
    await start()
    const ids = () => useToolsStore.getState().toolbar
    const button = (name: string) => within(toolbar()).getByRole("button", { name })
    const edit = screen.getByTestId("toolbar-edit")
    await act(async () => void fireEvent.click(edit))
    expect(edit).toHaveAttribute("aria-pressed", "true")
    expect(toolbar()).toHaveAttribute("data-editing", "true")

    // A click does nothing now (Find files would open its dialog).
    await act(async () => void fireEvent.click(button("Find files")))
    expect(screen.queryByTestId("find-dialog")).toBeNull()

    // Right-click: move right, then remove.
    expect(ids().slice(0, 2)).toEqual(["find.open", "view.filter"])
    fireEvent.contextMenu(button("Find files"), { clientX: 10, clientY: 10 })
    await act(async () =>
      fireEvent.click(
        within(screen.getByTestId("toolbar-item-menu")).getByRole("menuitem", {
          name: "Move right",
        }),
      ),
    )
    expect(ids().slice(0, 2)).toEqual(["view.filter", "find.open"])
    fireEvent.contextMenu(button("Find files"), { clientX: 10, clientY: 10 })
    await act(async () =>
      fireEvent.click(
        within(screen.getByTestId("toolbar-item-menu")).getByRole("menuitem", {
          name: "Remove from the toolbar",
        }),
      ),
    )
    expect(ids()).not.toContain("find.open")

    // Drag: Refresh before Quick filter (the first).
    const from = ids().indexOf("view.refresh")
    const data = { setData: vi.fn(), effectAllowed: "" }
    fireEvent.dragStart(button("Refresh"), { dataTransfer: data })
    const target = button("Quick filter")
    target.getBoundingClientRect = () => ({ left: 0, width: 32 }) as DOMRect
    fireEvent.dragOver(target, { clientX: 2, dataTransfer: data })
    await act(async () => void fireEvent.drop(target, { clientX: 2, dataTransfer: data }))
    expect(from).toBeGreaterThan(0)
    expect(ids()[0]).toBe("view.refresh")

    // Esc leaves edit mode; a click runs again.
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }))
    expect(edit).toHaveAttribute("aria-pressed", "false")
    expect(within(toolbar()).queryByRole("button", { name: "Add to the toolbar" })).toBeNull()
  })

  it("the + menu has a search field: typing filters, Enter adds the first match", async () => {
    await start()
    await act(async () => void fireEvent.click(screen.getByTestId("toolbar-edit")))
    await act(async () =>
      fireEvent.click(within(toolbar()).getByRole("button", { name: "Add to the toolbar" })),
    )
    const menu = screen.getByTestId("toolbar-add-menu")
    const field = within(menu).getByRole("searchbox", { name: "Search actions" })
    expect(field).toHaveFocus()
    await act(async () => void fireEvent.change(field, { target: { value: "SWAP" } }))
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((m) => m.textContent),
    ).toEqual(["Swap panels", "Customize toolbar…"])
    // Space types (it does not pick the entry).
    fireEvent.keyDown(field, { key: " " })
    expect(useToolsStore.getState().toolbar).not.toContain("panels.swap")
    await act(async () => void fireEvent.keyDown(field, { key: "Enter" }))
    expect(useToolsStore.getState().toolbar.at(-1)).toBe("panels.swap")
    await act(async () => void fireEvent.change(field, { target: { value: "zzzz" } }))
    expect(within(menu).getByText("No matches")).toBeInTheDocument()
    await act(async () => void fireEvent.keyDown(field, { key: "Escape" }))
    expect(screen.queryByTestId("toolbar-add-menu")).toBeNull()
  })

  it("adds buttons from its + menu at once, and opens Settings at Toolbar", async () => {
    const fake = await start()
    // The "+" is part of edit mode.
    expect(within(toolbar()).queryByRole("button", { name: "Add to the toolbar" })).toBeNull()
    await act(async () => void fireEvent.click(screen.getByTestId("toolbar-edit")))
    const plus = within(toolbar()).getByRole("button", { name: "Add to the toolbar" })
    await act(async () => void fireEvent.click(plus))
    const menu = screen.getByTestId("toolbar-add-menu")
    // What is not on the toolbar yet: Find files is, the Thumbnails view is not.
    expect(within(menu).queryByRole("menuitem", { name: /Find files/ })).toBeNull()
    await act(async () =>
      fireEvent.click(within(menu).getByRole("menuitem", { name: /Thumbnails view/ })),
    )
    expect(useToolsStore.getState().toolbar.at(-1)).toBe("view.thumbs")
    expect(within(toolbar()).getByRole("button", { name: "Thumbnails view" })).toBeInTheDocument()
    // The menu stays open for more, without what was just added.
    const still = screen.getByTestId("toolbar-add-menu")
    expect(within(still).queryByRole("menuitem", { name: /Thumbnails view/ })).toBeNull()
    await waitFor(() =>
      expect((fake.settings[TOOLBAR_KEY] as { items: string[] }).items.at(-1)).toBe("view.thumbs"),
    )
    // A divider at the end stays, and the next button comes after it; a second one is not offered.
    await act(async () => fireEvent.click(within(still).getByRole("menuitem", { name: "Divider" })))
    expect(useToolsStore.getState().toolbar.at(-1)).toBe("|")
    expect(within(toolbar()).getAllByRole("separator").length).toBeGreaterThan(0)
    expect(
      within(screen.getByTestId("toolbar-add-menu")).getByRole("menuitem", { name: "Divider" }),
    ).toHaveAttribute("aria-disabled", "true")
    await act(async () =>
      fireEvent.click(
        within(screen.getByTestId("toolbar-add-menu")).getByRole("menuitem", {
          name: /Swap panels/,
        }),
      ),
    )
    expect(useToolsStore.getState().toolbar.slice(-3)).toEqual(["view.thumbs", "|", "panels.swap"])

    fake.api.settings.openWindow.mockResolvedValueOnce({ ok: true, r: { ok: true } })
    await act(async () =>
      fireEvent.click(within(still).getByRole("menuitem", { name: "Customize toolbar…" })),
    )
    expect(fake.api.settings.openWindow).toHaveBeenLastCalledWith("commander", "toolbar")
  })

  it("shows the default buttons until it is changed, and stores the change", async () => {
    const fake = await start()
    // The toolbar's own edit switch is not one of its buttons.
    const names = () =>
      within(toolbar())
        .getAllByRole("button", { hidden: true })
        .map((b) => b.getAttribute("aria-label"))
        .filter((name) => name !== "Edit the toolbar" && name !== "Add to the toolbar")
    expect(names()).toEqual([
      "Find files",
      "Quick filter",
      "Branch view (all files below)",
      "Compare directories",
      "Synchronize directories",
      "Compare by content",
      "Quick view",
      "Refresh",
      "Directory hotlist",
      "Rename",
    ])
    const dialog = await openSettings("Toolbar")
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Remove Find files from the toolbar" }),
      )
    })
    expect(names()[0]).toBe("Quick filter")
    await act(async () => {
      fireEvent.change(within(dialog).getByLabelText("Button to add"), {
        target: { value: "view.thumbs" },
      })
    })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Add" }))
    })
    expect(names().at(-1)).toBe("Thumbnails view")
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Move Thumbnails view up" }))
    })
    expect(names().slice(-2)).toEqual(["Thumbnails view", "Rename"])
    expect((fake.settings[TOOLBAR_KEY] as { items: string[] }).items.slice(-2)).toEqual([
      "view.thumbs",
      "files.rename",
    ])
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Reset" }))
    })
    expect(fake.settings[TOOLBAR_KEY]).toEqual({ v: 1, items: [...DEFAULT_TOOLBAR] })
    expect(names()[0]).toBe("Find files")
  })

  it("hides the toolbar, the command line and the function keys", async () => {
    const fake = await start()
    const dialog = await openSettings()
    for (const bar of ["Toolbar", "Command line", "Function-key bar"]) {
      await act(async () => {
        fireEvent.click(within(dialog).getByRole("checkbox", { name: bar }))
      })
    }
    expect(screen.queryByTestId("quick-actions")).toBeNull()
    expect(screen.queryByTestId("command-line")).toBeNull()
    expect(screen.queryByTestId("function-keys")).toBeNull()
    expect(fake.settings[SETTINGS_KEY]).toMatchObject({
      showToolbar: false,
      showCommandLine: false,
      showFunctionKeys: false,
    })
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })
    })
    // Ctrl+K brings the command line back.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await key("left", { key: "k", ctrlKey: true })
    await waitFor(() => expect(line()).toHaveFocus())
    expect(useSettingsStore.getState().settings.showCommandLine).toBe(true)
  })

  it("reads stored toolbars strictly", () => {
    const commands = [{ ...EDITOR, icon: "edit" as const }]
    expect(readToolbar(undefined, commands)).toEqual([...DEFAULT_TOOLBAR])
    expect(readToolbar({ v: 1, items: [] }, commands)).toEqual([])
    expect(
      readToolbar(
        { v: 1, items: ["|", "find.open", "|", "|", "tool:ed1", "tool:x", 7, "find.open", "|"] },
        commands,
      ),
      // Leading and doubled dividers go; one at the end stays (the "+" adds after it).
    ).toEqual(["find.open", "|", "tool:ed1", "|"])
    // Lister actions are not toolbar buttons.
    expect(readToolbar({ v: 1, items: ["lister.close"] }, commands)).toEqual([])
  })
})

describe("operations and confirmations", () => {
  it("the copy dialog starts with the policy and verify of Settings", async () => {
    await start({
      settings: { [SETTINGS_KEY]: { v: 2, copyConflict: "skip", copyVerify: true } },
    })
    expect(useSettingsStore.getState().settings).toMatchObject({
      copyConflict: "skip",
      copyVerify: true,
    })
    await cursorTo(3)
    await key("left", { key: "F5" })
    const dialog = await screen.findByTestId("copy-dialog")
    expect(within(dialog).getByLabelText("If the name exists")).toHaveValue("skip")
    expect(useFilesStore.getState().copy).toMatchObject({ conflict: "skip", verify: true })
  })

  it("F8 moves to the trash without a question when Settings say so; a permanent delete still asks", async () => {
    const fake = await start({ settings: { [SETTINGS_KEY]: { v: 2, confirmTrash: false } } })
    await cursorTo(3)
    await key("left", { key: "F8" })
    await waitFor(() =>
      expect(fake.api.files.start).toHaveBeenCalledWith(expect.objectContaining({ kind: "trash" })),
    )
    expect(screen.queryByRole("dialog")).toBeNull()
    await cursorTo(4)
    await key("left", { key: "F8", shiftKey: true })
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument())
    expect(fake.api.files.start).toHaveBeenCalledTimes(1)
  })

  it("keeps the defaults for stored settings of earlier stages", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      showToolbar: true,
      showCommandLine: true,
      showFunctionKeys: true,
      thumbSize: "small",
      copyConflict: "ask",
      copyVerify: false,
      confirmTrash: true,
      confirmDrop: true,
    })
  })
})

describe("the Thumbnails view", () => {
  const tiles = () => grid("left").querySelectorAll<HTMLElement>("[data-row]")

  it("shows the panel as tiles on the shared thumbnail store, with a bounded DOM", async () => {
    const fake = await start({}, PICS.path)
    await key("left", { key: "F1", ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(grid("left")).toHaveAttribute("data-view", "thumbs"))
    // The new view took the keys.
    await waitFor(() => expect(grid("left")).toHaveFocus())
    expect(grid("left")).toHaveAttribute("role", "listbox")
    // 800 px: six 120 px tiles a row; 5,002 rows ("..", a folder, the files).
    expect(grid("left")).toHaveAttribute("data-per-row", "6")
    expect(useListingStore.getState().left.query!.total).toBe(PICTURES + 1)
    // Mounted: the visible rows and the overscan, never the folder.
    expect(tiles().length).toBeGreaterThan(12)
    expect(tiles().length).toBeLessThanOrEqual(60)
    expect(tiles()[0]).toHaveAttribute("data-kind", "parent")
    expect(tiles()[1]).toHaveAttribute("data-kind", "dir")

    // One request for the settled range: pictures only, on the panel's own lane.
    await waitFor(() => expect(fake.api.preview.ensure).toHaveBeenCalled())
    const request = fake.api.preview.ensure.mock.calls.at(-1)![0] as {
      lane: string
      profile: string
      items: { id: number }[]
    }
    expect(request).toMatchObject({ lane: "cmd-tiles-left", profile: "grid-sm" })
    const txt = (id: number): boolean => (id - 40_100_000) % 7 === 3
    expect(request.items.length).toBeGreaterThan(0)
    expect(request.items.some(({ id }) => id < 40_100_000 || txt(id))).toBe(false)
    await waitFor(() => expect(grid("left").querySelector("img")).not.toBeNull())
    expect(grid("left").querySelector("img")!.getAttribute("src")).toMatch(/^panelyth-thumb:/)

    // The view is stored with the tab.
    flushPersist()
    const stored = fake.settings[PANELS_KEY] as { left: { tabs: { view: string }[] } }
    expect(stored.left.tabs[0]!.view).toBe("thumbs")
  })

  it("moves the cursor by tiles and rows, and marks as the other views do", async () => {
    await start({}, PICS.path)
    await key("left", { key: "F1", ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(grid("left")).toHaveAttribute("data-view", "thumbs"))
    const cursor = () => useListingStore.getState().left.cursor
    expect(cursor()).toBe(0)
    await key("left", { key: "ArrowRight" })
    expect(cursor()).toBe(1)
    await key("left", { key: "ArrowDown" })
    expect(cursor()).toBe(7)
    await key("left", { key: "ArrowUp" })
    await key("left", { key: "ArrowLeft" })
    expect(cursor()).toBe(0)
    await key("left", { key: "End" })
    expect(cursor()).toBe(PICTURES + 1)
    await key("left", { key: "Home" })
    await key("left", { key: "ArrowDown" })
    await waitFor(() => expect(cursorRow("left")).toHaveAttribute("data-row", "6"))
    // Insert marks the tile and moves on.
    await key("left", { key: "Insert" })
    await waitFor(() =>
      expect(grid("left").querySelector('[data-row="6"]')).toHaveAttribute("data-marked", "true"),
    )
    expect(grid("left").querySelector('[data-row="6"]')).toHaveAttribute("aria-selected", "true")
    expect(cursor()).toBe(7)
    // F2 renames in the tile's name line; Esc gives the keys back.
    await key("left", { key: "F2" })
    const field = await within(grid("left")).findByTestId("rename-field")
    await act(async () => {
      fireEvent.keyDown(field, { key: "Escape" })
    })
    await waitFor(() => expect(within(grid("left")).queryByTestId("rename-field")).toBeNull())
    expect(cursor()).toBe(7)
    // A typed letter starts quick search, as in the other views.
    await key("left", { key: "p" })
    await waitFor(() => expect(screen.getByTestId("quicksearch-left")).toHaveTextContent("p"))
    await key("left", { key: "Escape" })
    expect(screen.queryByTestId("quicksearch-left")).toBeNull()
    const at = cursor()
    // Ctrl+F2: the Full view again, the cursor where it was.
    await key("left", { key: "F2", ctrlKey: true })
    await waitFor(() => expect(grid("left")).toHaveAttribute("role", "grid"))
    expect(cursor()).toBe(at)
  })

  it("asks pages for thumbnails only while tiles show", async () => {
    const fake = await start({}, PICS.path)
    const profiles = () =>
      fake.api.query.page.mock.calls.map(
        (c) => (c[0] as unknown as { thumbProfile: string | null }).thumbProfile,
      )
    expect(profiles().every((p) => p === null)).toBe(true)
    await key("left", { key: "F1", ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(grid("left")).toHaveAttribute("data-view", "thumbs"))
    const before = profiles().length
    await key("left", { key: "End" })
    // jsdom has no scrolling: deliver the scroll the virtualizer asked for.
    Object.defineProperty(grid("left"), "scrollTop", { configurable: true, value: 120_000 })
    await act(async () => fireEvent.scroll(grid("left")))
    await waitFor(() => expect(profiles().length).toBeGreaterThan(before))
    expect(
      profiles()
        .slice(before)
        .every((p) => p === "grid-sm"),
    ).toBe(true)
  })
})
