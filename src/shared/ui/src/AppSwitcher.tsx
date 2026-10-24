import type { AppId } from "@panelyth/contracts"
import { APP_GLYPHS } from "./AppSwitchButton"
import { Tooltip } from "./Tooltip"
import { t } from "@panelyth/i18n"
import { updateWaiting, useAboutStore } from "@panelyth/renderer-core"

const TITLES: Record<AppId, string> = {
  viewer: "Viewer",
  commander: "Commander",
  system: "System",
}
const APPS: AppId[] = ["viewer", "commander", "system"]

export interface AppSwitcherProps {
  current: AppId
  /** The key that switches between the viewer and the commander (Ctrl+Shift+M). */
  shortcut: string
  onSwitch(to: AppId): void
  onSettings(): void
}

/**
 * The shared left rail: Panelyth, Panelyth Commander and Panelyth System
 * (ADR-0031, ADR-0042). The switch key goes between the viewer and the
 * commander; System is opened from here.
 */
export function AppSwitcher({ current, shortcut, onSwitch, onSettings }: AppSwitcherProps) {
  // A newer version was found or is downloaded: Settings → About has it (Stage P06).
  const waiting = useAboutStore(updateWaiting)
  const settingsLabel = waiting ? `${t("Settings")} — ${t("Update available")}` : t("Settings")
  return (
    <nav
      aria-label={t("Applications")}
      data-testid="app-switcher"
      className="app-rail glass-region row-span-full flex h-full w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-chrome py-2"
    >
      {APPS.map((app) => {
        const active = app === current
        const label = t("Switch to {app}", { app: TITLES[app] })
        const Glyph = APP_GLYPHS[app]
        // The key switches between the viewer and the commander only.
        const keyed = app !== "system" && current !== "system"

        return (
          <Tooltip
            key={app}
            side="right"
            content={
              active
                ? t("{app} (current app)", { app: TITLES[app] })
                : keyed
                  ? `${label} (${shortcut})`
                  : label
            }
          >
            <button
              type="button"
              onClick={active ? undefined : () => onSwitch(app)}
              disabled={active}
              aria-label={active ? t("{app} (current app)", { app: TITLES[app] }) : label}
              aria-current={active ? "page" : undefined}
              aria-keyshortcuts={active || !keyed ? undefined : shortcut.replace("Ctrl", "Control")}
              data-target={app}
              // "app-switch" is the other app of the keyed pair, the one the key goes to.
              data-testid={active ? "current-app" : keyed ? "app-switch" : `app-switch-${app}`}
              // The current app: the accent glyph, pressed into the glass in that style, and a
              // light on the rail's edge.
              className={`glass-press app-icon relative grid size-9 shrink-0 place-items-center rounded-md ${active ? "text-accent" : "text-muted hover:bg-raised hover:text-text"}`}
            >
              {active && (
                <span
                  aria-hidden="true"
                  data-testid="app-light"
                  className="rail-light absolute top-1 bottom-1 -left-1 w-[3px] rounded-r-full"
                />
              )}
              <Glyph size={18} />
            </button>
          </Tooltip>
        )
      })}
      <div className="mt-auto flex w-full justify-center border-t border-border pt-2">
        <Tooltip side="right" content={settingsLabel}>
          <button
            type="button"
            onClick={onSettings}
            aria-label={settingsLabel}
            data-testid="app-settings"
            data-update={waiting ? "waiting" : undefined}
            className="relative grid size-9 shrink-0 place-items-center rounded-md text-muted hover:bg-raised hover:text-text"
          >
            {waiting && (
              <span
                aria-hidden="true"
                className="absolute top-1.5 right-1.5 size-2 rounded-full bg-accent"
              />
            )}
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
