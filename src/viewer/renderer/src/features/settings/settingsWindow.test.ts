import { act, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { installFakeBridge } from "../../test/fakeBridge"
import {
  EDITOR_SETTINGS_KEY,
  startEditorSettingsPersistence,
  useEditorSettings,
} from "../editor/editorSettings"
import {
  closeSettings,
  openSettings,
  startViewerSettingsPersistence,
  useSettingsStore,
  VIEWER_SETTINGS_KEY,
} from "./settingsStore"

// ADR-0039: Settings in a native window; what it stores applies to the viewer at once.

let stops: (() => void)[] = []
afterEach(() => {
  stops.forEach((s) => s())
  stops = []
  closeSettings()
})

describe("the viewer's settings window", () => {
  it("opens Settings in its window, and in the dialog when the window cannot open", async () => {
    const bridge = installFakeBridge()
    bridge.api.settings.openWindow.mockResolvedValueOnce({ ok: true, r: { ok: true } })
    await act(async () => openSettings())
    expect(bridge.api.settings.openWindow).toHaveBeenCalledTimes(1)
    expect(useSettingsStore.getState().open).toBe(false)
    await act(async () => openSettings())
    await waitFor(() => expect(useSettingsStore.getState().open).toBe(true))
  })

  it("applies the viewer and editor settings the window stored", () => {
    const bridge = installFakeBridge()
    stops = [startViewerSettingsPersistence(), startEditorSettingsPersistence()]
    act(() =>
      bridge.push("settings.changed", {
        key: VIEWER_SETTINGS_KEY,
        value: { v: 1, wheelMode: "previousNext", showFileNames: false },
      }),
    )
    expect(useSettingsStore.getState().settings).toMatchObject({
      wheelMode: "previousNext",
      showFileNames: false,
    })
    act(() =>
      bridge.push("settings.changed", {
        key: EDITOR_SETTINGS_KEY,
        value: { v: 1, saveTarget: "as", metadata: "strip", jpegQuality: 80, surround: "black" },
      }),
    )
    expect(useEditorSettings.getState().settings).toMatchObject({
      saveTarget: "as",
      surround: "black",
    })
  })
})
