import { ChoiceGroup, SharedSettingsDialog, SwitchRow, Tooltip } from "@panelyth/ui"
import { bridge, canSwitchApps } from "../bridge"
import { useLibraryStore } from "../features/library/libraryStore"
import { openShortcutHelp } from "../features/shortcuts/shortcutStore"
import {
  closeSettings,
  setPreference,
  useSettingsStore,
  type StartupFolderMode,
  type WheelMode,
} from "../features/settings/settingsStore"
import { Button } from "./ui/button"
import { SURROUNDS, useEditorSettings, type Surround } from "../features/editor/editorSettings"
import { MAX_JPEG_QUALITY, MIN_JPEG_QUALITY } from "@panelyth/contracts"
import type { MetadataPolicy, SaveTarget } from "@panelyth/contracts"
import { t } from "@panelyth/i18n"

function surroundLabel(s: Surround): string {
  switch (s) {
    case "gray":
      return t("Gray")
    case "black":
      return t("Black")
    case "white":
      return t("White")
    case "theme":
      return t("Theme")
  }
}

/** Settings → Editor (Stage 12): what a save defaults to, and the canvas surround. */
function EditorSettings({ disabled }: { disabled: boolean }) {
  const settings = useEditorSettings((s) => s.settings)
  const set = useEditorSettings((s) => s.set)
  return (
    <section
      aria-labelledby="editor-settings-label"
      className="space-y-2 border-t border-border pt-3"
      data-testid="editor-settings"
    >
      <div id="editor-settings-label" className="text-xs font-medium">
        {t("Image editor")}
      </div>
      <div className="text-2xs text-muted">{t("The Save button")}</div>
      <ChoiceGroup<SaveTarget>
        label={t("The Save button")}
        value={settings.saveTarget}
        disabled={disabled}
        options={[
          { value: "copy", label: t("Save a copy") },
          { value: "as", label: t("Save as…") },
          { value: "replace", label: t("Replace original") },
        ]}
        onChange={(value) => set("saveTarget", value)}
      />
      {settings.saveTarget === "replace" && (
        <p className="text-2xs text-muted">
          {t("The original goes to the trash first, and Panelyth asks every time.")}
        </p>
      )}
      <div className="text-2xs text-muted">{t("Camera data (EXIF)")}</div>
      <ChoiceGroup<MetadataPolicy>
        label={t("Camera data (EXIF)")}
        value={settings.metadata}
        disabled={disabled}
        options={[
          { value: "keep", label: t("Keep") },
          { value: "stripGps", label: t("Remove location only") },
          { value: "strip", label: t("Remove all") },
        ]}
        onChange={(value) => set("metadata", value)}
      />
      <label className="flex items-center gap-3 text-2xs text-muted">
        <span className="min-w-0 flex-1">{t("JPEG quality")}</span>
        <input
          type="range"
          min={MIN_JPEG_QUALITY}
          max={MAX_JPEG_QUALITY}
          value={settings.jpegQuality}
          disabled={disabled}
          aria-label={t("JPEG quality")}
          onChange={(e) => set("jpegQuality", Number(e.target.value))}
          className="editor-range h-4 w-40"
        />
        <span className="w-7 text-right text-xs text-text tabular-nums">
          {settings.jpegQuality}
        </span>
      </label>
      <div className="text-2xs text-muted">{t("Around the picture")}</div>
      <ChoiceGroup<Surround>
        label={t("Around the picture")}
        value={settings.surround}
        disabled={disabled}
        options={SURROUNDS.map((value) => ({ value, label: surroundLabel(value) }))}
        onChange={(value) => set("surround", value)}
      />
      <p className="text-2xs text-muted">
        {t("Neutral gray lets you judge colors the same way in both themes.")}
      </p>
    </section>
  )
}

function ViewerSettings() {
  const preferences = useSettingsStore((s) => s.settings)
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
          className="rounded-md border border-border bg-canvas px-3 py-2 text-2xs text-muted"
        >
          {t("Settings will be available when the library is ready.")}
        </p>
      )}
      <section aria-labelledby="startup-folder-label" className="space-y-2">
        <div id="startup-folder-label" className="text-xs font-medium">
          {t("Startup folder")}
        </div>
        <ChoiceGroup<StartupFolderMode>
          label={t("Startup folder")}
          value={preferences.startupFolder}
          disabled={!libraryLoaded}
          options={[
            { value: "lastUsed", label: t("Last used") },
            { value: "specified", label: t("Specified") },
            { value: "systemDefault", label: t("System default") },
          ]}
          onChange={(value) => setPreference("startupFolder", value)}
        />
        {preferences.startupFolder === "systemDefault" && (
          <p className="text-2xs text-muted">{t("System default opens the Home folder.")}</p>
        )}
        {preferences.startupFolder === "specified" && (
          <div className="flex min-w-0 items-center gap-2 pl-1">
            <Tooltip content={preferences.specifiedFolder ?? undefined}>
              <span className="min-w-0 flex-1 truncate text-2xs text-muted">
                {preferences.specifiedFolder ?? t("Choose a folder to use at startup")}
              </span>
            </Tooltip>
            <Button size="sm" disabled={!libraryLoaded} onClick={() => void chooseFolder()}>
              {t("Choose folder")}
            </Button>
          </div>
        )}
      </section>

      <section aria-label={t("Confirmation and reminders")} className="border-t border-border">
        <SwitchRow
          label={t("Confirm on Escape exit")}
          description={t("Ask before closing Panelyth when no image or video is fullscreen.")}
          checked={preferences.confirmOnEscapeExit}
          disabled={!libraryLoaded}
          onChange={(value) => setPreference("confirmOnEscapeExit", value)}
        />
        <SwitchRow
          label={t("Confirm before overwriting files")}
          description={t("Ask before Paste and overwrite replaces existing items.")}
          checked={preferences.confirmOverwrite}
          disabled={!libraryLoaded}
          onChange={(value) => setPreference("confirmOverwrite", value)}
        />
        <SwitchRow
          label={t("Remind me to save changes")}
          description={t("Ask before closing the image editor with unsaved changes.")}
          checked={preferences.remindSaveChanges}
          disabled={!libraryLoaded}
          onChange={(value) => setPreference("remindSaveChanges", value)}
        />
      </section>

      <section aria-label={t("Tiles")} className="border-t border-border">
        <SwitchRow
          label={t("Show file names under tiles")}
          description={t(
            "Folders always show their name. A hidden name still appears when you point at the tile.",
          )}
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
          {t("Mouse wheel")}
        </div>
        <ChoiceGroup<WheelMode>
          label={t("Mouse wheel behavior")}
          value={preferences.wheelMode}
          disabled={!libraryLoaded}
          options={[
            { value: "zoom", label: t("Zoom in / out") },
            { value: "previousNext", label: t("Previous / next") },
          ]}
          onChange={(value) => setPreference("wheelMode", value)}
        />
        {preferences.wheelMode === "previousNext" && (
          <p className="text-2xs text-muted">{t("Ctrl + mouse wheel zooms in or out.")}</p>
        )}
      </section>
      <EditorSettings disabled={!libraryLoaded} />
    </div>
  )
}

export function SettingsDialog() {
  const open = useSettingsStore((s) => s.open)
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
