import {
  MAX_COMMAND_CHARS,
  MAX_TOOL_TITLE_CHARS,
  MAX_USER_COMMANDS,
  TOOL_ICONS,
  type ToolIcon,
  type UserCommand,
} from "@panelyth/contracts"
import { TILE_SIZE_ORDER, FullScreenSettings } from "@panelyth/media-ui"
import { Button, ChoiceGroup, SharedSettingsDialog, fieldClass } from "@panelyth/ui"
import { useState, type ReactNode } from "react"
import { POLICIES } from "../features/files"
import { showHiddenEverywhere, systemFilesChanged } from "../features/tabs"
import { setTreeMode, usePanelsStore, type TreeMode } from "../features/panels"
import { isToolAction, setHelpOpen, toolAction, type ActionId } from "../features/keymap"
import {
  MAX_EDITOR_CHARS,
  setSettingsOpen,
  takeSettingsSection,
  updateSettings,
  useSettingsStore,
  type PanelSettings,
} from "../features/settings"
import { useSidecarStore } from "../features/sidecar"
import {
  commandOf,
  MAX_TOOLBAR_ITEMS,
  newCommand,
  removeCommand,
  resetToolbar,
  saveCommand,
  SEPARATOR,
  setToolbar,
  toolbarCandidates,
  useToolsStore,
} from "../features/tools"
import { CommanderActionIcon } from "./CommanderActionIcon"
import { ACTION_ICONS, actionLabel } from "./QuickActionBar"
import { msg, t } from "@panelyth/i18n"

type BooleanSetting = {
  [K in keyof PanelSettings]: PanelSettings[K] extends boolean ? K : never
}[keyof PanelSettings]

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

function Check({
  setting: name,
  label,
  onChange,
  disabled = false,
  className = "",
}: {
  setting: BooleanSetting
  label: string
  /** Applies the new value beyond the stored settings. */
  onChange?: (checked: boolean) => void
  disabled?: boolean
  className?: string
}) {
  const checked = useSettingsStore((s) => s.settings[name])
  return (
    <label className={`flex items-center gap-2 ${disabled ? "text-muted" : ""} ${className}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          updateSettings({ [name]: e.target.checked } as Partial<PanelSettings>)
          onChange?.(e.target.checked)
        }}
      />
      {label}
    </label>
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
      <span className="text-muted">{t("Editor (F4)")}</span>
      <input
        aria-label={t("Editor program")}
        className={fieldClass}
        value={value}
        maxLength={MAX_EDITOR_CHARS}
        spellCheck={false}
        placeholder={t("The system's text editor")}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save()
        }}
      />
      <span className="text-2xs text-muted">{t("The full path of a program, or empty.")}</span>
    </label>
  )
}

/** The folder tree's place (Ctrl+Shift+F8 cycles through the same three). Part of the layout, not of the settings. */
function TreeModeRadios() {
  const mode = usePanelsStore((s) => s.tree)
  const options: { value: TreeMode; label: string }[] = [
    { value: "off", label: t("Not shown") },
    { value: "one", label: t("One, for the active panel") },
    { value: "two", label: t("One beside each panel") },
  ]
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-muted">{t("Folder tree")}</legend>
      {options.map((o) => (
        <label key={o.value} className="flex items-center gap-2">
          <input
            type="radio"
            name="tree-mode"
            checked={mode === o.value}
            onChange={() => setTreeMode(o.value)}
            className="accent-[var(--color-accent)]"
          />
          {o.label}
        </label>
      ))}
    </fieldset>
  )
}

/**
 * `onShowHidden`: the in-page dialog shows or hides hidden entries in every
 * panel itself; in the settings window the app view does it when the change
 * arrives (ADR-0039).
 */
function PanelsSection({
  onShowHidden,
  onShowSystem,
}: {
  onShowHidden?: (show: boolean) => void
  onShowSystem?: () => void
}) {
  const showHidden = useSettingsStore((s) => s.settings.showHidden)
  const thumbSize = useSettingsStore((s) => s.settings.thumbSize)
  return (
    <Section>
      <Radios
        setting="sizeFormat"
        label={t("Sizes")}
        options={[
          { value: "units", label: t("Units (1.5 KB)") },
          { value: "bytes", label: t("Bytes (1,234,567)") },
        ]}
      />
      <Radios
        setting="dateFormat"
        label={t("Dates")}
        options={[
          { value: "relative", label: t("Relative (yesterday at 14:05)") },
          { value: "locale", label: t("As the system shows them") },
          { value: "iso", label: t("ISO (2026-10-06 14:05)") },
        ]}
      />
      <div className="flex flex-col gap-1.5">
        <Check
          setting="showHidden"
          label={t("Show hidden files")}
          {...(onShowHidden && { onChange: onShowHidden })}
        />
        {/* System files are hidden ones too (Windows marks its own both ways): under hidden files. */}
        <Check
          setting="showSystem"
          label={t("Show system files too")}
          disabled={!showHidden}
          className="pl-6"
          {...(onShowSystem && { onChange: onShowSystem })}
        />
      </div>
      <Radios
        setting="letters"
        label={t("Typed letters")}
        options={[
          { value: "quickSearch", label: t("Start quick search") },
          {
            value: "altLetters",
            label: t("Go to the command line (quick search starts with Alt)"),
          },
        ]}
      />
      <Radios
        setting="rightButton"
        label={t("Right mouse button")}
        options={[
          { value: "mark", label: t("Marks entries (hold for the menu)") },
          { value: "menu", label: t("Opens the menu") },
        ]}
      />
      <Radios
        setting="mediaOpen"
        label={t("Open images and videos with")}
        options={[
          { value: "viewer", label: "Panelyth Viewer" },
          { value: "system", label: t("System default app") },
        ]}
      />
      <Radios
        setting="documentOpen"
        label={t("Open PDFs and text files with")}
        options={[
          { value: "window", label: t("Panelyth document window") },
          { value: "system", label: t("System default app") },
        ]}
      />
      <div className="flex flex-col gap-1.5">
        <span className="text-muted">{t("Tiles of the Thumbnails view")}</span>
        <ChoiceGroup
          label={t("Tiles of the Thumbnails view")}
          value={thumbSize}
          disabled={false}
          options={TILE_SIZE_ORDER.map((size) => ({
            value: size,
            label: size === "small" ? t("S") : size === "medium" ? t("M") : t("L"),
            title: size === "small" ? t("Small") : size === "medium" ? t("Medium") : t("Large"),
          }))}
          onChange={(value) => updateSettings({ thumbSize: value })}
        />
      </div>
      <Radios
        setting="tabBar"
        label={t("Tab bar")}
        options={[
          { value: "always", label: t("Always shown") },
          { value: "multiple", label: t("Only with several tabs") },
        ]}
      />
      <TreeModeRadios />
      <Check setting="treeFollowCursor" label={t("The tree opens folders as the cursor moves")} />
      <Check setting="showGit" label={t("Show Git status in the folders of a repository")} />
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-muted">{t("Around the panels")}</legend>
        <Check setting="showToolbar" label={t("Toolbar")} />
        <Check setting="showCommandLine" label={t("Command line")} />
        <Check setting="showFunctionKeys" label={t("Function-key bar")} />
      </fieldset>
    </Section>
  )
}

function OperationsSection() {
  const conflict = useSettingsStore((s) => s.settings.copyConflict)
  return (
    <Section>
      <label className="flex flex-col gap-1">
        <span className="text-muted">{t("When a file exists at the destination")}</span>
        <select
          aria-label={t("When a file exists at the destination")}
          value={conflict}
          onChange={(e) =>
            updateSettings({ copyConflict: e.target.value as PanelSettings["copyConflict"] })
          }
          className={fieldClass}
        >
          {POLICIES.map((p) => (
            <option key={p.value} value={p.value}>
              {t(p.label)}
            </option>
          ))}
        </select>
        <span className="text-2xs text-muted">
          {t("What the copy and move dialogs start with; each job can still choose.")}
        </span>
      </label>
      <Check setting="copyVerify" label={t("Verify files after copying")} />
      <Radios
        setting="compareToleranceMs"
        label={t("Compare dates (Shift+F2, Synchronize directories)")}
        options={[
          { value: 2000, label: t("Within 2 seconds (FAT drives)") },
          { value: 0, label: t("Exact") },
        ]}
      />
      <Check
        setting="compareDst"
        label={t("Ignore a one-hour difference (daylight saving time)")}
      />
      <Check setting="compareIgnoreDates" label={t("Ignore dates")} />
    </Section>
  )
}

function ConfirmationsSection() {
  return (
    <Section>
      <Check setting="confirmTrash" label={t("Ask before moving to the trash")} />
      <p className="-mt-3 text-2xs text-muted">{t("Deleting permanently always asks.")}</p>
      <Check setting="confirmDrop" label={t("Show the copy dialog when files are dropped")} />
      <Radios
        setting="runPrograms"
        label={t("Run programs with Enter")}
        options={[
          { value: "ask", label: t("Ask first") },
          { value: "always", label: t("Always") },
          { value: "never", label: t("Never") },
        ]}
      />
    </Section>
  )
}

const ICON_LABEL: Record<ToolIcon, string> = {
  tool: msg("Gear"),
  terminal: msg("Console"),
  play: msg("Play"),
  edit: msg("Pencil"),
  view: msg("Eye"),
  copy: msg("Copy"),
  move: msg("Folder with an arrow"),
  search: msg("Magnifier"),
  star: msg("Star"),
  compare: msg("Two pages"),
  sync: msg("Two arrows"),
  refresh: msg("Round arrow"),
}

/** One user command being added or changed. */
function CommandForm({ initial, onDone }: { initial: UserCommand; onDone(): void }) {
  const shownOnToolbar = useToolsStore((s) => s.toolbar.includes(toolAction(initial.id)))
  const existing = useToolsStore((s) => s.commands.some((c) => c.id === initial.id))
  const [draft, setDraft] = useState(initial)
  const [onToolbar, setOnToolbar] = useState(existing ? shownOnToolbar : true)
  const [error, setError] = useState<string | null>(null)
  const change = (part: Partial<UserCommand>): void => {
    setDraft({ ...draft, ...part })
    setError(null)
  }
  const save = (): void => {
    if (draft.command.trim() === "") return setError(t("Enter the command to run."))
    if (saveCommand(draft, onToolbar)) onDone()
    else setError(t("This command can't be saved. Remove line breaks and try again."))
  }
  const text = (
    label: string,
    key: "title" | "command" | "params" | "dir",
    placeholder: string,
    max = MAX_COMMAND_CHARS,
  ) => (
    <label className="flex flex-col gap-1">
      <span className="text-muted">{label}</span>
      <input
        aria-label={label}
        className={`${fieldClass} ${key === "title" ? "" : "font-mono"}`}
        value={draft[key]}
        maxLength={max}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(e) => change({ [key]: e.target.value })}
      />
    </label>
  )
  return (
    <div
      role="group"
      aria-label={existing ? t("Change the command") : t("New command")}
      data-testid="tool-form"
      className="flex flex-col gap-3 rounded-md border border-border bg-canvas p-3"
    >
      {text(t("Name"), "title", t("Open in the editor"), MAX_TOOL_TITLE_CHARS)}
      {text(t("Command"), "command", "code")}
      {text(t("Parameters"), "params", "%P%N")}
      <p className="-mt-2 text-2xs text-muted">
        {t(
          "%P this panel's folder · %T the other panel's folder · %N the name under the cursor · %S the marked names · %L a file listing the marked paths. %P%N is the full path under the cursor. Names are quoted for you.",
        )}
      </p>
      {text(t("Working folder"), "dir", t("The panel's folder"))}
      <label className="flex flex-col gap-1">
        <span className="text-muted">{t("Icon")}</span>
        <select
          aria-label={t("Icon")}
          value={draft.icon}
          onChange={(e) => change({ icon: e.target.value as ToolIcon })}
          className={fieldClass}
        >
          {TOOL_ICONS.map((icon) => (
            <option key={icon} value={icon}>
              {t(ICON_LABEL[icon])}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={onToolbar}
          onChange={(e) => setOnToolbar(e.target.checked)}
        />
        {t("Show on the toolbar")}
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.menu}
          onChange={(e) => change({ menu: e.target.checked })}
        />
        {t("Show in the menu of files")}
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={draft.console}
          onChange={(e) => change({ console: e.target.checked })}
        />
        {t("Run in a console window that stays open")}
      </label>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onDone}>{t("Cancel")}</Button>
        <Button variant="primary" onClick={save}>
          {t("Save command")}
        </Button>
      </div>
    </div>
  )
}

function ToolsSection() {
  const commands = useToolsStore((s) => s.commands)
  const [editing, setEditing] = useState<UserCommand | null>(null)
  return (
    <Section>
      <EditorField />
      <div className="flex flex-col gap-2">
        <span className="text-muted">{t("Your commands")}</span>
        <p className="text-2xs text-muted">
          {t(
            "Programs you start from the toolbar, the menu of files or a key (Keyboard shortcuts → Tools). A command runs only when you start it.",
          )}
        </p>
        {commands.length > 0 && (
          <ul aria-label={t("Your commands")} className="flex flex-col gap-1">
            {commands.map((c) => (
              <li
                key={c.id}
                className="flex items-center gap-2 rounded-md border border-border px-2 py-1"
              >
                <CommanderActionIcon name={c.icon} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{c.title}</span>
                  <span className="block truncate font-mono text-2xs text-muted">
                    {c.params ? `${c.command} ${c.params}` : c.command}
                  </span>
                </span>
                <Button
                  size="sm"
                  aria-label={t("Change {command}", { command: c.title })}
                  onClick={() => setEditing(c)}
                >
                  {t("Change")}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  aria-label={t("Remove {command}", { command: c.title })}
                  onClick={() => {
                    if (editing?.id === c.id) setEditing(null)
                    removeCommand(c.id)
                  }}
                >
                  {t("Remove")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {editing ? (
          <CommandForm key={editing.id} initial={editing} onDone={() => setEditing(null)} />
        ) : (
          <div>
            <Button
              disabled={commands.length >= MAX_USER_COMMANDS}
              onClick={() => setEditing(newCommand())}
            >
              {t("Add a command…")}
            </Button>
          </div>
        )}
      </div>
    </Section>
  )
}

function ToolbarSection() {
  const items = useToolsStore((s) => s.toolbar)
  const commands = useToolsStore((s) => s.commands)
  const [adding, setAdding] = useState("")
  const move = (index: number, by: -1 | 1): void => {
    const next = [...items]
    const [item] = next.splice(index, 1)
    next.splice(index + by, 0, item!)
    setToolbar(next)
  }
  const label = (item: string): string =>
    item === SEPARATOR ? t("Divider") : (commandOf(item)?.title ?? actionLabel(item))
  const free = toolbarCandidates(items, commands)
  return (
    <Section>
      <Check setting="showToolbar" label={t("Show the toolbar")} />
      <ol aria-label={t("Toolbar buttons")} className="flex flex-col gap-1">
        {items.map((item, index) => {
          const tool = commandOf(item)
          return (
            <li
              key={`${item}-${index}`}
              className="flex h-8 items-center gap-2 rounded-md border border-border px-2"
            >
              {item === SEPARATOR ? (
                <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border" />
              ) : (
                <CommanderActionIcon
                  name={
                    tool
                      ? tool.icon
                      : ((isToolAction(item) ? undefined : ACTION_ICONS[item as ActionId]) ??
                        "tool")
                  }
                  className="shrink-0 text-muted"
                />
              )}
              <span className="min-w-0 flex-1 truncate">{label(item)}</span>
              <Button
                size="icon"
                aria-label={t("Move {button} up", { button: label(item) })}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </Button>
              <Button
                size="icon"
                aria-label={t("Move {button} down", { button: label(item) })}
                disabled={index === items.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </Button>
              <Button
                size="icon"
                aria-label={t("Remove {button} from the toolbar", { button: label(item) })}
                onClick={() => setToolbar(items.filter((_, i) => i !== index))}
              >
                ✕
              </Button>
            </li>
          )
        })}
      </ol>
      <div className="flex items-center gap-2">
        <select
          aria-label={t("Button to add")}
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          className={fieldClass}
        >
          <option value="">{t("Choose a command…")}</option>
          <option value={SEPARATOR}>{t("Divider")}</option>
          {free.map((item) => (
            <option key={item} value={item}>
              {label(item)}
            </option>
          ))}
        </select>
        <Button
          disabled={adding === "" || items.length >= MAX_TOOLBAR_ITEMS}
          onClick={() => {
            setToolbar([...items, adding])
            setAdding("")
          }}
        >
          {t("Add")}
        </Button>
        <Button onClick={resetToolbar}>{t("Reset")}</Button>
      </div>
    </Section>
  )
}

const SECTION_IDS = ["panels", "operations", "confirmations", "tools", "toolbar"] as const
type SectionId = (typeof SECTION_IDS)[number]

/**
 * The commander's own settings (Stage C10): Panels, Operations,
 * Confirmations, Editor and tools, and the Toolbar. Keys and Appearance are
 * the tabs of the dialog shared with the viewer.
 */
export function CommanderSettings({
  onShowHidden,
  onShowSystem,
}: {
  onShowHidden?: (show: boolean) => void
  /** The in-page dialog relists the panels itself; the settings window's app view does it on the relay. */
  onShowSystem?: () => void
}) {
  // A section asked for (the toolbar's "Customize toolbar…") is shown first.
  const [section, setSection] = useState<SectionId>(() => {
    const asked = takeSettingsSection()
    return SECTION_IDS.includes(asked as SectionId) ? (asked as SectionId) : "panels"
  })
  return (
    <div className="flex flex-col gap-4">
      {/* The sections stay at the top while the tab scrolls, like the tabs above them:
          the bar covers the panel's padding (-m/p-4) so nothing shows around it, and
          sticks at -1rem because the panel's padding is where "top" is measured from. */}
      <div className="sticky -top-4 z-10 -mx-4 -mt-4 border-b border-border bg-chrome px-4 pt-4 pb-3">
        <ChoiceGroup<SectionId>
          label={t("Commander settings")}
          value={section}
          disabled={false}
          options={[
            { value: "panels", label: t("Panels") },
            { value: "operations", label: t("Operations") },
            { value: "confirmations", label: t("Confirmations") },
            { value: "tools", label: t("Editor and tools") },
            { value: "toolbar", label: t("Toolbar") },
          ]}
          onChange={setSection}
        />
      </div>
      {section === "panels" && (
        <PanelsSection
          {...(onShowHidden && { onShowHidden })}
          {...(onShowSystem && { onShowSystem })}
        />
      )}
      {section === "operations" && <OperationsSection />}
      {section === "confirmations" && <ConfirmationsSection />}
      {section === "tools" && <ToolsSection />}
      {section === "toolbar" && <ToolbarSection />}
    </div>
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
      appSettings={
        <CommanderSettings onShowHidden={showHiddenEverywhere} onShowSystem={systemFilesChanged} />
      }
      fullScreenSettings={<FullScreenSettings />}
      onOpenShortcuts={() => setHelpOpen(true)}
    />
  )
}
