import { ChoiceGroup, SharedSettingsDialog, SwitchRow, Tooltip } from "@panelyth/ui"
import { bridge, canSwitchApps } from "../bridge"
import { useLibraryStore } from "../features/library/libraryStore"
import { openShortcutHelp } from "../features/shortcuts/shortcutStore"
import {
  useSettingsStore,
  type StartupFolderMode,
  type WheelMode,
} from "../features/settings/settingsStore"
import { Button } from "./ui/button"

function ViewerSettings() {
  const preferences = useSettingsStore((s) => s.preferences)
  const setPreference = useSettingsStore((s) => s.setPreference)
  const libraryLoaded = useLibraryStore((s) => s.loaded)

  const chooseFolder = async (): Promise<void> => {
    const path = await bridge.openFolderDialog().catch(() => null)
    if (!path) return
    setPreference("specifiedFolder", path)
    setPreference("startupFolder", "specified")
  }

  return (
    <div className="space-y-4" data-testid="viewer-settings">
      {!libraryLoaded && (
        <p
          role="status"
          className="rounded-md border border-border bg-canvas px-3 py-2 text-[0.6875rem] text-muted"
        >
          Settings will be available when the library is ready.
        </p>
      )}
      <section aria-labelledby="startup-folder-label" className="space-y-2">
        <div id="startup-folder-label" className="text-xs font-medium">
          Startup folder
        </div>
        <ChoiceGroup<StartupFolderMode>
          label="Startup folder"
          value={preferences.startupFolder}
          disabled={!libraryLoaded}
          options={[
            { value: "lastUsed", label: "Last used" },
            { value: "specified", label: "Specified" },
            { value: "systemDefault", label: "System default" },
          ]}
          onChange={(value) => setPreference("startupFolder", value)}
        />
        {preferences.startupFolder === "systemDefault" && (
          <p className="text-[0.6875rem] text-muted">System default opens the Home folder.</p>
        )}
        {preferences.startupFolder === "specified" && (
          <div className="flex min-w-0 items-center gap-2 pl-1">
            <Tooltip content={preferences.specifiedFolder ?? undefined}>
              <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-muted">
                {preferences.specifiedFolder ?? "Choose a folder to use at startup"}
              </span>
            </Tooltip>
            <Button size="sm" disabled={!libraryLoaded} onClick={() => void chooseFolder()}>
              Choose folder
            </Button>
          </div>
        )}
      </section>

      <section aria-label="Confirmation and reminders" className="border-t border-border">
        <SwitchRow
          label="Confirm on Escape exit"
          description="Ask before closing Panelyth when no image or video is fullscreen."
          checked={preferences.confirmOnEscapeExit}
          disabled={!libraryLoaded}
          onChange={(value) => setPreference("confirmOnEscapeExit", value)}
        />
        <SwitchRow
          label="Confirm before overwriting files"
          description="Ask before Paste and overwrite replaces existing items."
          checked={preferences.confirmOverwrite}
          disabled={!libraryLoaded}
          onChange={(value) => setPreference("confirmOverwrite", value)}
        />
        <SwitchRow
          label="Remind me to save changes"
          description="Warn before leaving with unsaved image edits when editing is available."
          checked={preferences.remindSaveChanges}
          disabled={!libraryLoaded}
          onChange={(value) => setPreference("remindSaveChanges", value)}
        />
      </section>

      <section aria-label="Tiles" className="border-t border-border">
        <SwitchRow
          label="Show file names under tiles"
          description="Folders always show their name. A hidden name still appears when you point at the tile."
          checked={preferences.showFileNames}
          disabled={!libraryLoaded}
          onChange={(value) => setPreference("showFileNames", value)}
        />
      </section>

      <section
        aria-labelledby="wheel-behavior-label"
        className="space-y-2 border-t border-border pt-3"
      >
        <div id="wheel-behavior-label" className="text-xs font-medium">
          Mouse wheel
        </div>
        <ChoiceGroup<WheelMode>
          label="Mouse wheel behavior"
          value={preferences.wheelMode}
          disabled={!libraryLoaded}
          options={[
            { value: "zoom", label: "Zoom in / out" },
            { value: "previousNext", label: "Previous / next" },
          ]}
          onChange={(value) => setPreference("wheelMode", value)}
        />
        {preferences.wheelMode === "previousNext" && (
          <p className="text-[0.6875rem] text-muted">Ctrl + mouse wheel zooms in or out.</p>
        )}
      </section>
    </div>
  )
}

export function SettingsDialog() {
  const open = useSettingsStore((s) => s.open)
  const closeSettings = useSettingsStore((s) => s.closeSettings)
  const settingsReady = useLibraryStore((s) => s.loaded)

  return (
    <SharedSettingsDialog
      currentApp="viewer"
      open={open}
      onClose={closeSettings}
      showGeneral={canSwitchApps()}
      settingsReady={settingsReady}
      appSettings={<ViewerSettings />}
      onOpenShortcuts={openShortcutHelp}
    />
  )
}
