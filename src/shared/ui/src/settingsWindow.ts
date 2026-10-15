import { SETTINGS_TABS, type SettingsTab } from "@panelyth/contracts"
import {
  startAboutSync,
  startSwitchSettingsSync,
  type AboutPort,
  type SwitchSettingsPort,
} from "@panelyth/renderer-core"
import { requestSettingsTab, useSettingsTabRequest } from "./AboutPanel"
import { startSharedAppearanceSync, type AppearanceSyncPort } from "./appearance"

/** The section of the app's tab main named in the settings window's URL (`#section=…`). */
export function settingsSectionOf(hash: string): string | null {
  const section = new URLSearchParams(hash.replace(/^#/, "")).get("section")
  return section && /^[a-z]{1,24}$/.test(section) ? section : null
}

/** The tab main named in the settings window's URL (`#tab=…`), if it is one. */
export function settingsTabOf(hash: string): SettingsTab | null {
  const tab = new URLSearchParams(hash.replace(/^#/, "")).get("tab")
  return (SETTINGS_TABS as readonly (string | null)[]).includes(tab) ? (tab as SettingsTab) : null
}

/**
 * What both apps' settings window pages share (ADR-0039): the first tab, and
 * the shared settings (appearance, app switching, updates) kept in step with
 * the app views. The app's own settings load as in the app.
 */
export function startSettingsWindowPage(port: {
  settings: AppearanceSyncPort & SwitchSettingsPort
  about: AboutPort
}): () => void {
  const tab = settingsTabOf(window.location.hash)
  if (tab) requestSettingsTab(tab)
  const offAppearance = startSharedAppearanceSync(port.settings)
  const offSwitch = startSwitchSettingsSync(port.settings)
  // The native menu's items go to the app view, never here.
  const offAbout = startAboutSync(port.about, () => undefined)
  return () => {
    offAppearance()
    offSwitch()
    offAbout()
  }
}

/**
 * Opens Settings in its native window on the tab the native menu asked for,
 * or `openDialog` (the in-page dialog) when the window cannot open (ADR-0039).
 */
export function openSettingsWindowOr(
  openWindow: (tab?: SettingsTab) => Promise<boolean>,
  openDialog: () => void,
  /** The app's window takes input again: the settings window closed (the dialog's close did the same). */
  onReturn?: () => void,
): void {
  const tab = useSettingsTabRequest.getState().tab ?? undefined
  void openWindow(tab).then((opened) => {
    if (!opened) return openDialog()
    // The window took the tab; a later dialog starts on the app's own.
    requestSettingsTab(null)
    if (onReturn) onNextReturn(onReturn)
  }, openDialog)
}

/**
 * The settings window blocks the app's window, which cannot take focus while
 * it is open: the first focus after it took the focus away is its closing.
 */
function onNextReturn(listener: () => void): void {
  const back = (): void => listener()
  if (!document.hasFocus()) window.addEventListener("focus", back, { once: true })
  else {
    window.addEventListener("blur", () => window.addEventListener("focus", back, { once: true }), {
      once: true,
    })
  }
}
