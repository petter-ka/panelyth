import { TitleBar } from "./TitleBar"
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
  STYLE_OPTIONS,
  TERMINAL_THEME_LABELS,
  THEME_GROUPS,
  themeOfSystem,
  useIconSetStore,
  useInterfaceSizeStore,
  useStyleStore,
  useThemeStore,
} from "./appearance"
import {
  AboutPanel,
  requestSettingsTab,
  useSettingsTabRequest,
  type SettingsTab,
} from "./AboutPanel"
import { Button } from "./button"
import { ProgramsSettings } from "./ProgramsSettings"
import { DialogWindow } from "./dialog"
import { fieldClass } from "./field"
import { SwitchRow } from "./SwitchRow"
import { Tooltip } from "./Tooltip"

export { SwitchRow }

type AppId = "viewer" | "commander" | "system"

const tabButton =
  "glass-pill h-8 rounded-md px-3 text-xs text-muted hover:bg-raised hover:text-text aria-selected:bg-raised aria-selected:text-text aria-selected:shadow-sm"
// A segmented control: the chosen segment is the filled one (the tile size
// control in the viewer's toolbar has the same look).
const choiceButton =
  "glass-pill h-7 min-w-0 flex-auto truncate rounded-[5px] border border-transparent px-2 text-xs font-medium text-muted hover:text-text aria-pressed:border-border aria-pressed:bg-raised aria-pressed:font-semibold aria-pressed:text-text aria-pressed:shadow-sm disabled:opacity-50"

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
      className={`${layout === "grid" ? "grid grid-cols-4" : "glass-pill flex"} gap-0.5 rounded-lg border border-border bg-canvas p-0.5`}
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
  const style = useStyleStore((s) => s.style)
  const setStyle = useStyleStore((s) => s.setStyle)
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
        <h3 className="text-xs font-medium">{t("Style")}</h3>
        <ChoiceGroup
          label={t("Design style")}
          value={style}
          disabled={false}
          options={STYLE_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
          onChange={setStyle}
        />
        <p className="text-2xs text-muted">
          {style === "glass"
            ? t("Translucent panels float over a soft background drawn from the theme's colors.")
            : style === "terminal"
              ? t(
                  "A field operative's console: framed panels, monospaced type and the theme's signal color.",
                )
              : t("Flat, neutral panels: the original Panelyth design.")}
        </p>
      </section>
      <section className="space-y-2 border-t border-border pt-3">
        <h3 className="text-xs font-medium">{t("Theme")}</h3>
        <div role="group" aria-label={t("Color theme")} className="space-y-3">
          <div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={preference === "system"}
                // Unticked: the theme the system shows now, so the screen does not change.
                onChange={(e) => setPreference(e.target.checked ? "system" : themeOfSystem())}
              />
              {t("System")}
            </label>
            <p className="pt-0.5 text-2xs text-muted">
              {t("System follows your operating system's light or dark setting.")}
            </p>
          </div>
          {/* While System is ticked no theme of either group is chosen. */}
          {THEME_GROUPS.map((group) => (
            <div key={group.label} className="space-y-1.5">
              <h4 className="text-2xs font-medium text-muted">{t(group.label)}</h4>
              <ChoiceGroup
                label={t(group.label)}
                value={preference}
                disabled={false}
                options={group.themes.map((o) => ({
                  ...o,
                  label: t(
                    style === "terminal" && o.value !== "system"
                      ? TERMINAL_THEME_LABELS[o.value]
                      : o.label,
                  ),
                }))}
                onChange={setPreference}
              />
            </div>
          ))}
        </div>
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
            { value: "xlarge", label: t("XL"), title: t("Extra large") },
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

interface SettingsContentProps {
  currentApp: AppId
  showGeneral: boolean
  settingsReady: boolean
  appSettings: ReactNode
  /** Settings → Appearance → Full screen (from the media package, which this one cannot import). */
  fullScreenSettings?: ReactNode
  /** The Shortcuts tab's button: Settings goes away and the app's shortcuts dialog opens. */
  onOpenShortcuts(): void
}

interface SharedSettingsDialogProps extends SettingsContentProps {
  open: boolean
  onClose(): void
}

/**
 * The in-page Settings dialog: used when the settings window cannot open
 * (ADR-0039), as in component tests.
 */
export function SharedSettingsDialog(props: SharedSettingsDialogProps) {
  const { open, onClose, onOpenShortcuts, ...content } = props
  // A tab asked for from the native menu lasts for one opening of the dialog.
  useEffect(() => {
    if (!open) requestSettingsTab(null)
  }, [open])
  return (
    <DialogWindow
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t("Settings")}
      contentClassName="w-[min(38rem,calc(100vw-2rem))]"
    >
      <div className="-mx-4 -mt-4">
        <SettingsTabs
          key={`${props.currentApp}:${open}`}
          {...content}
          onOpenShortcuts={() => {
            onClose()
            onOpenShortcuts()
          }}
          panelClassName="max-h-[65vh]"
        />
      </div>
    </DialogWindow>
  )
}

/**
 * Settings as the page of its native window (ADR-0039): the same tabs filling
 * the window. Esc closes it, as it closed the dialog.
 */
export function SettingsWindowPage({
  onClose,
  ...content
}: SettingsContentProps & { onClose(): void }) {
  useEffect(() => {
    document.title = t("Settings")
  })
  // Esc closes the window wherever the focus is, as it closed the dialog;
  // a menu or field that handles Esc itself keeps it.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  return (
    <div
      className="glass-page flex h-full min-h-0 flex-col bg-chrome text-text"
      data-testid="settings-window"
    >
      {/* Windows: the window's own strip, with Close only (ADR-0045). */}
      <TitleBar title={t("Settings")} rail={false} mark />
      <SettingsTabs {...content} panelClassName="min-h-0 flex-1" />
    </div>
  )
}

function SettingsTabs({
  currentApp,
  showGeneral,
  settingsReady,
  appSettings,
  fullScreenSettings,
  onOpenShortcuts,
  panelClassName,
}: SettingsContentProps & { panelClassName: string }) {
  // The tab the user chose, unless the native menu asked for another one since.
  const request = useSettingsTabRequest()
  const [chosen, setChosen] = useState<{ tab: SettingsTab; seq: number } | null>(null)
  // Panelyth System (ADR-0042) has no settings and no shortcuts of its own.
  const system = currentApp === "system"
  const firstTab: SettingsTab = system ? "appearance" : currentApp
  const tab: SettingsTab =
    chosen && chosen.seq === request.seq ? chosen.tab : (request.tab ?? firstTab)
  const setTab = (next: SettingsTab): void => setChosen({ tab: next, seq: request.seq })
  const appLabel = currentApp === "viewer" ? "Viewer" : "Commander"
  const tabs: readonly { id: SettingsTab; label: string }[] = [
    ...(showGeneral ? [{ id: "general" as const, label: t("General") }] : []),
    ...(system ? [] : [{ id: currentApp, label: appLabel }]),
    ...(system ? [] : [{ id: "programs" as const, label: t("Open with") }]),
    { id: "appearance", label: t("Appearance") },
    ...(system ? [] : [{ id: "shortcuts" as const, label: t("Shortcuts") }]),
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
    <>
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
        // settings-form: switches and option rows (styles.css "Settings controls").
        className={`settings-form ${panelClassName} overflow-y-auto p-4 outline-none`}
      >
        {tab === "general" && showGeneral && <GeneralSettings settingsReady={settingsReady} />}
        {tab === currentApp && appSettings}
        {tab === "programs" && currentApp !== "system" && <ProgramsSettings app={currentApp} />}
        {tab === "appearance" && (
          <>
            <AppearanceSettings />
            {fullScreenSettings && (
              <section className="mt-4 space-y-1 border-t border-border pt-3">
                <h3 className="text-xs font-medium">{t("Full screen")}</h3>
                {fullScreenSettings}
              </section>
            )}
          </>
        )}
        {tab === "shortcuts" && (
          <section className="space-y-3 text-xs">
            <p className="text-muted">
              {t(
                "Review and customize the keys used for navigation, file actions, and the viewer.",
              )}
            </p>
            <Button variant="primary" onClick={onOpenShortcuts}>
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
    </>
  )
}
