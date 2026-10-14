import { COMMANDER_TOOLS_KEY, ENTRY_ATTRS, type Crumb } from "@panelyth/contracts"
import { useInterfaceSizeStore } from "@panelyth/ui"
import { act, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetBridgeCache } from "./bridge"
import { AppShell } from "./components/AppShell"
import { resetCarry, startPanels } from "./features/carry"
import { resetListing, useListingStore } from "./features/listing"
import { LAYOUT_KEY, usePanelsStore } from "./features/panels"
import { openSettings, resetSettings, SETTINGS_KEY, useSettingsStore } from "./features/settings"
import { startSettingsRelay } from "./features/settingsRelay"
import { resetTabs, useTabsStore } from "./features/tabs"
import { resetTools, TOOLBAR_KEY, useToolsStore } from "./features/tools"
import { folder, installFakeCommander, item } from "./test/fakeApi"
import { mockViewport } from "./test/viewport"

// ADR-0039: Settings in a native window; what it stores applies to the panels at once.

const ROOT: Crumb = { name: "C:\\", path: "C:\\" }
const HOME: Crumb = { name: "home", path: "C:\\home" }
const home = () =>
  folder(10, HOME.path, [ROOT, HOME], 2, 3, [
    item(10_000_100, "secret", { attrs: ENTRY_ATTRS.hidden }),
  ])

let stops: (() => void)[] = []

async function start() {
  const fake = installFakeCommander({ folders: [home()], home: HOME.path, volumes: [] })
  render(<AppShell />)
  await act(async () => {
    stops = [await startPanels(), startSettingsRelay()]
  })
  return fake
}

const grid = () => screen.getByTestId("grid-left")

beforeEach(() => {
  mockViewport(800, 600)
  resetListing()
  resetCarry()
  resetTabs()
  resetTools()
  resetSettings()
  resetBridgeCache()
  usePanelsStore.setState({ active: "left", split: 50, tree: "off", layoutToken: 0 })
  useInterfaceSizeStore.setState({ size: "medium" })
})
afterEach(() => {
  stops.forEach((s) => s())
  stops = []
  delete window.panelyth
  vi.restoreAllMocks()
})

describe("the settings window (ADR-0039)", () => {
  it("opens Settings in its window, and in the dialog when the window cannot open", async () => {
    const fake = await start()
    fake.api.settings.openWindow.mockResolvedValueOnce({ ok: true, r: { ok: true } })
    await act(async () => openSettings())
    expect(fake.api.settings.openWindow).toHaveBeenCalledWith(undefined)
    expect(useSettingsStore.getState().open).toBe(false)
    // The default fake has no native windows.
    await act(async () => openSettings())
    await waitFor(() => expect(useSettingsStore.getState().open).toBe(true))
  })

  it("applies what the window stored: hidden entries in every panel and tab, tools, the tree", async () => {
    const fake = await start()
    await within(grid()).findByText("secret")
    const split = usePanelsStore.getState().split

    await act(async () =>
      fake.emit("settings.changed", { key: SETTINGS_KEY, value: { v: 3, showHidden: false } }),
    )
    await waitFor(() => expect(within(grid()).queryByText("secret")).toBeNull())
    expect(useSettingsStore.getState().settings.showHidden).toBe(false)
    expect(useListingStore.getState().right.showHidden).toBe(false)
    expect(useTabsStore.getState().left.tabs.every((t) => !t.showHidden)).toBe(true)

    const command = {
      id: "t1",
      title: "Terminal",
      command: "wt",
      params: "",
      dir: "",
      icon: "tool",
      menu: true,
      console: false,
    }
    await act(async () => {
      fake.emit("settings.changed", {
        key: COMMANDER_TOOLS_KEY,
        value: { v: 1, commands: [command] },
      })
      fake.emit("settings.changed", { key: TOOLBAR_KEY, value: { v: 1, items: ["tool:t1"] } })
    })
    expect(useToolsStore.getState().commands).toEqual([command])
    expect(useToolsStore.getState().toolbar).toEqual(["tool:t1"])

    // The tree mode follows; the split stays as it is in this view.
    await act(async () =>
      fake.emit("settings.changed", { key: LAYOUT_KEY, value: { v: 1, split: 30, tree: "one" } }),
    )
    expect(usePanelsStore.getState()).toMatchObject({ tree: "one", split })
  })
})
