import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  openSettingsWindowOr,
  requestSettingsTab,
  settingsTabOf,
  SettingsWindowPage,
  TooltipProvider,
  useSettingsTabRequest,
} from "./index"

describe("the settings window (ADR-0039)", () => {
  beforeEach(() => requestSettingsTab(null))

  it("reads the first tab from main's fragment, and nothing else", () => {
    expect(settingsTabOf("#tab=about")).toBe("about")
    expect(settingsTabOf("tab=appearance")).toBe("appearance")
    expect(settingsTabOf("#tab=panels")).toBeNull()
    expect(settingsTabOf("")).toBeNull()
  })

  it("opens the window on the asked-for tab, or the dialog when it cannot", async () => {
    const dialog = vi.fn()
    requestSettingsTab("about")
    const opened = vi.fn(async () => true)
    await act(async () => openSettingsWindowOr(opened, dialog))
    expect(opened).toHaveBeenCalledWith("about")
    // The window took the tab: a later dialog starts on the app's own.
    expect(useSettingsTabRequest.getState().tab).toBeNull()
    expect(dialog).not.toHaveBeenCalled()

    await act(async () => openSettingsWindowOr(async () => false, dialog))
    expect(dialog).toHaveBeenCalledTimes(1)
    await act(async () =>
      openSettingsWindowOr(async () => {
        throw new Error("no bridge")
      }, dialog),
    )
    expect(dialog).toHaveBeenCalledTimes(2)
  })

  it("tells the app when its window takes the focus back: the settings window closed", async () => {
    const onReturn = vi.fn()
    vi.spyOn(document, "hasFocus").mockReturnValue(true)
    await act(async () =>
      openSettingsWindowOr(
        async () => true,
        () => undefined,
        onReturn,
      ),
    )
    // A focus before the window took it away is not the return.
    window.dispatchEvent(new Event("focus"))
    expect(onReturn).not.toHaveBeenCalled()
    window.dispatchEvent(new Event("blur"))
    window.dispatchEvent(new Event("focus"))
    window.dispatchEvent(new Event("focus"))
    expect(onReturn).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
  })

  it("fills the window with the tabs; Esc closes it, Shortcuts hands over to the app", () => {
    const onClose = vi.fn()
    const onOpenShortcuts = vi.fn()
    render(
      <TooltipProvider>
        <SettingsWindowPage
          currentApp="viewer"
          showGeneral={false}
          settingsReady
          appSettings={<div data-testid="viewer-tab" />}
          onOpenShortcuts={onOpenShortcuts}
          onClose={onClose}
        />
      </TooltipProvider>,
    )
    expect(document.title).toBe("Settings")
    expect(screen.getByTestId("viewer-tab")).toBeInTheDocument()
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Viewer",
      "Open with",
      "Appearance",
      "Shortcuts",
      "About",
    ])
    fireEvent.click(screen.getByRole("tab", { name: "Shortcuts" }))
    fireEvent.click(screen.getByRole("button", { name: "Open keyboard shortcuts" }))
    expect(onOpenShortcuts).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByTestId("settings-window"), { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
