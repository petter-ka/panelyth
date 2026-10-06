import { useCallback, useEffect, useRef, useState } from "react"
import { AppSwitcher } from "@fastview/ui"
import { Group, Panel, Separator, type PanelImperativeHandle } from "react-resizable-panels"
import { bridge, canSwitchApps } from "../bridge"
import { ContentPane } from "../components/ContentPane"
import { JobDialogs } from "../components/jobs/JobDialogs"
import { PropertiesDialog } from "../components/PropertiesDialog"
import { ShortcutsDialog } from "../components/ShortcutsDialog"
import { SettingsDialog } from "../components/SettingsDialog"
import { PreviewPane } from "../components/PreviewPane"
import { SidebarPane } from "../components/SidebarPane"
import { Notice } from "../components/Notice"
import { StatusBar } from "../components/StatusBar"
import { ViewerOverlay } from "../components/viewer/ViewerOverlay"
import { registerPaneControls } from "../features/workspace/paneControls"
import { setPanes, usePaneStore } from "../features/workspace/workspace"
import { useGlobalShortcuts } from "./shortcuts"
import { DialogWindow } from "../components/ui/dialog"
import { Button } from "../components/ui/button"
import { useSettingsStore } from "../features/settings/settingsStore"
import { useViewerStore } from "../features/viewer/viewerStore"
import { useShortcutHint } from "../features/shortcuts/shortcutStore"
import { switchToCommander } from "../features/workspace/appSwitch"

const separator =
  "relative w-px bg-border outline-none after:absolute after:inset-y-0 after:-left-1 after:w-2 data-[separator=active]:bg-accent data-[separator=hover]:bg-muted focus-visible:bg-accent"
const stackedSeparator =
  "relative h-px bg-border outline-none after:absolute after:-top-1 after:right-0 after:left-0 after:h-2 data-[separator=active]:bg-accent data-[separator=hover]:bg-muted focus-visible:bg-accent"

function groupLayout(
  panes: Record<string, number> | null,
  ids: readonly string[],
): Record<string, number> | undefined {
  if (!panes) return undefined
  const entries: [string, number][] = []
  for (const id of ids) {
    const size = panes[id]
    if (size !== undefined) entries.push([id, size])
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function saveGroupLayout(layout: Record<string, number>): void {
  setPanes({ ...(usePaneStore.getState().panes ?? {}), ...layout })
}

/**
 * Two-column workspace (ADR-0023): folder tree above preview in the left
 * column, with content on the right. Both groups save their layout with the
 * workspace when a resize ends.
 */
export function AppShell() {
  const panes = usePaneStore((s) => s.panes)
  const applyToken = usePaneStore((s) => s.applyToken)
  const sidebar = useRef<PanelImperativeHandle>(null)
  const preview = useRef<PanelImperativeHandle>(null)
  const [confirmExit, setConfirmExit] = useState(false)
  const commanderEnabled = canSwitchApps()
  const appSwitchShortcut = useShortcutHint("app.switch")
  useGlobalShortcuts()

  const requestExit = useCallback(() => {
    if (useSettingsStore.getState().preferences.confirmOnEscapeExit) setConfirmExit(true)
    else void bridge.quit().catch(() => undefined)
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      if (useViewerStore.getState().open || document.fullscreenElement) return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      if (
        e.target instanceof HTMLElement &&
        (e.target.isContentEditable || e.target.matches("input, textarea, select"))
      )
        return
      e.preventDefault()
      requestExit()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [requestExit])

  useEffect(
    () =>
      registerPaneControls({
        toggle(id) {
          const panel = (id === "sidebar" ? sidebar : preview).current
          if (!panel) return
          if (panel.isCollapsed()) panel.expand()
          else panel.collapse()
        },
        expand(id) {
          const panel = (id === "sidebar" ? sidebar : preview).current
          if (panel?.isCollapsed()) panel.expand()
        },
      }),
    [],
  )

  return (
    <div
      className={`grid h-full ${commanderEnabled ? "grid-cols-[2.75rem_minmax(0,1fr)]" : "grid-cols-1"} grid-rows-[minmax(0,1fr)_auto]`}
    >
      {commanderEnabled && (
        <AppSwitcher
          current="viewer"
          shortcut={appSwitchShortcut ?? "Ctrl+Shift+M"}
          onSwitch={switchToCommander}
        />
      )}
      {/* A layout applied from library.db (or reset) remounts the group with it. */}
      <Group
        key={applyToken}
        id="workspace"
        orientation="horizontal"
        defaultLayout={groupLayout(panes, ["sidebar", "content"])}
        onLayoutChanged={(layout, meta) => {
          if (meta.isUserInteraction) saveGroupLayout(meta.requestedLayout ?? layout)
        }}
        className="min-h-0"
      >
        <Panel
          id="sidebar"
          panelRef={sidebar}
          defaultSize={240}
          minSize={180}
          maxSize={480}
          collapsible
          groupResizeBehavior="preserve-pixel-size"
        >
          <Group
            id="left-column"
            orientation="vertical"
            defaultLayout={
              panes && panes.tree !== undefined && panes.preview !== undefined
                ? groupLayout(panes, ["tree", "preview"])
                : undefined
            }
            onLayoutChanged={(layout, meta) => {
              if (meta.isUserInteraction) saveGroupLayout(meta.requestedLayout ?? layout)
            }}
            className="h-full min-h-0"
          >
            <Panel id="tree" defaultSize="62%" minSize={140}>
              <SidebarPane />
            </Panel>
            <Separator
              id="tree-preview-separator"
              aria-label="Resize folder tree and preview"
              className={stackedSeparator}
            />
            <Panel
              id="preview"
              panelRef={preview}
              defaultSize="38%"
              minSize={160}
              collapsible
              groupResizeBehavior="preserve-pixel-size"
            >
              <PreviewPane />
            </Panel>
          </Group>
        </Panel>
        <Separator id="sidebar-separator" aria-label="Resize left column" className={separator} />
        <Panel id="content" minSize={360}>
          <ContentPane />
        </Panel>
      </Group>
      <StatusBar />
      <ViewerOverlay />
      <Notice />
      <PropertiesDialog />
      <JobDialogs />
      <ShortcutsDialog />
      <SettingsDialog />
      <DialogWindow
        open={confirmExit}
        onOpenChange={setConfirmExit}
        title="Close FastView?"
        description="FastView will close."
      >
        <div className="flex justify-end gap-2">
          <Button autoFocus onClick={() => setConfirmExit(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setConfirmExit(false)
              void bridge.quit().catch(() => undefined)
            }}
          >
            Close app
          </Button>
        </div>
      </DialogWindow>
    </div>
  )
}
