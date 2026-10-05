import type { AppId } from "@fastview/contracts"

const TITLES: Record<AppId, string> = { viewer: "Viewer", commander: "Commander" }

/** Two panels side by side: the commander. */
export function CommanderGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="5.5" height="11" rx="1" stroke="currentColor" />
      <rect x="9" y="2.5" width="5.5" height="11" rx="1" stroke="currentColor" />
      <path d="M3 5.5h2.5M3 7.5h2.5M10.5 5.5h2.5M10.5 7.5h2.5" stroke="currentColor" />
    </svg>
  )
}

/** A 2 × 2 grid of picture tiles: the viewer. */
export function ViewerGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" stroke="currentColor" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="1" stroke="currentColor" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="1" stroke="currentColor" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="1" stroke="currentColor" />
    </svg>
  )
}

export interface AppSwitchButtonProps {
  /** The app this button switches to; its glyph is shown. */
  target: AppId
  /** The current chord for display, for example "Ctrl+Shift+M". */
  shortcut: string
  onSwitch(): void
}

/**
 * The connection point between the apps (ADR-0031, docs/shared/APP-SWITCHING.md):
 * one icon button at the top left of each app, showing the other app.
 */
export function AppSwitchButton({ target, shortcut, onSwitch }: AppSwitchButtonProps) {
  const label = `Switch to ${TITLES[target]}`
  return (
    <button
      type="button"
      onClick={onSwitch}
      aria-label={label}
      aria-keyshortcuts={shortcut.replace("Ctrl", "Control")}
      title={`${label} (${shortcut})`}
      data-testid="app-switch"
      data-target={target}
      className="grid size-7 shrink-0 place-items-center rounded-md text-text hover:bg-raised"
    >
      {target === "commander" ? <CommanderGlyph /> : <ViewerGlyph />}
    </button>
  )
}
