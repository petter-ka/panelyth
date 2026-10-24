import { undo } from "@codemirror/commands"
import { searchPanelOpen } from "@codemirror/search"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { App } from "./App"
import { fakeApi } from "./testing/fakeApi"
import { createWorkspace, type Workspace } from "./workspace"

let current: Workspace | null = null
beforeEach(() => localStorage.clear())
afterEach(() => {
  current?.destroy()
  current = null
})

async function open(text: string, name = "README.md", readOnly = false) {
  const api = fakeApi()
  api.currentSession = { ...api.currentSession, name, readOnly }
  const workspace = createWorkspace({ api, session: api.currentSession, text, dark: true })
  current = workspace
  render(<App workspace={workspace} />)
  await act(async () => workspace.markdownReady)
  return { api, workspace, view: workspace.editor.view }
}

const checked = (): string | undefined =>
  screen
    .getAllByRole("radio")
    .find((r) => r.getAttribute("aria-checked") === "true")
    ?.getAttribute("data-mode") ?? undefined

const ctrlE = async (): Promise<void> => {
  await act(async () => {
    fireEvent.keyDown(window, { key: "e", code: "KeyE", ctrlKey: true })
    await current!.settled()
  })
}

const isLive = (w: Workspace): boolean => w.editor.view.dom.classList.contains("cm-md-live")

describe("the mode switch", () => {
  it("shows for Markdown only", async () => {
    await open('{ "a": 1 }', "config.json")
    expect(screen.queryByTestId("mode-switch")).toBeNull()
  })

  it("opens Markdown in Live the first time, and Ctrl+E steps through the modes", async () => {
    const { workspace } = await open("# Hello\n\ntext")
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeInTheDocument()
    expect(checked()).toBe("live")
    expect(isLive(workspace)).toBe(true)

    await ctrlE()
    expect(checked()).toBe("preview")
    expect(workspace.element.hidden).toBe(true)
    expect(workspace.previewElement.hidden).toBe(false)
    await waitFor(() =>
      expect(screen.getByTestId("preview").querySelector("h1")?.textContent).toBe("Hello"),
    )

    await ctrlE()
    expect(checked()).toBe("source")
    expect(workspace.element.hidden).toBe(false)
    expect(isLive(workspace)).toBe(false)
    expect(workspace.editor.view.dom.querySelector(".cm-lineNumbers")).not.toBeNull()

    await ctrlE()
    expect(checked()).toBe("live")
  })

  it("keeps one document: undo history, unsaved state and the cursor survive every switch", async () => {
    const { workspace, view } = await open("# Hello\n\ntext")
    act(() => view.dispatch({ changes: { from: 13, insert: " more" }, selection: { anchor: 18 } }))
    expect(screen.getByTestId("dirty-dot")).toBeInTheDocument()
    for (const mode of ["preview", "source", "live", "preview", "live"] as const) {
      await act(async () => workspace.setMode(mode))
      expect(workspace.editor.view).toBe(view)
      expect(view.state.doc.toString()).toBe("# Hello\n\ntext more")
      expect(view.state.selection.main.head).toBe(18)
      expect(screen.getByTestId("dirty-dot")).toBeInTheDocument()
    }
    act(() => void undo(view))
    expect(view.state.doc.toString()).toBe("# Hello\n\ntext")
    expect(screen.queryByTestId("dirty-dot")).toBeNull()
  })

  it("Markdown opened to edit (F4) always starts in Live, whatever was used last", async () => {
    const first = await open("x", "README.md", false)
    await act(async () => first.workspace.setMode("source"))
    expect(localStorage.length).toBe(0)
    first.workspace.destroy()
    cleanup()
    current = null
    const { workspace } = await open("y", "other.markdown", false)
    expect(workspace.chrome.get().mode).toBe("live")
    expect(isLive(workspace)).toBe(true)
    expect(checked()).toBe("live")
  })

  it("Markdown opened to read (F3) starts in Preview; Edit brings it to Live (owner request)", async () => {
    const { workspace } = await open("# Hello\n\ntext", "README.md", true)
    await act(async () => workspace.settled())
    expect(workspace.chrome.get().mode).toBe("preview")
    expect(checked()).toBe("preview")
    await waitFor(() => expect(screen.getByTestId("preview")).toHaveTextContent("Hello"))
    await act(async () => {
      workspace.startEditing()
      await workspace.settled()
    })
    expect(workspace.chrome.get().mode).toBe("live")
    expect(workspace.chrome.get().readOnly).toBe(false)
    expect(isLive(workspace)).toBe(true)
  })

  it("Preview takes no typing; Ctrl+F there goes back to the editor with find open", async () => {
    const { workspace, view } = await open("# Hello\n\ntext")
    await act(async () => workspace.setMode("preview"))
    const preview = screen.getByTestId("preview")
    expect(preview.closest("[contenteditable]")).toBeNull()
    fireEvent.keyDown(preview, { key: "a", code: "KeyA" })
    expect(view.state.doc.toString()).toBe("# Hello\n\ntext")
    await act(async () => {
      fireEvent.keyDown(preview, { key: "f", code: "KeyF", ctrlKey: true })
      await workspace.settled()
    })
    await waitFor(() => expect(searchPanelOpen(view.state)).toBe(true))
    expect(workspace.chrome.get().mode).toBe("live")
  })

  it("the radio group moves with the arrow keys", async () => {
    const { workspace } = await open("x")
    const live = screen.getByTestId("mode-live")
    await act(async () => {
      fireEvent.keyDown(live, { key: "ArrowLeft" })
      await workspace.settled()
    })
    expect(checked()).toBe("source")
  })
})
