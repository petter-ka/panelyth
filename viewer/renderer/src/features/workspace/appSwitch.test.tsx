import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useGlobalShortcuts } from "../../app/shortcuts"
import { ContentPane } from "../../components/ContentPane"
import { installFakeBridge } from "../../test/fakeBridge"
import { mockViewport } from "../../test/viewport"
import { resetFolderStore } from "../folder/folderStore"
import { startSidecarMonitoring, useSidecarStore } from "../system/sidecarStore"

// The connection point to the commander (ADR-0031, docs/shared/APP-SWITCHING.md).

let stop: (() => void)[] = []

function Harness() {
  useGlobalShortcuts()
  return <ContentPane />
}

function setup(commanderEnabled: boolean) {
  const bridge = installFakeBridge()
  const switchApp = vi.fn(async () => ({ ok: true as const, r: { ok: true as const } }))
  if (commanderEnabled) {
    ;(window.fastview!.app as unknown as { switch?: typeof switchApp }).switch = switchApp
  }
  stop = [startSidecarMonitoring()]
  render(<Harness />)
  return { bridge, switchApp }
}

beforeEach(() => {
  mockViewport(1000, 800)
  resetFolderStore()
  useSidecarStore.setState({ status: null, info: null, pingMs: null, error: null })
})
afterEach(() => {
  stop.forEach((f) => f())
  vi.restoreAllMocks()
})

describe("switch to the commander", () => {
  it("is hidden while the commander is disabled", () => {
    setup(false)
    expect(screen.queryByTestId("app-switch")).not.toBeInTheDocument()
  })

  it("is the first toolbar control and switches by click", async () => {
    const { switchApp } = setup(true)
    const toolbar = screen.getByRole("toolbar", { name: "Navigation" })
    const button = screen.getByRole("button", { name: "Switch to Commander" })
    expect(toolbar.querySelector("button")).toBe(button)
    expect(button).toHaveAttribute("title", "Switch to Commander (Ctrl+Shift+M)")
    fireEvent.click(button)
    await waitFor(() => expect(switchApp).toHaveBeenCalledWith("commander"))
  })

  it("switches with Ctrl+Shift+M, also while typing", async () => {
    const { switchApp } = setup(true)
    await act(async () => {
      fireEvent.keyDown(window, { key: "M", ctrlKey: true, shiftKey: true })
    })
    await waitFor(() => expect(switchApp).toHaveBeenCalledTimes(1))
    const input = document.createElement("input")
    document.body.append(input)
    input.focus()
    await act(async () => {
      fireEvent.keyDown(input, { key: "M", ctrlKey: true, shiftKey: true })
    })
    await waitFor(() => expect(switchApp).toHaveBeenCalledTimes(2))
    input.remove()
  })
})
