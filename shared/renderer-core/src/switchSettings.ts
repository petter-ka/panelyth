import {
  DEFAULT_SWITCH_SETTINGS,
  readSwitchSettings,
  SHARED_SWITCH_KEY,
  type SharedSwitchSettings,
} from "@fastview/contracts"
import { create } from "zustand"

/**
 * Settings → General of the app switch (`shared.switch`, ADR-0031): what
 * carries over and which app starts. Both apps read it; a change in one
 * reaches the other through the settings.changed event.
 */
export const useSwitchSettings = create<SharedSwitchSettings>(() => DEFAULT_SWITCH_SETTINGS)

export interface SwitchSettingsPort {
  loadSettings(): Promise<Record<string, unknown>>
  saveSetting(key: string, value: unknown): void
  onSettingChanged(listener: (key: string, value: unknown) => void): () => void
}

let save: ((value: SharedSwitchSettings) => void) | null = null

/** Loads shared.switch and follows changes made by the other app. */
export function startSwitchSettingsSync(port: SwitchSettingsPort): () => void {
  save = (value) => port.saveSetting(SHARED_SWITCH_KEY, value)
  void port
    .loadSettings()
    .then((settings) => useSwitchSettings.setState(readSwitchSettings(settings[SHARED_SWITCH_KEY])))
    .catch(() => undefined)
  return port.onSettingChanged((key, value) => {
    if (key === SHARED_SWITCH_KEY) useSwitchSettings.setState(readSwitchSettings(value))
  })
}

/** Changes and persists the switch settings (the other app follows). */
export function setSwitchSettings(patch: Partial<Omit<SharedSwitchSettings, "v">>): void {
  const next = { ...useSwitchSettings.getState(), ...patch, v: 1 as const }
  useSwitchSettings.setState(next)
  save?.(next)
}
