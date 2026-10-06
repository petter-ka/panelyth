import type { AppId } from "@fastview/contracts"
import { CommanderGlyph, ViewerGlyph } from "./AppSwitchButton"

const TITLES: Record<AppId, string> = { viewer: "Viewer", commander: "Commander" }
const APPS: AppId[] = ["viewer", "commander"]

export interface AppSwitcherProps {
  current: AppId
  shortcut: string
  onSwitch(): void
}

/** A shared left rail for switching between FastView and FastView Commander. */
export function AppSwitcher({ current, shortcut, onSwitch }: AppSwitcherProps) {
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
          <button
            key={app}
            type="button"
            onClick={active ? undefined : onSwitch}
            disabled={active}
            aria-label={active ? `${TITLES[app]} (current app)` : label}
            aria-current={active ? "page" : undefined}
            aria-keyshortcuts={active ? undefined : shortcut.replace("Ctrl", "Control")}
            title={active ? `${TITLES[app]} (current app)` : `${label} (${shortcut})`}
            data-target={app}
            data-testid={active ? "current-app" : "app-switch"}
            className={`grid size-9 shrink-0 place-items-center rounded-md ${active ? "bg-raised text-accent" : "text-muted hover:bg-raised hover:text-text"}`}
          >
            <Glyph size={18} />
          </button>
        )
      })}
    </nav>
  )
}
