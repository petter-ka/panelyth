import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TitleBar } from "./TitleBar"
import {
  connectWindowFrame,
  useWindowFrameStore,
  type WindowFramePort,
  type WindowFrameState,
} from "./windowFrame"

function fakePort(titleBar: boolean, initial: WindowFrameState, shown = true) {
  let emit: (state: WindowFrameState) => void = () => undefined
  let emitShown: (shown: boolean) => void = () => undefined
  const port: WindowFramePort = {
    titleBar,
    state: vi.fn(async () => ({ ...initial, shown })),
    control: vi.fn(async () => undefined),
    onState: (listener) => {
      emit = listener
      return () => undefined
    },
    onShown: (listener) => {
      emitShown = listener
      return () => undefined
    },
  }
  return {
    port,
    emit: (state: WindowFrameState) => emit(state),
    show: (on: boolean) => emitShown(on),
  }
}

describe("the window's title strip", () => {
  afterEach(() => {
    useWindowFrameStore.setState({
      titleBar: false,
      maximized: false,
      fullScreen: false,
      shown: true,
    })
    delete document.documentElement.dataset.titleBar
  })

  it("names the app and where it is, and draws the window's buttons", async () => {
    const { port } = fakePort(true, { maximized: false, fullScreen: false })
    connectWindowFrame(port)
    render(<TitleBar title="Panelyth Commander" detail={"C:\\Photos"} />)
    await act(async () => undefined)
    expect(screen.getByTestId("title-bar")).toHaveTextContent("Panelyth Commander")
    expect(screen.getByTestId("title-bar-detail")).toHaveTextContent("C:\\Photos")
    // The full-window overlays start below it.
    expect(document.documentElement.dataset.titleBar).toBe("")

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }))
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }))
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(vi.mocked(port.control).mock.calls).toEqual([
      ["minimize"],
      ["toggleMaximize"],
      ["close"],
    ])
  })

  it("shows Restore on a maximized window and hides in full screen", async () => {
    const { port, emit } = fakePort(true, { maximized: true, fullScreen: false })
    connectWindowFrame(port)
    render(<TitleBar title="Panelyth" />)
    await act(async () => undefined)
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument()
    expect(screen.queryByTestId("title-bar-detail")).toBeNull()

    act(() => emit({ maximized: true, fullScreen: true }))
    expect(screen.getByTestId("title-bar")).toHaveAttribute("aria-hidden", "true")
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull()
    expect(document.documentElement.dataset.titleBar).toBeUndefined()

    act(() => emit({ maximized: false, fullScreen: false }))
    expect(screen.getByRole("button", { name: "Maximize" })).toBeInTheDocument()
  })

  it("an event that came before the first answer wins", async () => {
    let answer: (state: WindowFrameState & { shown: boolean }) => void = () => undefined
    const { port, emit, show } = fakePort(true, { maximized: false, fullScreen: false })
    port.state = () => new Promise((resolve) => (answer = resolve))
    connectWindowFrame(port)
    emit({ maximized: true, fullScreen: false })
    show(false)
    await act(async () => answer({ maximized: false, fullScreen: false, shown: true }))
    expect(useWindowFrameStore.getState().maximized).toBe(true)
    expect(useWindowFrameStore.getState().shown).toBe(false)
  })

  it("gives up its drag area while its app is hidden: it lies under the shown app's buttons", async () => {
    const { port, show } = fakePort(true, { maximized: false, fullScreen: false }, false)
    connectWindowFrame(port)
    render(<TitleBar title="Panelyth" />)
    await act(async () => undefined)
    // Hidden at start (the commander was shown first): main's answer says so.
    expect(screen.getByTestId("title-bar")).toHaveAttribute("data-inert", "true")
    expect(screen.getByTestId("title-bar-mark")).toHaveAttribute("data-inert", "true")
    act(() => show(true))
    expect(screen.getByTestId("title-bar")).not.toHaveAttribute("data-inert")
    act(() => show(false))
    expect(screen.getByTestId("title-bar")).toHaveAttribute("data-inert", "true")
  })

  it("stays out of the way where the OS draws the frame (macOS, Linux)", () => {
    const { port } = fakePort(false, { maximized: false, fullScreen: false })
    connectWindowFrame(port)
    render(<TitleBar title="Panelyth System" />)
    // Still rendered, so the app's grid keeps its rows.
    expect(screen.getByTestId("title-bar")).toHaveAttribute("aria-hidden", "true")
    expect(screen.queryByRole("button")).toBeNull()
    expect(port.state).not.toHaveBeenCalled()
  })
})
