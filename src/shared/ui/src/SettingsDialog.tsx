import {
  setAutoUpdateCheck,
  setSwitchSettings,
  useAboutStore,
  useSwitchSettings,
} from "@panelyth/renderer-core"
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react"
import { LOCALES, LOCALE_NAMES, t, type Locale, useLocaleStore } from "@panelyth/i18n"
import {
  ICON_SET_OPTIONS,
  setLanguage,
  THEME_OPTIONS,
  useIconSetStore,
  useInterfaceSizeStore,
  useThemeStore,
} from "./appearance"
import {
  AboutPanel,
  requestSettingsTab,
  useSettingsTabRequest,
  type SettingsTab,
} from "./AboutPanel"
import { Button } from "./button"
import { DialogWindow } from "./dialog"
import { fieldClass } from "./field"
import { SwitchRow } from "./SwitchRow"
import { Tooltip } from "./Tooltip"

export { SwitchRow }

type AppId = "viewer" | "commander"

const tabButton =
  "h-8 rounded-md px-3 text-xs text-muted hover:bg-raised hover:text-text aria-selected:bg-raised aria-selected:text-text aria-selected:shadow-sm"
// A segmented control: the chosen segment is the filled one (the tile size
// control in the viewer's toolbar has the same look).
const choiceButton =
  "h-7 min-w-0 flex-auto truncate rounded-[5px] border border-transparent px-2 text-xs font-medium text-muted hover:text-text aria-pressed:border-border aria-pressed:bg-raised aria-pressed:font-semibold aria-pressed:text-text aria-pressed:shadow-sm disabled:opacity-50"

export function ChoiceGroup<T extends string>({
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
      className={`${layout === "grid" ? "grid grid-cols-4" : "flex"} gap-0.5 rounded-lg border border-border bg-canvas p-0.5`}
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

function GeneralSettings({ settingsReady }: { settingsReady: boolean }) {
  const carry = useSwitchSettings((s) => s.carry)
  const startWith = useSwitchSettings((s) => s.startWith)
  const setCarry = (part: keyof typeof carry, value: boolean): void =>
    setSwitchSettings({ carry: { ...carry, [part]: value } })

  return (
    <section aria-label={t("Switching apps")} data-testid="settings-general">
      <h3 className="pb-1 text-2xs font-medium text-muted">
        {t("When switching apps, carry over")}
      </h3>
      <SwitchRow
        label={t("The folder")}
        description={t("The other app opens the folder you are in.")}
        checked={carry.folder}
        disabled={!settingsReady}
        onChange={(value) => setCarry("folder", value)}
      />
      <SwitchRow
        label={t("The entry under the cursor")}
        description={t("The cursor or the selected tile lands on the same file.")}
        checked={carry.focus}
        disabled={!settingsReady}
        onChange={(value) => setCarry("focus", value)}
      />
      <SwitchRow
        label={t("The selection")}
        description={t(
          "Marked files stay selected, up to 10,000; files the viewer doesn't show are left out.",
        )}
        checked={carry.selection}
        disabled={!settingsReady}
        onChange={(value) => setCarry("selection", value)}
      />
      <h3 className="pt-4 pb-2 text-2xs font-medium text-muted">{t("Start with")}</h3>
      <ChoiceGroup
        label={t("Start with")}
        value={startWith}
        options={[
          { value: "last", label: t("Last used app") },
          { value: "viewer", label: "Viewer" },
          { value: "commander", label: "Commander" },
        ]}
        disabled={!settingsReady}
        onChange={(value) => setSwitchSettings({ startWith: value })}
      />
    </section>
  )
}

function AppearanceSettings() {
  const preference = useThemeStore((s) => s.preference)
  const setPreference = useThemeStore((s) => s.setPreference)
  const interfaceSize = useInterfaceSizeStore((s) => s.size)
  const setInterfaceSize = useInterfaceSizeStore((s) => s.setSize)
  const iconSet = useIconSetStore((s) => s.iconSet)
  const setIconSet = useIconSetStore((s) => s.setIconSet)
  const language = useLocaleStore((s) => s.locale)
  return (
    <div className="space-y-4" aria-label={t("Appearance")}>
      <section className="space-y-2">
        <h3 className="text-xs font-medium">{t("Theme")}</h3>
        <ChoiceGroup
          label={t("Color theme")}
          value={preference}
          disabled={false}
          options={THEME_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
          onChange={setPreference}
          layout="grid"
        />
        <p className="text-2xs text-muted">
          {t("System follows your operating system's light or dark setting.")}
        </p>
      </section>
      <section className="space-y-2 border-t border-border pt-3">
        <h3 className="text-xs font-medium">{t("Font and spacing")}</h3>
        <ChoiceGroup
          label={t("Font and spacing size")}
          value={interfaceSize}
          disabled={false}
          options={[
            { value: "small", label: t("S"), title: t("Small") },
            { value: "medium", label: t("M"), title: t("Medium") },
            { value: "large", label: t("L"), title: t("Large") },
          ]}
          onChange={setInterfaceSize}
        />
        <p className="text-2xs text-muted">{t("Adjusts interface text, padding, and spacing.")}</p>
      </section>
      <section className="space-y-2 border-t border-border pt-3">
        <h3 className="text-xs font-medium">{t("Icon library")}</h3>
        <ChoiceGroup
          label={t("Icon library")}
          value={iconSet}
          disabled={false}
          options={ICON_SET_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
          onChange={setIconSet}
        />
        <p className="text-2xs text-muted">
          {t("Applies to the toolbar and menu icons in the viewer and the commander.")}
        </p>
      </section>
      <section className="space-y-2 border-t border-border pt-3">
        <h3 className="text-xs font-medium">{t("Language")}</h3>
        <select
          aria-label={t("Interface language")}
          value={language}
          onChange={(e) => void setLanguage(e.target.value as Locale)}
          className={fieldClass}
        >
          {LOCALES.map((locale) => (
            <option key={locale} value={locale}>
              {LOCALE_NAMES[locale]}
            </option>
          ))}
        </select>
      </section>
    </div>
  )
}

interface SharedSettingsDialogProps {
  currentApp: AppId
  open: boolean
  onClose(): void
  showGeneral: boolean
  settingsReady: boolean
  appSettings: ReactNode
  onOpenShortcuts(): void
}

export function SharedSettingsDialog(props: SharedSettingsDialogProps) {
  const { open } = props
  // A tab asked for from the native menu lasts for one opening of the dialog.
  useEffect(() => {
    if (!open) requestSettingsTab(null)
  }, [open])
  return <SharedSettingsDialogContent key={`${props.currentApp}:${props.open}`} {...props} />
}

function SharedSettingsDialogContent({
  currentApp,
  open,
  onClose,
  showGeneral,
  settingsReady,
  appSettings,
  onOpenShortcuts,
}: SharedSettingsDialogProps) {
  // The tab the user chose, unless the native menu asked for another one since.
  const request = useSettingsTabRequest()
  const [chosen, setChosen] = useState<{ tab: SettingsTab; seq: number } | null>(null)
  const tab: SettingsTab =
    chosen && chosen.seq === request.seq ? chosen.tab : (request.tab ?? currentApp)
  const setTab = (next: SettingsTab): void => setChosen({ tab: next, seq: request.seq })
  const appLabel = currentApp === "viewer" ? "Viewer" : "Commander"
  const tabs: readonly { id: SettingsTab; label: string }[] = [
    ...(showGeneral ? [{ id: "general" as const, label: t("General") }] : []),
    { id: currentApp, label: appLabel },
    { id: "appearance", label: t("Appearance") },
    { id: "shortcuts", label: t("Shortcuts") },
    { id: "about", label: t("About") },
  ]

  const autoUpdate = useAboutStore((s) => s.update?.auto ?? true)

  const selectAdjacentTab = (e: KeyboardEvent<HTMLDivElement>): void => {
    const index = tabs.findIndex((item) => item.id === tab)
    let next: number
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length
    else if (e.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length
    else if (e.key === "Home") next = 0
    else if (e.key === "End") next = tabs.length - 1
    else return
    e.preventDefault()
    const selected = tabs[next]
    if (!selected) return
    setTab(selected.id)
    requestAnimationFrame(() => document.getElementById(`settings-tab-${selected.id}`)?.focus())
  }

  return (
    <DialogWindow
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t("Settings")}
      contentClassName="w-[min(38rem,calc(100vw-2rem))]"
    >
      <div className="-mx-4 -mt-4">
        <div
          role="tablist"
          aria-label={t("Settings sections")}
          onKeyDown={selectAdjacentTab}
          className="flex gap-1 border-b border-border px-3 py-2"
        >
          {tabs.map((item) => (
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
          {tab === "general" && showGeneral && <GeneralSettings settingsReady={settingsReady} />}
          {tab === currentApp && appSettings}
          {tab === "appearance" && <AppearanceSettings />}
          {tab === "shortcuts" && (
            <section className="space-y-3 text-xs">
              <p className="text-muted">
                {t(
                  "Review and customize the keys used for navigation, file actions, and the viewer.",
                )}
              </p>
              <Button
                variant="primary"
                onClick={() => {
                  onClose()
                  onOpenShortcuts()
                }}
              >
                {t("Open keyboard shortcuts")}
              </Button>
            </section>
          )}
          {tab === "about" && (
            <AboutPanel
              autoSwitch={
                <SwitchRow
                  label={t("Check automatically")}
                  description={t(
                    "Looks for a newer version at start and every few hours. Nothing is downloaded until you ask.",
                  )}
                  checked={autoUpdate}
                  disabled={!settingsReady}
                  onChange={setAutoUpdateCheck}
                />
              }
            />
          )}
        </div>
      </div>
    </DialogWindow>
  )
}
