import { t } from "@panelyth/i18n"
import { formatChord } from "@panelyth/renderer-core"
import {
  DropdownCheckboxItem,
  DropdownContent,
  DropdownLabel,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownRoot,
  DropdownSeparator,
  DropdownTrigger,
} from "@panelyth/ui"
import { useKeymapStore } from "../features/keymap"
import { readView, setView, useListingStore, type ViewMode } from "../features/listing"
import type { Side } from "../features/panels"
import { updateSettings, useSettingsStore } from "../features/settings"
import { showHiddenEverywhere, systemFilesChanged } from "../features/tabs"

/** An eye: what the panel shows and how. */
const EyeGlyph = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="2" />
  </svg>
)

const VIEWS: readonly { view: ViewMode; command: string; label: () => string }[] = [
  { view: "full", command: "view.full", label: () => t("Full view") },
  { view: "brief", command: "view.brief", label: () => t("Brief view") },
  { view: "thumbs", command: "view.thumbs", label: () => t("Thumbnails view") },
]

/**
 * The path bar's view options (owner request 2026-10-24): the Settings →
 * Panels switches for hidden and system files (both panels, as there), and
 * this panel's view, each with its shortcut. The menu stays open on a switch.
 */
export function ViewOptions({ side, className }: { side: Side; className: string }) {
  const view = useListingStore((s) => s[side].view)
  const showHidden = useSettingsStore((s) => s.settings.showHidden)
  const showSystem = useSettingsStore((s) => s.settings.showSystem)
  const chords = useKeymapStore((s) => s.keymap.chords)
  const shortcut = (command: string): string => {
    const chord = chords[command]?.[0]
    return chord ? formatChord(chord) : ""
  }
  const label = t("View options")
  return (
    <DropdownRoot>
      <DropdownTrigger
        tabIndex={-1}
        aria-label={label}
        data-tooltip-content={label}
        data-testid={`view-options-${side}`}
        className={`${className} inline-grid place-items-center`}
      >
        <EyeGlyph />
      </DropdownTrigger>
      <DropdownContent align="end" data-testid={`view-options-menu-${side}`} aria-label={label}>
        <DropdownLabel>{t("Show")}</DropdownLabel>
        <DropdownCheckboxItem
          checked={showHidden}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(checked) => {
            updateSettings({ showHidden: checked })
            showHiddenEverywhere(checked)
          }}
        >
          {/* Both panels, as in Settings (Ctrl+H switches one panel). */}
          {t("Show hidden files")}
        </DropdownCheckboxItem>
        {/* System files are hidden ones too (Windows marks its own both ways): under hidden files. */}
        <DropdownCheckboxItem
          checked={showSystem}
          disabled={!showHidden}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(checked) => {
            updateSettings({ showSystem: checked })
            systemFilesChanged()
          }}
        >
          {t("Show system files too")}
        </DropdownCheckboxItem>
        <DropdownSeparator />
        <DropdownLabel>{t("View")}</DropdownLabel>
        <DropdownRadioGroup value={view} onValueChange={(v) => setView(side, readView(v))}>
          {VIEWS.map((v) => (
            <DropdownRadioItem key={v.view} value={v.view}>
              {v.label()}
              <Shortcut keys={shortcut(v.command)} />
            </DropdownRadioItem>
          ))}
        </DropdownRadioGroup>
      </DropdownContent>
    </DropdownRoot>
  )
}

function Shortcut({ keys }: { keys: string }) {
  return keys ? (
    <span className="ml-auto pl-6 text-2xs opacity-70 group-data-[highlighted]:opacity-100">
      {keys}
    </span>
  ) : null
}
