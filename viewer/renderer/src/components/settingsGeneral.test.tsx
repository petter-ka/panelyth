import { DEFAULT_SWITCH_SETTINGS, SHARED_SWITCH_KEY } from "@panelyth/contracts"
import { startSwitchSettingsSync, useSwitchSettings } from "@panelyth/renderer-core"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useLibraryStore } from "../features/library/libraryStore"
import { useSettingsStore } from "../features/settings/settingsStore"
import { installFakeBridge } from "../test/fakeBridge"
import { SettingsDialog } from "./SettingsDialog"

// Settings → General (Stage C02): the app-switch options shared with the commander.

let stop: (() => void) | null = null

function setup(commanderEnabled: boolean) {
  const bridge = installFakeBridge()
  if (commanderEnabled) {
    ;(window.panelyth!.app as unknown as { switch: () => void }).switch = vi.fn()
  }
  const save = vi.fn()
  stop = startSwitchSettingsSync({
    loadSettings: async () => ({}),
    saveSetting: save,
    onSettingChanged: () => () => undefined,
  })
  useLibraryStore.setState({ loaded: true })
  useSettingsStore.setState({ open: true })
  render(<SettingsDialog />)
  return { bridge, save }
}

beforeEach(() => useSwitchSettings.setState(DEFAULT_SWITCH_SETTINGS))
afterEach(() => {
  stop?.()
  useSettingsStore.setState({ open: false })
})

describe("Settings → General", () => {
  it("is there only while the commander is enabled", () => {
    setup(false)
    expect(screen.queryByRole("tab", { name: "General" })).not.toBeInTheDocument()
  })

  it("switches each carry-over part and the start app, shared through shared.switch", async () => {
    const { save } = setup(true)
    await act(async () => {}) // the stored settings load first
    fireEvent.click(screen.getByRole("tab", { name: "General" }))
    const selection = screen.getByRole("switch", { name: "The selection" })
    expect(selection).toHaveAttribute("aria-checked", "true")
    await act(async () => fireEvent.click(selection))
    expect(useSwitchSettings.getState().carry).toEqual({
      folder: true,
      focus: true,
      selection: false,
    })
    expect(save).toHaveBeenLastCalledWith(
      SHARED_SWITCH_KEY,
      expect.objectContaining({ carry: { folder: true, focus: true, selection: false } }),
    )
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Commander" })))
    await waitFor(() => expect(useSwitchSettings.getState().startWith).toBe("commander"))
  })
})
