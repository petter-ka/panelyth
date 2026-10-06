import { DialogWindow } from "@fastview/ui"
import type { ReactNode } from "react"
import {
  setSettingsOpen,
  updateSettings,
  useSettingsStore,
  type PanelSettings,
} from "../features/settings"

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

/**
 * The commander's settings (Stage C03: the Panels tab). Changes apply at
 * once and are stored under commander.settings. More tabs arrive with
 * Stage C10; theme and interface size are shared with the viewer.
 */
export function SettingsDialog() {
  const open = useSettingsStore((s) => s.open)
  const showHidden = useSettingsStore((s) => s.settings.showHidden)
  return (
    <DialogWindow open={open} onOpenChange={setSettingsOpen} title="Settings — Panels">
      <Section>
        <Radios
          setting="sizeFormat"
          label="Sizes"
          options={[
            { value: "bytes", label: "Bytes (1,234,567)" },
            { value: "units", label: "Units (1.2 MB)" },
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
      </Section>
    </DialogWindow>
  )
}
