import type { AppId } from "@panelyth/contracts"
import { Tooltip } from "./Tooltip"
import { t } from "@panelyth/i18n"
import type { ReactElement } from "react"

const TITLES: Record<AppId, string> = {
  viewer: "Viewer",
  commander: "Commander",
  system: "System",
}

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

/** A gauge: Panelyth System (ADR-0042), the computer at a glance. */
export function SystemGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.2 11.5a6 6 0 1 1 11.6 0" stroke="currentColor" strokeLinecap="round" />
      <path d="m8 10.5 2.8-3.6" stroke="currentColor" strokeLinecap="round" />
      <circle cx="8" cy="10.5" r="1.2" fill="currentColor" />
      <path d="M4.5 13.5h7" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}

/** Each app's glyph, for the rail and the loading screen. */
export const APP_GLYPHS: Record<AppId, (props: { size?: number }) => ReactElement> = {
  viewer: ViewerGlyph,
  commander: CommanderGlyph,
  system: SystemGlyph,
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
 * one icon button, showing the other app.
 */
export function AppSwitchButton({ target, shortcut, onSwitch }: AppSwitchButtonProps) {
  const label = t("Switch to {app}", { app: TITLES[target] })
  return (
    <Tooltip content={`${label} (${shortcut})`} side="right">
      <button
        type="button"
        onClick={onSwitch}
        aria-label={label}
        aria-keyshortcuts={shortcut.replace("Ctrl", "Control")}
        data-testid="app-switch"
        data-target={target}
        className="grid size-7 shrink-0 place-items-center rounded-md text-text hover:bg-raised"
      >
        {(() => {
          const Glyph = APP_GLYPHS[target]
          return <Glyph />
        })()}
      </button>
    </Tooltip>
  )
}
