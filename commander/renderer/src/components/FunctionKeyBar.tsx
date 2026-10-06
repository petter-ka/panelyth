import { bridge } from "../bridge"
import { runPanelAction } from "../features/commands"
import type { ActionId } from "../features/keymap"
import { usePanelsStore } from "../features/panels"

const KEYS: readonly { key: string; label: string; action: ActionId | null }[] = [
  { key: "F3", label: "View", action: "files.view" },
  { key: "F4", label: "Edit", action: "files.edit" },
  { key: "F5", label: "Copy", action: "files.copy" },
  { key: "F6", label: "Move", action: "files.move" },
  { key: "F7", label: "New folder", action: "files.mkdir" },
  { key: "F8", label: "Delete", action: "files.trash" },
]

/** The function-key bar (CFR-25): every label is a button. */
export function FunctionKeyBar() {
  return (
    <nav
      aria-label="Function keys"
      className="flex h-8 shrink-0 items-stretch border-t border-border bg-chrome text-xs"
      data-testid="function-keys"
    >
      {KEYS.map(({ key, label, action }) => (
        <button
          key={key}
          type="button"
          tabIndex={-1}
          disabled={action === null}
          title={action ? `${label} (${key})` : `${label} (${key}) is not available yet`}
          onClick={() => action && runPanelAction(usePanelsStore.getState().active, action)}
          className="flex flex-1 items-center justify-center gap-1.5 border-r border-border text-text hover:bg-raised disabled:text-muted disabled:hover:bg-transparent"
        >
          <kbd className="font-mono">{key}</kbd> {label}
        </button>
      ))}
      <button
        type="button"
        tabIndex={-1}
        onClick={() => void bridge.exit().catch(() => undefined)}
        title="Exit (Alt+F4)"
        className="flex flex-1 items-center justify-center gap-1.5 text-text hover:bg-raised"
      >
        <kbd className="font-mono">Alt+F4</kbd> Exit
      </button>
    </nav>
  )
}
