import type { AppId } from "@panelyth/contracts"
import { CommanderGlyph, ViewerGlyph } from "./AppSwitchButton"
import { Tooltip } from "./Tooltip"

const TITLES: Record<AppId, string> = { viewer: "Viewer", commander: "Commander" }
const APPS: AppId[] = ["viewer", "commander"]

export interface AppSwitcherProps {
  current: AppId
  shortcut: string
  onSwitch(): void
  onSettings(): void
}

/** A shared left rail for switching between Panelyth and Panelyth Commander. */
export function AppSwitcher({ current, shortcut, onSwitch, onSettings }: AppSwitcherProps) {
  return (
    <nav
      aria-label="Applications"
      data-testid="app-switcher"
      className="row-span-full flex h-full w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-chrome py-2"
    >
      {APPS.map((app) => {
        const active = app === current
        const label = `Switch to ${TITLES[app]}`
        const Glyph = app === "viewer" ? ViewerGlyph : CommanderGlyph

        return (
          <Tooltip
            key={app}
            side="right"
            content={active ? `${TITLES[app]} (current app)` : `${label} (${shortcut})`}
          >
            <button
              type="button"
              onClick={active ? undefined : onSwitch}
              disabled={active}
              aria-label={active ? `${TITLES[app]} (current app)` : label}
              aria-current={active ? "page" : undefined}
              aria-keyshortcuts={active ? undefined : shortcut.replace("Ctrl", "Control")}
              data-target={app}
              data-testid={active ? "current-app" : "app-switch"}
              className={`grid size-9 shrink-0 place-items-center rounded-md ${active ? "bg-raised text-accent" : "text-muted hover:bg-raised hover:text-text"}`}
            >
              <Glyph size={18} />
            </button>
          </Tooltip>
        )
      })}
      <div className="mt-auto flex w-full justify-center border-t border-border pt-2">
        <Tooltip side="right" content="Settings">
          <button
            type="button"
            onClick={onSettings}
            aria-label="Settings"
            data-testid="app-settings"
            className="grid size-9 shrink-0 place-items-center rounded-md text-muted hover:bg-raised hover:text-text"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="8" cy="8" r="2.2" />
              <path d="M8 1.8v1.1M8 13.1v1.1M1.8 8h1.1M13.1 8h1.1M3.6 3.6l.8.8m7.2 7.2.8.8m0-8.8-.8.8m-7.2 7.2-.8.8" />
              <circle cx="8" cy="8" r="5.5" />
            </svg>
          </button>
        </Tooltip>
      </div>
    </nav>
  )
}
