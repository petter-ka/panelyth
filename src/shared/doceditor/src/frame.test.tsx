import { act, fireEvent, render, screen } from "@testing-library/react"
import { useWindowFrameStore } from "@panelyth/ui"
import { afterEach, describe, expect, it, vi } from "vitest"
import { App } from "./App"
import { connectFrame } from "./frame"
import { fakeApi } from "./testing/fakeApi"
import { createWorkspace, type Workspace } from "./workspace"

let current: Workspace | null = null
afterEach(() => {
  current?.destroy()
  current = null
  useWindowFrameStore.setState({
    titleBar: false,
    maximized: false,
    fullScreen: false,
    shown: true,
  })
  delete document.documentElement.dataset.titleBar
})

async function open(titleBar: boolean) {
  const api = fakeApi()
  api.frame.titleBar = titleBar
  api.currentSession = { ...api.currentSession, name: "notes.txt" }
  connectFrame(api)
  const workspace = createWorkspace({ api, session: api.currentSession, text: "hello", dark: true })
  current = workspace
  render(<App workspace={workspace} />)
  await act(async () => undefined)
  return { api, workspace }
}

describe("the editor window's title strip", () => {
  it("names the file and drives this window's buttons", async () => {
    const { api } = await open(true)
    const strip = screen.getByTestId("title-bar")
    expect(strip).toHaveTextContent("notes.txt")
    expect(screen.getByTestId("title-bar-mark")).toBeInTheDocument()
    expect(document.documentElement.dataset.titleBar).toBe("")
    // Above the editor's own header, which stays as it was.
    expect(strip.compareDocumentPosition(screen.getByTestId("file-name"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }))
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }))
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(vi.mocked(api.frame.control).mock.calls).toEqual([
      ["minimize"],
      ["toggleMaximize"],
      ["close"],
    ])
  })

  it("shows Restore while the window is maximized", async () => {
    const { api } = await open(true)
    act(() => api.emit("window.state", { maximized: true, fullScreen: false }))
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Maximize" })).toBeNull()
    // Full screen: no strip (and no height for it).
    act(() => api.emit("window.state", { maximized: true, fullScreen: true }))
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull()
    expect(document.documentElement.dataset.titleBar).toBeUndefined()
  })

  it("draws no buttons where the OS draws the frame", async () => {
    const { api } = await open(false)
    expect(screen.queryByRole("button", { name: "Minimize" })).toBeNull()
    expect(api.frame.state).not.toHaveBeenCalled()
    expect(document.documentElement.dataset.titleBar).toBeUndefined()
  })
})
