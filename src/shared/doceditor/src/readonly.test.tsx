import { deleteCharBackward, insertNewlineAndIndent, undoDepth } from "@codemirror/commands"
import { searchPanelOpen } from "@codemirror/search"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "./App"
import { fakeApi, type FakeApi } from "./testing/fakeApi"
import { createWorkspace, type Workspace } from "./workspace"

let current: Workspace | null = null
beforeEach(() => localStorage.clear())
afterEach(() => {
  current?.destroy()
  current = null
  vi.unstubAllGlobals()
})

const TEXT = "# Notes\n\n- [ ] task\n\nplain text here"

/**
 * A read-only window, shown in Live: F3 opens Markdown in Preview, and these
 * tests are about the editor's read-only behaviour, which holds in Live and
 * Source too (the switch is one click away in a read-only window).
 */
async function open(readOnly = true, name = "README.md") {
  const api: FakeApi = fakeApi()
  api.currentSession = { ...api.currentSession, name, readOnly }
  const workspace = createWorkspace({ api, session: api.currentSession, text: TEXT, dark: true })
  current = workspace
  render(<App workspace={workspace} />)
  await act(async () => workspace.markdownReady)
  await act(async () => {
    await workspace.settled()
    await workspace.setMode("live")
  })
  return { api, workspace, view: workspace.editor.view }
}

const png = (): File =>
  new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" })

function pasteImage(target: HTMLElement): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true })
  const file = png()
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
      getData: () => "",
      types: ["Files"],
    },
  })
  target.dispatchEvent(event)
  return event
}

function dropImage(target: HTMLElement): Event {
  const event = new Event("drop", { bubbles: true, cancelable: true })
  Object.defineProperty(event, "dataTransfer", { value: { files: [png()], types: ["Files"] } })
  target.dispatchEvent(event)
  return event
}

describe("a read-only window (F3)", () => {
  it("shows the mark and Edit instead of Save", async () => {
    await open()
    expect(screen.getByTestId("readonly-mark")).toHaveTextContent("Read-only")
    expect(screen.getByTestId("edit")).toHaveTextContent("Edit")
    expect(screen.getByTestId("edit")).toHaveAttribute("data-tooltip-content", "Edit (F4)")
    expect(screen.queryByTestId("save")).toBeNull()
    expect(screen.getByTestId("editor-host")).toHaveAttribute("data-readonly", "true")
    expect(screen.getByTestId("mode-switch")).toBeInTheDocument()
  })

  it("takes no typing, paste, drop, task tick or Ctrl+S", async () => {
    const { api, view } = await open()
    expect(view.state.readOnly).toBe(true)
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("false")
    expect(insertNewlineAndIndent(view)).toBe(false)
    expect(deleteCharBackward(view)).toBe(false)
    fireEvent.keyDown(view.contentDOM, { key: "Enter", code: "Enter", keyCode: 13 })

    expect(pasteImage(view.contentDOM).defaultPrevented).toBe(true)
    expect(dropImage(view.contentDOM).defaultPrevented).toBe(true)
    await new Promise((r) => setTimeout(r, 10))
    expect(api.assetChunk).not.toHaveBeenCalled()

    const box = view.contentDOM.querySelector("[data-testid=live-task]")!
    box.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))

    await act(async () => {
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true })
    })
    expect(api.write).not.toHaveBeenCalled()
    expect(api.commit).not.toHaveBeenCalled()
    expect(view.state.doc.toString()).toBe(TEXT)
    expect(screen.queryByTestId("dirty-dot")).toBeNull()
    expect(api.dirtyCalls).toEqual([])
  })

  it("keeps the cursor, selection, find and copy", async () => {
    const { view } = await open()
    // The content stays focusable, so the keyboard moves the cursor.
    expect(view.contentDOM.getAttribute("tabindex")).toBe("0")
    act(() => view.dispatch({ selection: { anchor: 0 } }))
    fireEvent.keyDown(view.contentDOM, { key: "ArrowRight", code: "ArrowRight", keyCode: 39 })
    expect(view.state.selection.main.head).toBe(1)

    const at = TEXT.indexOf("plain")
    act(() => view.dispatch({ selection: { anchor: at, head: at + 5 } }))
    // A real selection is a DOM selection in the content (jsdom does not sync one by itself).
    view.focus()
    window.getSelection()!.selectAllChildren(view.contentDOM)
    document.dispatchEvent(new Event("selectionchange"))
    act(() => view.dispatch({ selection: { anchor: at, head: at + 5 } }))
    const setData = vi.fn()
    const copy = new Event("copy", { bubbles: true, cancelable: true })
    Object.defineProperty(copy, "clipboardData", { value: { setData, clearData: vi.fn() } })
    view.contentDOM.dispatchEvent(copy)
    expect(setData).toHaveBeenCalledWith("text/plain", "plain")
    expect(view.state.doc.toString()).toBe(TEXT)

    fireEvent.keyDown(view.contentDOM, { key: "f", code: "KeyF", keyCode: 70, ctrlKey: true })
    expect(searchPanelOpen(view.state)).toBe(true)
    const find = screen.getByRole("textbox", { name: "Find" })
    // Replace is not offered, not even with Ctrl+H.
    const expand = document.querySelector<HTMLButtonElement>('[aria-label="Show replace"]')!
    expect(expand.hidden).toBe(true)
    fireEvent.keyDown(find, { key: "h", code: "KeyH", keyCode: 72, ctrlKey: true })
    expect(screen.queryByRole("textbox", { name: "Replace with" })).toBeNull()
  })

  it("follows a change on disk by itself (nothing can be unsaved)", async () => {
    const { api, view } = await open()
    api.disk = { version: "c".repeat(64), sizeBytes: 3, mtimeNs: 9 }
    vi.stubGlobal("fetch", async () => new Response(new TextEncoder().encode("# New\n\nfrom disk")))
    await act(async () => current!.controller.checkDisk())
    await waitFor(() => expect(view.state.doc.toString()).toBe("# New\n\nfrom disk"))
    expect(screen.queryByTestId("disk-banner")).toBeNull()
    expect(view.state.readOnly).toBe(true)
  })
})

describe("editing starts", () => {
  const paths: [string, (ctx: { api: FakeApi }) => void][] = [
    ["with the Edit button", () => fireEvent.click(screen.getByTestId("edit"))],
    ["with F4 in the window", () => fireEvent.keyDown(window, { key: "F4", code: "F4" })],
    ["with main's texteditor.editable", ({ api }) => api.emit("texteditor.editable", {})],
  ]

  it.each(paths)(
    "%s, keeping the state, the cursor and an empty undo history",
    async (_, start) => {
      const { api, view, workspace } = await open()
      const at = TEXT.indexOf("text")
      act(() => view.dispatch({ selection: { anchor: at } }))
      act(() => start({ api }))
      expect(screen.queryByTestId("readonly-mark")).toBeNull()
      expect(screen.queryByTestId("edit")).toBeNull()
      expect(screen.getByTestId("save")).toBeInTheDocument()
      expect(screen.getByTestId("editor-host")).toHaveAttribute("data-readonly", "false")
      expect(workspace.editor.view).toBe(view)
      expect(view.state.readOnly).toBe(false)
      expect(view.contentDOM.getAttribute("contenteditable")).toBe("true")
      expect(view.state.selection.main.head).toBe(at)
      expect(view.state.doc.toString()).toBe(TEXT)
      expect(undoDepth(view.state)).toBe(0)
      expect(workspace.chrome.get().mode).toBe("live")

      // Now it edits: a task box ticks, and the document is unsaved.
      const box = view.contentDOM.querySelector("[data-testid=live-task]")!
      act(() => void box.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })))
      expect(view.state.doc.toString()).toBe(TEXT.replace("[ ]", "[x]"))
      expect(screen.getByTestId("dirty-dot")).toBeInTheDocument()
    },
  )

  it("F4 does nothing in an editable window, and there is no way back to read-only", async () => {
    const { view, workspace } = await open(false)
    expect(screen.queryByTestId("edit")).toBeNull()
    fireEvent.keyDown(window, { key: "F4", code: "F4" })
    expect(view.state.readOnly).toBe(false)
    expect(workspace.chrome.get().readOnly).toBe(false)
  })

  it("a reload whose session is editable starts editing", async () => {
    const { api, view } = await open()
    api.currentSession = { ...api.currentSession, readOnly: false }
    vi.stubGlobal("fetch", async () => new Response(new TextEncoder().encode(TEXT)))
    await act(async () => current!.controller.reload())
    expect(view.state.readOnly).toBe(false)
    expect(screen.getByTestId("save")).toBeInTheDocument()
  })
})
