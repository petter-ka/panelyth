import { startSharedAppearanceSync } from "@fastview/ui"
import { bridge, canSwitchApps, isBridgeAvailable } from "../../bridge"

/**
 * The connection point to the commander (ADR-0031, docs/shared/APP-SWITCHING.md).
 * The switch exists only while the commander is enabled.
 */
export function switchToCommander(): void {
  if (!canSwitchApps()) return
  void bridge.switchToCommander().catch(() => undefined)
}

/** Theme and interface size are shared with the commander through library.db. */
export function startAppearanceSync(): () => void {
  if (!isBridgeAvailable()) return () => undefined
  return startSharedAppearanceSync({
    loadSettings: () => bridge.library().then((l) => l.settings),
    saveSetting: (key, value) => void bridge.setSetting(key, value).catch(() => undefined),
    onSettingChanged: (listener) => bridge.on("settings.changed", (e) => listener(e.key, e.value)),
  })
}
