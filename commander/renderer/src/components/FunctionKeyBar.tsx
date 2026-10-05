import { bridge } from "../bridge"

const KEYS = [
  ["F3", "View"],
  ["F4", "Edit"],
  ["F5", "Copy"],
  ["F6", "Move"],
  ["F7", "New folder"],
  ["F8", "Delete"],
] as const

/** The function-key bar (CFR-25). Commands not built yet are disabled. */
export function FunctionKeyBar() {
  return (
    <nav
      aria-label="Function keys"
      className="flex h-8 shrink-0 items-stretch border-t border-border bg-chrome text-xs"
      data-testid="function-keys"
    >
      {KEYS.map(([key, label]) => (
        <button
          key={key}
          type="button"
          disabled
          title={`${label} (${key}) is not available yet`}
          className="flex flex-1 items-center justify-center gap-1.5 border-r border-border text-muted"
        >
          <kbd className="font-sans">{key}</kbd> {label}
        </button>
      ))}
      <button
        type="button"
        onClick={() => void bridge.exit().catch(() => undefined)}
        title="Exit (Alt+F4)"
        className="flex flex-1 items-center justify-center gap-1.5 text-text hover:bg-raised"
      >
        <kbd className="font-sans">Alt+F4</kbd> Exit
      </button>
    </nav>
  )
}
