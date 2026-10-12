import { formatChord } from "@panelyth/renderer-core"
import { Tooltip } from "@panelyth/ui"
import { runPanelAction } from "../features/commands"
import { ACTIONS, isToolAction, useKeymapStore, type ActionId } from "../features/keymap"
import { useListingStore } from "../features/listing"
import { usePanelsStore } from "../features/panels"
import { commandOf, SEPARATOR, useToolsStore } from "../features/tools"
import { quickTarget, useViewersStore } from "../features/viewers"
import { CommanderActionIcon, type CommanderActionIconName } from "./CommanderActionIcon"
import { t } from "@panelyth/i18n"

/** The icon of a built-in action on the toolbar; the others show a general one. */
export const ACTION_ICONS: Partial<Record<ActionId, CommanderActionIconName>> = {
  "find.open": "search",
  "view.filter": "filter",
  "view.branch": "branch",
  "compare.dirs": "compare",
  "compare.sync": "sync",
  "compare.content": "compare",
  "view.quick": "preview",
  "view.refresh": "refresh",
  "hotlist.open": "star",
  "files.rename": "edit",
  "files.multiRename": "edit",
  "files.view": "view",
  "files.edit": "edit",
  "files.copy": "copy",
  "files.move": "move",
  "files.mkdir": "mkdir",
  "files.trash": "delete",
  "files.delete": "delete",
  "clip.copy": "copy",
  "view.thumbs": "tiles",
  "view.brief": "branch",
  "view.full": "branch",
  "cmd.focus": "terminal",
  "cmd.history": "terminal",
  "help.shortcuts": "keys",
  "app.settings": "tool",
}

const LABELS = new Map<string, string>(ACTIONS.map((a) => [a.id, a.label]))

/** A built-in action's name as the toolbar and its settings show it. */
export const actionLabel = (id: string): string => t(LABELS.get(id) ?? id)

const buttonClass =
  "group grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-raised hover:text-text aria-pressed:bg-accent/10 aria-pressed:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"

/**
 * The toolbar above the panels (Stage C10, CFR-25): the buttons the user
 * chose in Settings, each a built-in action or one of their own commands
 * (icon, label as the tooltip, command). The default set is the quick
 * actions the bar had before it could be changed.
 */
export function QuickActionBar() {
  const active = usePanelsStore((s) => s.active)
  const chords = useKeymapStore((s) => s.keymap.chords)
  const items = useToolsStore((s) => s.toolbar)
  // The commands' titles and icons can change without the list changing.
  useToolsStore((s) => s.commands)
  const branch = useListingStore((s) => s[active].branch)
  const filter = useListingStore((s) => s[active].filter)
  const view = useListingStore((s) => s[active].view)
  const quick = useViewersStore(quickTarget)

  const pressedOf = (action: string): boolean | undefined => {
    switch (action) {
      case "view.quick":
        return quick !== null
      case "view.branch":
        return branch
      case "view.filter":
        return filter.length > 0
      case "view.thumbs":
        return view === "thumbs"
      default:
        return undefined
    }
  }

  return (
    <nav
      aria-label={t("Toolbar")}
      className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-chrome px-1.5"
      data-testid="quick-actions"
    >
      {items.map((item, index) => {
        if (item === SEPARATOR) {
          return (
            <span
              key={`separator-${index}`}
              role="separator"
              aria-orientation="vertical"
              className="mx-1 h-4 w-px shrink-0 bg-border"
            />
          )
        }
        const tool = commandOf(item)
        if (isToolAction(item) && !tool) return null
        const label = tool ? tool.title : actionLabel(item)
        const chord = chords[item]?.[0]
        const icon = tool ? tool.icon : (ACTION_ICONS[item as ActionId] ?? "tool")
        return (
          <Tooltip key={item} content={chord ? `${label} (${formatChord(chord)})` : label}>
            <button
              type="button"
              aria-label={label}
              aria-pressed={pressedOf(item)}
              data-tool={tool?.id}
              onClick={() => runPanelAction(usePanelsStore.getState().active, item as ActionId)}
              className={buttonClass}
            >
              <CommanderActionIcon name={icon} />
            </button>
          </Tooltip>
        )
      })}
    </nav>
  )
}
