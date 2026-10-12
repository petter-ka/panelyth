import type { AppTarget, MenuCommand, UpdateState } from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import {
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  loadAbout,
  openAppTarget,
  useAboutStore,
} from "@panelyth/renderer-core"
import { useEffect, type ReactNode } from "react"
import { create } from "zustand"
import { Button } from "./button"

/** The tabs of the settings dialog; "about" can be asked for from the native menu. */
export type SettingsTab = "general" | "viewer" | "commander" | "appearance" | "shortcuts" | "about"

/**
 * A tab asked for from outside the dialog (the native menu's About and
 * "Check for Updates…"). `seq` tells a new request from the tab the user
 * chose afterwards.
 */
export const useSettingsTabRequest = create<{ tab: SettingsTab | null; seq: number }>(() => ({
  tab: null,
  seq: 0,
}))

export const requestSettingsTab = (tab: SettingsTab | null): void =>
  useSettingsTabRequest.setState((s) => ({ tab, seq: s.seq + 1 }))

/** What each app does with an item of the native menu (the `menu.command` event). */
export function menuCommandHandler(app: {
  openSettings(): void
  openShortcuts(): void
}): (command: MenuCommand) => void {
  return (command) => {
    if (command === "shortcuts") return app.openShortcuts()
    if (command !== "settings") requestSettingsTab("about")
    app.openSettings()
    // With a version already found or downloaded, the tab shows it; nothing to look for.
    const phase = useAboutStore.getState().update?.phase
    if (command === "checkForUpdates" && phase !== "available" && phase !== "ready") {
      checkForUpdates()
    }
  }
}

function statusText(update: UpdateState): string {
  const version = update.version ?? ""
  if (update.mode === "off") return t("This build does not update itself.")
  switch (update.phase) {
    case "idle":
      return t("Not checked yet.")
    case "checking":
      return t("Checking for updates…")
    case "upToDate":
      return t("Panelyth is up to date.")
    case "available":
      return t("Version {version} is available.", { version })
    case "downloading":
      return t("Downloading version {version}… {percent} %", {
        version,
        percent: Math.round(update.percent),
      })
    case "ready":
      return t("Version {version} is ready. It installs when Panelyth restarts.", { version })
    case "error":
      return t("The update check failed: {reason}", { reason: update.error ?? "" })
  }
}

function UpdateActions({ update }: { update: UpdateState }) {
  if (update.mode === "off") return null
  if (update.phase === "ready") {
    return (
      <Button variant="primary" data-testid="update-install" onClick={installUpdate}>
        {t("Restart to update")}
      </Button>
    )
  }
  if (update.phase === "available") {
    return update.mode === "auto" ? (
      <Button variant="primary" data-testid="update-download" onClick={downloadUpdate}>
        {t("Download and install")}
      </Button>
    ) : (
      <Button
        variant="primary"
        data-testid="update-open-page"
        onClick={() => openAppTarget("releases")}
      >
        {t("Open the download page")}
      </Button>
    )
  }
  return (
    <Button
      data-testid="update-check"
      disabled={update.phase === "checking" || update.phase === "downloading"}
      onClick={checkForUpdates}
    >
      {t("Check for updates")}
    </Button>
  )
}

const LINKS: readonly { target: AppTarget; label: () => string }[] = [
  { target: "releases", label: () => t("Release notes") },
  { target: "issues", label: () => t("Report a problem") },
  { target: "logs", label: () => t("Open log folder") },
  { target: "notices", label: () => t("Third-party licenses") },
]

/** Settings → About: the version, the update and its notes, and where to look further. */
export function AboutPanel({
  autoSwitch,
}: {
  /** The "Check automatically" row; shown only in a build that updates. */
  autoSwitch: ReactNode
}) {
  const info = useAboutStore((s) => s.info)
  const update = useAboutStore((s) => s.update)
  const problem = useAboutStore((s) => s.problem)
  useEffect(loadAbout, [])

  return (
    <div className="space-y-4" data-testid="settings-about">
      <section>
        <h3 className="text-sm font-semibold">Panelyth</h3>
        <p className="mt-0.5 text-xs text-muted" data-testid="about-version">
          {t("Version {version}", { version: info?.version ?? update?.currentVersion ?? "" })}
        </p>
      </section>

      {update && (
        <section className="space-y-3 border-t border-border pt-3" aria-label={t("Updates")}>
          <h3 className="text-xs font-medium">{t("Updates")}</h3>
          <div className="flex items-center gap-3">
            <p
              role="status"
              aria-live="polite"
              data-testid="update-status"
              data-phase={update.phase}
              className={`min-w-0 flex-1 text-xs ${update.phase === "error" ? "text-danger" : ""}`}
            >
              {statusText(update)}
            </p>
            <UpdateActions update={update} />
          </div>
          {update.phase === "downloading" && (
            <div
              role="progressbar"
              aria-label={t("Updates")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(update.percent)}
              className="h-1.5 overflow-hidden rounded-full bg-border"
            >
              <div className="h-full bg-accent" style={{ width: `${update.percent}%` }} />
            </div>
          )}
          {update.phase === "available" && update.error && (
            <p role="alert" className="text-2xs text-danger">
              {t("The download failed: {reason}", { reason: update.error })}
            </p>
          )}
          {update.notes.length > 0 && (
            <div data-testid="update-notes">
              <h4 className="pb-1 text-2xs font-medium text-muted">{t("What's new")}</h4>
              <div
                tabIndex={0}
                className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-border bg-canvas p-3 text-xs outline-none focus-visible:border-accent"
              >
                {update.notes.map((note) => (
                  <div key={note.version}>
                    <div className="font-medium">{note.version}</div>
                    {/* Plain text: main strips a feed's markup (ADR-0038). */}
                    <p className="whitespace-pre-wrap text-muted">{note.text}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
          {update.mode !== "off" && autoSwitch}
        </section>
      )}

      <section className="space-y-2 border-t border-border pt-3">
        <div className="flex flex-wrap gap-2">
          {LINKS.map((link) => (
            <Button
              key={link.target}
              size="sm"
              data-testid={`about-open-${link.target}`}
              onClick={() => openAppTarget(link.target)}
            >
              {link.label()}
            </Button>
          ))}
        </div>
        {problem && (
          <p role="alert" data-testid="about-problem" className="text-2xs text-danger">
            {problem}
          </p>
        )}
      </section>

      {info && (
        <section
          className="border-t border-border pt-3 text-2xs text-muted"
          data-testid="about-details"
        >
          {/* Technical names are not translated (ADR-0034). */}
          <p className="select-text">
            {[
              info.sidecarVersion && `Sidecar ${info.sidecarVersion}`,
              `Electron ${info.electron}`,
              `Chromium ${info.chrome}`,
              `Node ${info.node}`,
              info.platform,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p className="mt-1">{info.copyright}</p>
        </section>
      )}
    </div>
  )
}
