import { Kbd, Tooltip } from "@fastview/ui"
import { runPanelAction } from "../features/commands"
import type { ActionId } from "../features/keymap"
import { usePanelsStore } from "../features/panels"
import { CommanderActionIcon, type CommanderActionIconName } from "./CommanderActionIcon"

const KEYS: readonly {
  key: string
  label: string
  action: ActionId
  icon: CommanderActionIconName
}[] = [
  { key: "F3", label: "View", action: "files.view", icon: "view" },
  { key: "F4", label: "Edit", action: "files.edit", icon: "edit" },
  { key: "F5", label: "Copy", action: "files.copy", icon: "copy" },
  { key: "F6", label: "Move", action: "files.move", icon: "move" },
  { key: "F7", label: "New folder", action: "files.mkdir", icon: "mkdir" },
  { key: "F8", label: "Delete", action: "files.trash", icon: "delete" },
]

/** The function-key bar pairs each familiar shortcut with a quick visual cue. */
export function FunctionKeyBar() {
  return (
    <nav
      aria-label="Function keys"
      className="flex h-9 shrink-0 items-stretch border-t border-border bg-chrome text-xs"
      data-testid="function-keys"
    >
      {KEYS.map(({ key, label, action, icon }) => (
        <Tooltip key={key} content={`${label} (${key})`}>
          <button
            type="button"
            tabIndex={-1}
            aria-label={`${key} ${label}`}
            onClick={() => runPanelAction(usePanelsStore.getState().active, action)}
            className="group flex min-w-0 flex-1 items-center justify-center gap-1.5 border-r border-border px-1.5 text-text hover:bg-raised focus-visible:z-10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
          >
            <Kbd>{key}</Kbd>
            <CommanderActionIcon
              name={icon}
              className={
                icon === "delete"
                  ? "shrink-0 text-muted group-hover:text-danger"
                  : "shrink-0 text-muted group-hover:text-text"
              }
            />
            <span className="truncate whitespace-nowrap">{label}</span>
          </button>
        </Tooltip>
      ))}
    </nav>
  )
}
