import { SharedSettingsDialog } from "@panelyth/ui"
import { useState, type ReactNode } from "react"
import { setHelpOpen } from "../features/keymap"
import {
  MAX_EDITOR_CHARS,
  setSettingsOpen,
  updateSettings,
  useSettingsStore,
  type PanelSettings,
} from "../features/settings"
import { useSidecarStore } from "../features/sidecar"

interface Choice<K extends keyof PanelSettings> {
  setting: K
  label: string
  options: { value: PanelSettings[K]; label: string }[]
}

function Radios<K extends keyof PanelSettings>({ setting: name, label, options }: Choice<K>) {
  const value = useSettingsStore((s) => s.settings[name])
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-muted">{label}</legend>
      {options.map((o) => (
        <label key={String(o.value)} className="flex items-center gap-2">
          <input
            type="radio"
            name={name}
            checked={value === o.value}
            onChange={() => updateSettings({ [name]: o.value } as Partial<PanelSettings>)}
            className="accent-[var(--color-accent)]"
          />
          {o.label}
        </label>
      ))}
    </fieldset>
  )
}

const Section = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-col gap-4 text-xs">{children}</div>
)

/** F4's editor: saved when the field is left (main reads it from library.db). */
function EditorField() {
  const stored = useSettingsStore((s) => s.settings.editor)
  const [value, setValue] = useState(stored)
  const save = (): void => {
    if (value.trim() !== stored) updateSettings({ editor: value.trim() })
  }
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted">Editor (F4)</span>
      <input
        aria-label="Editor program"
        className="h-8 w-full rounded-md border border-border bg-canvas px-2 text-xs text-text outline-none focus:border-accent"
        value={value}
        maxLength={MAX_EDITOR_CHARS}
        spellCheck={false}
        placeholder="The system's text editor"
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save()
        }}
      />
      <span className="text-[0.6875rem] text-muted">The full path of a program, or empty.</span>
    </label>
  )
}

function CommanderSettings() {
  const showHidden = useSettingsStore((s) => s.settings.showHidden)
  return (
    <Section>
      <Radios
        setting="sizeFormat"
        label="Sizes"
        options={[
          { value: "units", label: "Units (1.5 KB)" },
          { value: "bytes", label: "Bytes (1,234,567)" },
        ]}
      />
      <Radios
        setting="dateFormat"
        label="Dates"
        options={[
          { value: "locale", label: "As the system shows them" },
          { value: "iso", label: "ISO (2026-10-06 14:05)" },
        ]}
      />
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={showHidden}
          onChange={(e) => updateSettings({ showHidden: e.target.checked })}
        />
        Show hidden and system files in new panels
      </label>
      <Radios
        setting="letters"
        label="Typed letters"
        options={[
          { value: "quickSearch", label: "Start quick search" },
          {
            value: "altLetters",
            label: "Start quick search with Alt (letters go to the command line)",
          },
        ]}
      />
      <Radios
        setting="rightButton"
        label="Right mouse button"
        options={[
          { value: "mark", label: "Marks entries (hold for the menu)" },
          { value: "menu", label: "Opens the menu" },
        ]}
      />
      <Radios
        setting="mediaOpen"
        label="Open images and videos with"
        options={[
          { value: "viewer", label: "Panelyth Viewer" },
          { value: "system", label: "System default app" },
        ]}
      />
      <Radios
        setting="documentOpen"
        label="Open PDFs and text files with"
        options={[
          { value: "window", label: "Panelyth document window" },
          { value: "system", label: "System default app" },
        ]}
      />
      <Radios
        setting="runPrograms"
        label="Run programs with Enter"
        options={[
          { value: "ask", label: "Ask first" },
          { value: "always", label: "Always" },
          { value: "never", label: "Never" },
        ]}
      />
      <EditorField />
    </Section>
  )
}

/** Shared settings shell; Commander options appear only in the Commander view. */
export function SettingsDialog() {
  const open = useSettingsStore((s) => s.open)
  const settingsReady = useSidecarStore((s) => s.status?.state === "ready")

  return (
    <SharedSettingsDialog
      currentApp="commander"
      open={open}
      onClose={() => setSettingsOpen(false)}
      showGeneral
      settingsReady={settingsReady}
      appSettings={<CommanderSettings />}
      onOpenShortcuts={() => setHelpOpen(true)}
    />
  )
}
