import { useCallback, useEffect, useRef, useState } from "react"
import {
  AppLoadingOverlay,
  AppSwitcher,
  GlyphSprite,
  SeparatorReadout,
  Tooltip,
  TooltipProvider,
} from "@panelyth/ui"
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
import { EditorOverlay } from "../components/editor/EditorOverlay"
import { registerPaneControls } from "../features/workspace/paneControls"
import { setPanes, usePaneStore } from "../features/workspace/workspace"
import { useGlobalShortcuts } from "./shortcuts"
import { DialogWindow } from "../components/ui/dialog"
import { Button } from "../components/ui/button"
import { ChevronDownIcon } from "../components/ui/icons"
import { openSettings, useSettingsStore } from "../features/settings/settingsStore"
import { useViewerStore } from "../features/viewer/viewerStore"
import { useShortcutHint } from "../features/shortcuts/shortcutStore"
import { switchToCommander } from "../features/workspace/appSwitch"
import { t } from "@panelyth/i18n"

const separator =
  "glass-gutter relative w-px bg-border outline-none after:absolute after:inset-y-0 after:-left-1 after:w-2 data-[separator=active]:bg-accent data-[separator=hover]:bg-muted focus-visible:bg-accent"
const stackedSeparator =
  "glass-gutter-y relative h-px bg-border outline-none after:absolute after:-top-1 after:right-0 after:left-0 after:h-2 data-[separator=active]:bg-accent data-[separator=hover]:bg-muted focus-visible:bg-accent"

/** The three-column layout keeps its sizes apart from the two-column one's. */
const RIGHT = "right:"

/** The saved sizes of a group's panels (`prefix` + panel id); with a prefix, all of them or none. */
function groupLayout(
  panes: Record<string, number> | null,
  ids: readonly string[],
  prefix = "",
): Record<string, number> | undefined {
  if (!panes) return undefined
  const entries: [string, number][] = []
  for (const id of ids) {
    const size = panes[prefix + id]
    if (size !== undefined) entries.push([id, size])
  }
  if (prefix !== "" && entries.length < ids.length) return undefined
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

function saveGroupLayout(layout: Record<string, number>, prefix = ""): void {
  const saved = Object.fromEntries(Object.entries(layout).map(([id, size]) => [prefix + id, size]))
  setPanes({ ...(usePaneStore.getState().panes ?? {}), ...saved })
}

/**
 * The workspace (ADR-0023): the folder tree above the preview in the left
 * column with the content on the right, or, with the switch in the sidebar
 * header, the preview as a full-height third column on the right. Every
 * group saves its layout with the workspace when a resize ends.
 */
export function AppShell() {
  const panes = usePaneStore((s) => s.panes)
  const applyToken = usePaneStore((s) => s.applyToken)
  const previewRight = usePaneStore((s) => s.previewPlace === "right")
  const sidebar = useRef<PanelImperativeHandle>(null)
  const preview = useRef<PanelImperativeHandle>(null)
  // The borders, for the size readout shown while one is hovered or dragged.
  const treeBorder = useRef<HTMLDivElement>(null)
  const sidebarBorder = useRef<HTMLDivElement>(null)
  const previewBorder = useRef<HTMLDivElement>(null)
  const [confirmExit, setConfirmExit] = useState(false)
  const [treeSize, setTreeSize] = useState(panes?.tree ?? 62)
  const [previewCollapsed, setPreviewCollapsed] = useState(panes?.preview === 0)
  const outerIds = previewRight ? ["sidebar", "content", "preview"] : ["sidebar", "content"]
  const outerPrefix = previewRight ? RIGHT : ""
  const commanderEnabled = canSwitchApps()
  const appSwitchShortcut = useShortcutHint("app.switch")
  useGlobalShortcuts()

  const requestExit = useCallback(() => {
    if (useSettingsStore.getState().settings.confirmOnEscapeExit) setConfirmExit(true)
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
          if (panel.isCollapsed()) {
            panel.expand()
            if (id === "preview") setPreviewCollapsed(false)
          } else {
            panel.collapse()
            if (id === "preview") setPreviewCollapsed(true)
          }
        },
        expand(id) {
          const panel = (id === "sidebar" ? sidebar : preview).current
          if (panel?.isCollapsed()) panel.expand()
        },
      }),
    [],
  )

  // A layout applied from library.db (or reset) resets the pane state during render.
  const [applied, setApplied] = useState({ applyToken, panes })
  if (applied.applyToken !== applyToken || applied.panes !== panes) {
    setApplied({ applyToken, panes })
    setTreeSize(panes?.tree ?? 62)
    setPreviewCollapsed(panes?.preview === 0)
  }

  const syncLeftLayout = useCallback((layout: Record<string, number>) => {
    if (layout.tree !== undefined) setTreeSize(layout.tree)
    if (layout.preview !== undefined) setPreviewCollapsed(layout.preview === 0)
  }, [])

  return (
    <TooltipProvider>
      <GlyphSprite />
      <div
        className={`glass-shell relative grid h-full ${commanderEnabled ? "grid-cols-[2.75rem_minmax(0,1fr)]" : "grid-cols-1"} grid-rows-[minmax(0,1fr)_auto]`}
      >
        {commanderEnabled && (
          <AppSwitcher
            current="viewer"
            shortcut={appSwitchShortcut ?? "Ctrl+Shift+M"}
            onSwitch={switchToCommander}
            onSettings={openSettings}
          />
        )}
        {/* A layout applied from library.db (or reset) remounts the group with it. */}
        <Group
          key={`${applyToken}-${previewRight}`}
          id="workspace"
          orientation="horizontal"
          defaultLayout={groupLayout(panes, outerIds, outerPrefix)}
          onLayoutChanged={(layout, meta) => {
            if (meta.isUserInteraction) saveGroupLayout(meta.requestedLayout ?? layout, outerPrefix)
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
            {previewRight ? (
              <SidebarPane />
            ) : (
              <div className="relative h-full min-h-0 overflow-visible">
                <Group
                  id="left-column"
                  orientation="vertical"
                  defaultLayout={
                    panes && panes.tree !== undefined && panes.preview !== undefined
                      ? groupLayout(panes, ["tree", "preview"])
                      : undefined
                  }
                  onLayoutChange={syncLeftLayout}
                  onLayoutChanged={(layout, meta) => {
                    syncLeftLayout(layout)
                    if (meta.isUserInteraction) saveGroupLayout(meta.requestedLayout ?? layout)
                  }}
                  className="h-full min-h-0"
                >
                  <Panel id="tree" defaultSize="62%" minSize={140}>
                    <SidebarPane />
                  </Panel>
                  <Separator
                    id="tree-preview-separator"
                    elementRef={treeBorder}
                    aria-label={t("Resize folder tree and preview")}
                    className={stackedSeparator}
                  />
                  <SeparatorReadout separator={treeBorder} />
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
                <Tooltip content={previewCollapsed ? t("Expand preview") : t("Collapse preview")}>
                  <button
                    type="button"
                    aria-label={
                      previewCollapsed ? t("Expand preview pane") : t("Collapse preview pane")
                    }
                    aria-expanded={!previewCollapsed}
                    aria-controls="preview"
                    onClick={() => {
                      const panel = preview.current
                      if (!panel) return
                      if (panel.isCollapsed()) {
                        panel.expand()
                        setPreviewCollapsed(false)
                      } else {
                        panel.collapse()
                        setPreviewCollapsed(true)
                      }
                    }}
                    className="glass-chip glass-pill absolute left-1/2 z-20 grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-md border border-border bg-chrome text-muted shadow-sm hover:bg-raised hover:text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                    style={{
                      top: treeSize >= 98 ? "calc(100% - 14px)" : `${treeSize}%`,
                    }}
                  >
                    <ChevronDownIcon
                      className={`transition-transform duration-[var(--motion-fast)] ${previewCollapsed ? "rotate-180" : ""}`}
                    />
                  </button>
                </Tooltip>
              </div>
            )}
          </Panel>
          <Separator
            id="sidebar-separator"
            elementRef={sidebarBorder}
            aria-label={t("Resize left column")}
            className={separator}
          />
          <SeparatorReadout separator={sidebarBorder} />
          <Panel id="content" minSize={360}>
            <ContentPane />
          </Panel>
          {previewRight && (
            <>
              <Separator
                id="preview-separator"
                elementRef={previewBorder}
                aria-label={t("Resize preview column")}
                className={separator}
              />
              <SeparatorReadout separator={previewBorder} />
              <Panel
                id="preview"
                panelRef={preview}
                defaultSize={340}
                minSize={220}
                maxSize={900}
                collapsible
                groupResizeBehavior="preserve-pixel-size"
              >
                <PreviewPane />
              </Panel>
            </>
          )}
        </Group>
        <StatusBar />
        {/* Over the content while a folder carried over by an app switch opens. */}
        <AppLoadingOverlay app="viewer" rail={commanderEnabled} />
        <ViewerOverlay />
        <EditorOverlay />
        <Notice />
        <PropertiesDialog />
        <JobDialogs />
        <ShortcutsDialog />
        <SettingsDialog />
        <DialogWindow
          open={confirmExit}
          onOpenChange={setConfirmExit}
          title={t("Close Panelyth?")}
          description={t("Panelyth will close.")}
        >
          <div className="flex justify-end gap-2">
            <Button autoFocus onClick={() => setConfirmExit(false)}>
              {t("Cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmExit(false)
                void bridge.quit().catch(() => undefined)
              }}
            >
              {t("Close app")}
            </Button>
          </div>
        </DialogWindow>
      </div>
    </TooltipProvider>
  )
}
