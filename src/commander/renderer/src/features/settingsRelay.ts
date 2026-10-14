import { COMMANDER_TOOLS_KEY } from "@panelyth/contracts"
import { bridge, isBridgeAvailable } from "../bridge"
import { applyLayoutSetting, LAYOUT_KEY } from "./panels"
import { applyStoredSettings, SETTINGS_KEY, useSettingsStore } from "./settings"
import { showHiddenEverywhere } from "./tabs"
import { applyToolsSetting, TOOLBAR_KEY } from "./tools"

/**
 * What the settings window stores applies here at once (ADR-0039): main relays
 * the window's writes to this view only. Its own writes never come back.
 */
export function startSettingsRelay(): () => void {
  if (!isBridgeAvailable()) return () => undefined
  return bridge.on("settings.changed", ({ key, value }) => {
    if (key === SETTINGS_KEY) {
      const before = useSettingsStore.getState().settings.showHidden
      applyStoredSettings(value)
      const after = useSettingsStore.getState().settings.showHidden
      // "Show hidden and system files" reaches every panel and tab.
      if (after !== before) showHiddenEverywhere(after)
    } else if (key === COMMANDER_TOOLS_KEY || key === TOOLBAR_KEY) applyToolsSetting(key, value)
    else if (key === LAYOUT_KEY) applyLayoutSetting(value)
  })
}
