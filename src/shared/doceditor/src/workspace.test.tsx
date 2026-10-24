import { getSearchQuery, replaceAll, SearchQuery, setSearchQuery } from "@codemirror/search"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { App } from "./App"
import { fakeApi, session, type FakeApi } from "./testing/fakeApi"
import { createWorkspace, type Workspace } from "./workspace"

let current: Workspace | null = null
afterEach(() => {
  current?.destroy()
  current = null
})

function open(text: string, api: FakeApi = fakeApi(), name = "notes.txt") {
  api.currentSession = { ...api.currentSession, name }
  const workspace = createWorkspace({ api, session: api.currentSession, text, dark: true })
  current = workspace
  render(<App workspace={workspace} />)
  return { api, workspace, view: workspace.editor.view }
}

const type = (workspace: Workspace, insert: string): void => {
  const view = workspace.editor.view
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert } }))
}

describe("the editor window", () => {
  it("shows the text, labelled with the file's name, and the status bar's facts", async () => {
    const api = fakeApi(session({ encoding: "utf-16le", bom: 2, lineEnding: "crlf" }))
    const { view } = open("# Title\n\nSome words here.\n", api, "notes.md")
    expect(view.contentDOM).toHaveAttribute("aria-label", "notes.md")
    expect(view.state.doc.toString()).toBe("# Title\n\nSome words here.\n")
    expect(screen.getByTestId("status-encoding")).toHaveTextContent("UTF-16 LE")
    expect(screen.getByTestId("status-eol")).toHaveTextContent("CRLF")
    await waitFor(() => expect(screen.getByTestId("status-language")).toHaveTextContent("Markdown"))
    await waitFor(() => expect(screen.getByTestId("status-counts")).toHaveTextContent("4 words"))
    expect(screen.getByTestId("status-counts")).toHaveTextContent("4 lines")
    expect(screen.getByTestId("status-cursor")).toHaveTextContent("Ln 1, Col 1")
  })

  it("names plain text", async () => {
    open("hello", fakeApi(), "notes.txt")
    await waitFor(() =>
      expect(screen.getByTestId("status-language")).toHaveTextContent("Plain text"),
    )
  })

  it("counts the selection when there is one", async () => {
    const { view } = open("alpha beta gamma")
    act(() => view.dispatch({ selection: { anchor: 0, head: 10 } }))
    await waitFor(() =>
      expect(screen.getByTestId("status-counts")).toHaveTextContent("Selection: 2 words"),
    )
    await waitFor(() =>
      expect(screen.getByTestId("status-cursor")).toHaveTextContent("10 selected"),
    )
  })

  it("shows the dot while there are unsaved changes and saves with Ctrl+S", async () => {
    const { api, workspace } = open("hello")
    expect(screen.queryByTestId("dirty-dot")).toBeNull()
    type(workspace, " world")
    expect(screen.getByTestId("dirty-dot")).toHaveAccessibleName("Unsaved changes")
    await act(async () => {
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true })
    })
    await waitFor(() => expect(screen.queryByTestId("dirty-dot")).toBeNull())
    expect(api.writes).toEqual([{ seq: 0, text: "hello world" }])
    expect(screen.getByTestId("status-notice")).toHaveTextContent("Saved")
  })

  it("finds and replaces through the panel", async () => {
    const { workspace, view } = open("one cat, two cats, Cat")
    act(() => workspace.openReplace())
    const find = screen.getByRole("textbox", { name: "Find" })
    const replace = screen.getByRole("textbox", { name: "Replace with" })
    expect(document.activeElement).toBe(replace)
    fireEvent.input(find, { target: { value: "cat" } })
    fireEvent.input(replace, { target: { value: "dog" } })
    expect(getSearchQuery(view.state).search).toBe("cat")
    await waitFor(() => expect(screen.getByRole("search")).toHaveTextContent("3 matches"))
    fireEvent.click(screen.getByRole("button", { name: "Match case" }))
    expect(getSearchQuery(view.state).caseSensitive).toBe(true)
    await waitFor(() => expect(screen.getByRole("search")).toHaveTextContent("2 matches"))
    fireEvent.click(screen.getByRole("button", { name: "Whole word" }))
    await waitFor(() => expect(screen.getByRole("search")).toHaveTextContent("1 match"))
    fireEvent.click(screen.getByRole("button", { name: "Replace all" }))
    expect(view.state.doc.toString()).toBe("one dog, two cats, Cat")
    expect(screen.getByTestId("dirty-dot")).toBeInTheDocument()
  })

  it("Ctrl+H in the find field shows the replace row", () => {
    const { workspace } = open("text")
    act(() => workspace.openFind())
    const find = screen.getByRole("textbox", { name: "Find" })
    expect(document.activeElement).toBe(find)
    expect(screen.queryByRole("textbox", { name: "Replace with" })).toBeNull()
    act(() => {
      fireEvent.keyDown(find, { key: "h", code: "KeyH", keyCode: 72, ctrlKey: true })
    })
    const replace = screen.getByRole("textbox", { name: "Replace with" })
    expect(document.activeElement).toBe(replace)
    expect(screen.getByRole("button", { name: "Show replace" })).toHaveAttribute(
      "aria-expanded",
      "true",
    )
  })

  it("replaces with a regular expression", () => {
    const { workspace, view } = open("a1 b22 c333")
    act(() => workspace.openFind())
    act(() =>
      view.dispatch({
        effects: setSearchQuery.of(new SearchQuery({ search: "\\d+", regexp: true, replace: "#" })),
      }),
    )
    act(() => void replaceAll(view))
    expect(view.state.doc.toString()).toBe("a# b# c#")
  })

  it("asks before closing with unsaved changes", async () => {
    const { api, workspace } = open("hello")
    type(workspace, "!")
    act(() => api.emit("texteditor.closeRequest", {}))
    const dialog = await screen.findByRole("dialog", { name: "Save the changes to notes.txt?" })
    expect(dialog).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Don't save" }))
    await waitFor(() => expect(api.closes).toEqual([true]))
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("shows the conflict and overwrites", async () => {
    const { api, workspace } = open("hello")
    type(workspace, "!")
    api.commitAnswers.push({ status: "conflict", gone: false })
    await act(async () => workspace.save())
    await screen.findByRole("dialog", { name: "The file changed on disk" })
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(api.commits.at(-1)).toMatchObject({ force: true })
    expect(screen.queryByTestId("dirty-dot")).toBeNull()
  })

  it("Esc on the encoding question cancels and keeps the edits", async () => {
    const { api, workspace } = open("hello")
    type(workspace, "✓")
    api.commitAnswers.push({ status: "unencodable", line: 1 })
    await act(async () => workspace.save())
    const dialog = await screen.findByRole("dialog", { name: "This text can't be saved in UTF-8" })
    fireEvent.keyDown(dialog, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(screen.getByTestId("dirty-dot")).toBeInTheDocument()
    expect(api.commits).toHaveLength(1)
  })

  it("offers Reload when the file changed on disk while nothing was unsaved", async () => {
    const api = fakeApi()
    const { view } = open("old text", api)
    api.disk = { version: "c".repeat(64), sizeBytes: 3, mtimeNs: 5 }
    // The page reads the new text through its token URL.
    const fetchMock = async () => new Response(new TextEncoder().encode("new text"))
    globalThis.fetch = fetchMock as typeof fetch
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
    })
    expect(await screen.findByTestId("disk-banner")).toHaveTextContent(
      "The file changed on disk. Reload?",
    )
    fireEvent.click(screen.getByRole("button", { name: "Reload" }))
    await waitFor(() => expect(view.state.doc.toString()).toBe("new text"))
    expect(screen.queryByTestId("disk-banner")).toBeNull()
  })

  it("Alt+Z toggles soft wrap and remembers it", () => {
    const { view } = open("text")
    expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(false)
    act(() => {
      fireEvent.keyDown(window, { key: "z", code: "KeyZ", altKey: true })
    })
    expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(true)
    expect(localStorage.getItem("panelyth.editor.wrap")).toBe("1")
    expect(screen.getByRole("button", { name: /Wrap/ })).toHaveAttribute("aria-pressed", "true")
    act(() => {
      fireEvent.keyDown(window, { key: "z", code: "KeyZ", altKey: true })
    })
    expect(localStorage.getItem("panelyth.editor.wrap")).toBe("0")
  })

  it("follows the shared appearance live", () => {
    const { api } = open("text")
    act(() =>
      api.emit("settings.changed", {
        key: "shared.appearance",
        value: { theme: "light", style: "terminal", interfaceSize: "large" },
      }),
    )
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    expect(document.documentElement.dataset.theme).toBe("light")
    expect(document.documentElement.dataset.interfaceSize).toBe("large")
    expect(document.documentElement.dataset.style).toBe("terminal")
    // The glass style's cards are the apps' layout: the editor shows it classic.
    act(() => api.emit("settings.changed", { key: "shared.appearance", value: { style: "glass" } }))
    expect(document.documentElement.dataset.style).toBe("classic")
  })
})
