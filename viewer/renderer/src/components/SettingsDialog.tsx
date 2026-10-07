import { useId, useState, type KeyboardEvent } from "react"
import { setSwitchSettings, useSwitchSettings } from "@fastview/renderer-core"
import { Tooltip } from "@fastview/ui"
import { bridge, canSwitchApps } from "../bridge"
import { useLibraryStore } from "../features/library/libraryStore"
import { openShortcutHelp } from "../features/shortcuts/shortcutStore"
import {
  useSettingsStore,
  type StartupFolderMode,
  type WheelMode,
} from "../features/settings/settingsStore"
import { THEME_OPTIONS, useThemeStore } from "../features/theme/themeStore"
import { useInterfaceSizeStore, type InterfaceSize } from "../features/theme/interfaceSizeStore"
import { Button } from "./ui/button"
import { DialogWindow } from "./ui/dialog"

type SettingsTab = "general" | "viewer" | "appearance" | "shortcuts"

const ALL_TABS: readonly { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "viewer", label: "Viewer" },
  { id: "appearance", label: "Appearance" },
  { id: "shortcuts", label: "Shortcuts" },
]

/** General holds the app-switch settings, so it exists only while the commander is enabled. */
const tabs = (): readonly { id: SettingsTab; label: string }[] =>
  canSwitchApps() ? ALL_TABS : ALL_TABS.filter((t) => t.id !== "general")

const tabButton =
  "h-8 rounded-md px-3 text-xs text-muted hover:bg-raised hover:text-text aria-selected:bg-raised aria-selected:text-text aria-selected:shadow-sm"
const choiceButton =
  "h-8 flex-1 rounded-md border border-border px-2 text-xs text-muted hover:border-muted hover:text-text aria-pressed:border-accent aria-pressed:text-accent disabled:opacity-50"

function SwitchRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  disabled: boolean
  onChange(value: boolean): void
}) {
  const id = useId()
  return (
    <div className="flex items-center gap-4 border-b border-border py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div id={`${id}-label`} className="text-xs font-medium">
          {label}
        </div>
        <div id={`${id}-description`} className="mt-0.5 text-[0.6875rem] text-muted">
          {description}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-description`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="relative h-5 w-9 shrink-0 rounded-full bg-border transition-colors aria-checked:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          aria-hidden="true"
          className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-raised shadow-sm transition-transform ${checked ? "translate-x-4" : ""}`}
        />
      </button>
    </div>
  )
}

function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
  layout = "row",
}: {
  label: string
  value: T
  options: readonly { value: T; label: string; title?: string }[]
  disabled: boolean
  onChange(value: T): void
  layout?: "row" | "grid"
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`${layout === "grid" ? "grid grid-cols-4" : "flex"} gap-1 rounded-lg border border-border bg-canvas p-1`}
    >
      {options.map((option) => (
        <Tooltip key={option.value} content={option.title}>
          <button
            type="button"
            aria-pressed={value === option.value}
            aria-label={option.title ?? option.label}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={choiceButton}
          >
            {option.label}
          </button>
        </Tooltip>
      ))}
    </div>
  )
}

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
          description="Ask before closing FastView when no image or video is fullscreen."
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

function AppearanceSettings() {
  const preference = useThemeStore((s) => s.preference)
  const setPreference = useThemeStore((s) => s.setPreference)
  const interfaceSize = useInterfaceSizeStore((s) => s.size)
  const setInterfaceSize = useInterfaceSizeStore((s) => s.setSize)
  return (
    <div className="space-y-4" aria-label="Appearance">
      <section className="space-y-2">
        <h3 className="text-xs font-medium">Theme</h3>
        <ChoiceGroup
          label="Color theme"
          value={preference}
          disabled={false}
          options={THEME_OPTIONS}
          onChange={setPreference}
          layout="grid"
        />
        <p className="text-[0.6875rem] text-muted">
          System follows your operating system's light or dark setting.
        </p>
      </section>
      <section className="space-y-2 border-t border-border pt-3">
        <h3 className="text-xs font-medium">Font and spacing</h3>
        <ChoiceGroup<InterfaceSize>
          label="Font and spacing size"
          value={interfaceSize}
          disabled={false}
          options={[
            { value: "small", label: "S", title: "Small" },
            { value: "medium", label: "M", title: "Medium" },
            { value: "large", label: "L", title: "Large" },
          ]}
          onChange={setInterfaceSize}
        />
        <p className="text-[0.6875rem] text-muted">Adjusts interface text, padding, and spacing.</p>
      </section>
    </div>
  )
}

function ShortcutsSettings() {
  const closeSettings = useSettingsStore((s) => s.closeSettings)
  return (
    <section className="space-y-3 text-xs">
      <p className="text-muted">
        Review and customize the keys used for navigation, file actions, and the viewer.
      </p>
      <Button
        variant="primary"
        onClick={() => {
          closeSettings()
          openShortcutHelp()
        }}
      >
        Open keyboard shortcuts
      </Button>
    </section>
  )
}

/** Settings → General: the app switch (docs/shared/APP-SWITCHING.md), shared with the commander. */
function GeneralSettings() {
  const carry = useSwitchSettings((s) => s.carry)
  const startWith = useSwitchSettings((s) => s.startWith)
  const libraryLoaded = useLibraryStore((s) => s.loaded)
  const setCarry = (part: keyof typeof carry, value: boolean): void =>
    setSwitchSettings({ carry: { ...carry, [part]: value } })
  return (
    <section aria-label="Switching apps" data-testid="settings-general">
      <h3 className="pb-1 text-[0.6875rem] font-medium text-muted">
        When switching apps, carry over
      </h3>
      <SwitchRow
        label="The folder"
        description="The other app opens the folder you are in."
        checked={carry.folder}
        disabled={!libraryLoaded}
        onChange={(v) => setCarry("folder", v)}
      />
      <SwitchRow
        label="The entry under the cursor"
        description="The cursor or the selected tile lands on the same file."
        checked={carry.focus}
        disabled={!libraryLoaded}
        onChange={(v) => setCarry("focus", v)}
      />
      <SwitchRow
        label="The selection"
        description="Marked files stay selected, up to 10,000; files the viewer doesn't show are left out."
        checked={carry.selection}
        disabled={!libraryLoaded}
        onChange={(v) => setCarry("selection", v)}
      />
      <h3 className="pt-4 pb-2 text-[0.6875rem] font-medium text-muted">Start with</h3>
      <ChoiceGroup
        label="Start with"
        value={startWith}
        options={[
          { value: "last", label: "Last used app" },
          { value: "viewer", label: "Viewer" },
          { value: "commander", label: "Commander" },
        ]}
        disabled={!libraryLoaded}
        onChange={(value) => setSwitchSettings({ startWith: value })}
      />
    </section>
  )
}

export function SettingsDialog() {
  const open = useSettingsStore((s) => s.open)
  const closeSettings = useSettingsStore((s) => s.closeSettings)
  const [tab, setTab] = useState<SettingsTab>("viewer")
  const TABS = tabs()

  const selectAdjacentTab = (e: KeyboardEvent<HTMLDivElement>): void => {
    const index = TABS.findIndex((item) => item.id === tab)
    let next: number
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length
    else if (e.key === "ArrowLeft") next = (index + TABS.length - 1) % TABS.length
    else if (e.key === "Home") next = 0
    else if (e.key === "End") next = TABS.length - 1
    else return
    e.preventDefault()
    const selected = TABS[next]
    if (!selected) return
    setTab(selected.id)
    requestAnimationFrame(() => document.getElementById(`settings-tab-${selected.id}`)?.focus())
  }

  return (
    <DialogWindow
      open={open}
      onOpenChange={(next) => !next && closeSettings()}
      title="Settings"
      contentClassName="w-[min(38rem,calc(100vw-2rem))]"
    >
      <div className="-mx-4 -mt-4">
        <div
          role="tablist"
          aria-label="Settings sections"
          onKeyDown={selectAdjacentTab}
          className="flex gap-1 border-b border-border px-3 py-2"
        >
          {TABS.map((item) => (
            <button
              key={item.id}
              id={`settings-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls="settings-tabpanel"
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => setTab(item.id)}
              className={tabButton}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div
          id="settings-tabpanel"
          role="tabpanel"
          aria-labelledby={`settings-tab-${tab}`}
          tabIndex={0}
          className="max-h-[65vh] overflow-y-auto p-4 outline-none"
        >
          {tab === "general" && <GeneralSettings />}
          {tab === "viewer" && <ViewerSettings />}
          {tab === "appearance" && <AppearanceSettings />}
          {tab === "shortcuts" && <ShortcutsSettings />}
        </div>
      </div>
    </DialogWindow>
  )
}
