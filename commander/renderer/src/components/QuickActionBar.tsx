import { formatChord } from "@fastview/renderer-core"
import { Tooltip } from "@fastview/ui"
import { runPanelAction } from "../features/commands"
import type { ActionId } from "../features/keymap"
import { useKeymapStore } from "../features/keymap"
import { useListingStore } from "../features/listing"
import { usePanelsStore } from "../features/panels"
import { quickTarget, useViewersStore } from "../features/viewers"
import { CommanderActionIcon, type CommanderActionIconName } from "./CommanderActionIcon"

const ACTIONS: readonly {
  action: ActionId
  label: string
  icon: CommanderActionIconName
  dividerBefore?: boolean
}[] = [
  { action: "find.open", label: "Find files", icon: "search" },
  { action: "view.filter", label: "Quick filter", icon: "filter" },
  { action: "view.branch", label: "Branch view", icon: "branch" },
  { action: "view.quick", label: "Quick view", icon: "preview", dividerBefore: true },
  { action: "view.refresh", label: "Refresh", icon: "refresh" },
  { action: "hotlist.open", label: "Directory hotlist", icon: "star" },
  { action: "files.rename", label: "Rename", icon: "edit" },
]

/** Compact icon shortcuts for common commands outside the function-key set. */
export function QuickActionBar() {
  const active = usePanelsStore((s) => s.active)
  const chords = useKeymapStore((s) => s.keymap.chords)
  const branch = useListingStore((s) => s[active].branch)
  const filter = useListingStore((s) => s[active].filter)
  const quick = useViewersStore(quickTarget)

  return (
    <nav
      aria-label="Quick actions"
      className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-chrome px-1.5"
      data-testid="quick-actions"
    >
      {ACTIONS.map(({ action, label, icon, dividerBefore }) => {
        const chord = chords[action]?.[0]
        const shortcut = chord ? formatChord(chord) : ""
        const pressed =
          action === "view.quick"
            ? quick !== null
            : action === "view.branch"
              ? branch
              : action === "view.filter"
                ? filter.length > 0
                : undefined
        return (
          <span key={action} className="contents">
            {dividerBefore && (
              <span
                role="separator"
                aria-orientation="vertical"
                className="mx-1 h-4 w-px shrink-0 bg-border"
              />
            )}
            <Tooltip content={shortcut ? `${label} (${shortcut})` : label}>
              <button
                type="button"
                aria-label={label}
                aria-pressed={pressed}
                onClick={() => runPanelAction(usePanelsStore.getState().active, action)}
                className="group grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-raised hover:text-text aria-pressed:bg-accent/10 aria-pressed:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              >
                <CommanderActionIcon name={icon} />
              </button>
            </Tooltip>
          </span>
        )
      })}
    </nav>
  )
}
