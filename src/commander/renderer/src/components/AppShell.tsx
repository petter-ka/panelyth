import { chordAllowedWhileTyping, eventChord } from "@panelyth/renderer-core"
import {
  AppLoadingOverlay,
  AppSwitcher,
  GlyphSprite,
  SeparatorReadout,
  ShortcutsDialog,
  TitleBar,
  TooltipProvider,
} from "@panelyth/ui"
import { archivePath, remoteUrl, useListingStore } from "../features/listing"
import { useEffect, useMemo, useRef, type ReactNode } from "react"
import { Group, Panel as ResizablePanel, Separator } from "react-resizable-panels"
import { bridge, isBridgeAvailable } from "../bridge"
import {
  editInViewer,
  switchToSystem as showSystem,
  switchToViewer as switchWithContext,
} from "../features/carry"
import { resetSplit, setActivePanel, setSplit, usePanelsStore, type Side } from "../features/panels"
import { TreePane } from "./TreePane"
import { runShellAction, useUiStore } from "../features/commands"
import {
  actionFor,
  resetAllBindings,
  resetBinding,
  setBinding,
  setHelpOpen,
  useKeymapStore,
} from "../features/keymap"
import { useDrivesStore } from "../features/drives"
import { useHotlistStore } from "../features/hotlist"
import { onSettingsWindowClosed, openSettings, useSettingsStore } from "../features/settings"
import { useFilesStore } from "../features/files"
import { useFindStore } from "../features/find"
import { useOpenStore } from "../features/open"
import { useQueueStore } from "../features/queue"
import { quickTarget, useViewersStore } from "../features/viewers"
import { CopyDialog, DeleteDialog, MkdirDialog } from "./FileDialogs"
import { PackDialog, UnpackDialog } from "./ArchiveDialogs"
import { useArchivesStore } from "../features/archives"
import { FindDialog } from "./FindDialog"
import { CommitDialog, DiscardDialog, HistoryDialog, NewBranchDialog } from "./GitDialogs"
import { SyncDialog } from "./SyncDialog"
import { DiffDialog } from "./DiffDialog"
import { CompareManyDialog } from "./CompareManyDialog"
import { ChecksumDialog } from "./ChecksumDialog"
import { useCompareStore } from "../features/compare"
import { MultiRenameDialog } from "./MultiRenameDialog"
import { AttributesDialog, PropertiesDialog } from "./AttributeDialogs"
import { useRenameStore } from "../features/rename"
import { useAttributesStore } from "../features/attributes"
import { Lister } from "./Lister"
import { NewFileDialog, ProgramDialog } from "./OpenDialogs"
import { QuickView } from "./QuickView"
import { ConflictDialog, JobDetailsDialog, ProgressDialog, QueuePanel } from "./QueuePanel"
import { FunctionKeyBar } from "./FunctionKeyBar"
import { CommandLine } from "./CommandLine"
import { QuickActionBar } from "./QuickActionBar"
import { HotlistDialog } from "./HotlistDialog"
import { MaskDialog } from "./MaskDialog"
import { Panel, type PanelHandle } from "./Panel"
import { SettingsDialog } from "./SettingsDialog"
import { TabSetDialogs } from "./TabSetDialogs"
import { RemoteDialogs } from "./ConnectionsDialog"
import { useTabRenameStore } from "../features/tabs"
import { useTabSetsStore } from "../features/tabsets"
import { StatusBar } from "./StatusBar"
import { CommanderTitleControls } from "./TitleControls"
import { MediaViewerOverlay } from "@panelyth/media-ui"
import { closeMediaViewer, jumpMediaViewer, stepMediaViewer } from "../features/viewers"
import { t } from "@panelyth/i18n"

const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform)
export const SWITCH_SHORTCUT = IS_MAC ? "⌘⇧M" : "Ctrl+Shift+M"

/** Publishes the active panel's folder and cursor entry, then shows the viewer (C01). */
const switchToViewer = (): void => void switchWithContext().catch(() => undefined)
const switchToSystem = (): void => void showSystem().catch(() => undefined)

const FUNCTION_KEYS = new Set(["F3", "F4", "F5", "F6", "F7", "F8"])

/**
 * The commander's shell (Stage C00, ADR-0028): app switcher rail, the toolbar,
 * two panels with a resizable divider, the queue, the command line, the
 * function-key bar and the status bar. The toolbar, the command line and the
 * function-key bar can be hidden (Stage C10).
 */
export function AppShell() {
  const active = usePanelsStore((s) => s.active)
  const split = usePanelsStore((s) => s.split)
  const layoutToken = usePanelsStore((s) => s.layoutToken)
  const quick = useViewersStore(quickTarget)
  const mediaViewer = useViewersStore((s) => s.mediaViewer)
  const showToolbar = useSettingsStore((s) => s.settings.showToolbar)
  const showCommandLine = useSettingsStore((s) => s.settings.showCommandLine)
  const showFunctionKeys = useSettingsStore((s) => s.settings.showFunctionKeys)
  const tree = usePanelsStore((s) => s.tree)
  const stacked = usePanelsStore((s) => s.arrangement === "stacked")
  // The active panel alone; quick view needs the other slot, so both show while it is open.
  const single = usePanelsStore((s) => s.arrangement === "single") && quick === null
  const lists = useRef<Record<Side, PanelHandle | null>>({ left: null, right: null })
  /** The border between the panels, for the size readout while it is hovered or dragged. */
  const splitBorder = useRef<HTMLDivElement>(null)

  // The active panel's list holds keyboard focus (unless a menu just took it:
  // Alt+F1 / Alt+F2 change the active panel and open the drive menu at once).
  // The folder tree keeps them too: a click in a panel's tree makes that panel active.
  useEffect(() => {
    if (document.activeElement?.closest("[role=menu], [role=tree]")) return
    lists.current[active]?.focus()
  }, [active])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // A dialog owns its keys (Tab moves between its fields).
      if (document.querySelector("[role=dialog]")) return
      const chord = eventChord(e)
      const action = chord ? actionFor("shell", chord) : undefined
      const typing = e.target instanceof HTMLInputElement
      if (action && (!typing || (chord && chordAllowedWhileTyping(chord)))) {
        e.preventDefault()
        runShellAction(action)
      } else if (FUNCTION_KEYS.has(e.key) && !e.altKey) {
        // Reserved for the file commands (Stages C04, C05); never the browser's defaults.
        e.preventDefault()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  // A dialog opened from the keyboard closed: the keys go back to the active panel.
  useEffect(() => {
    const focusActive = (): void => {
      // After the dialog's own focus restore (Radix defers it with a timeout).
      setTimeout(() => {
        if (document.querySelector('[role="dialog"], [role="menu"]')) return
        lists.current[usePanelsStore.getState().active]?.focus()
      }, 0)
    }
    const offMask = useUiStore.subscribe((s, prev) => {
      if (prev.mask && !s.mask) focusActive()
    })
    const offHelp = useKeymapStore.subscribe((s, prev) => {
      if (prev.helpOpen && !s.helpOpen) focusActive()
    })
    // Menus (drive, hotlist, history) and the C03 dialogs too.
    const offDrives = useDrivesStore.subscribe((s, prev) => {
      if (prev.menu && !s.menu) focusActive()
    })
    const offHotlist = useHotlistStore.subscribe((s, prev) => {
      const was = prev.menu ?? prev.history ?? prev.editing
      const is = s.menu ?? s.history ?? s.editing
      if (was && !is) focusActive()
    })
    const offSettings = useSettingsStore.subscribe((s, prev) => {
      if (prev.open && !s.open) focusActive()
    })
    const offSettingsWindow = onSettingsWindowClosed(focusActive)
    // The file-operation dialogs (Stage C04).
    const offFiles = useFilesStore.subscribe((s, prev) => {
      const was = prev.copy ?? prev.remove ?? prev.mkdir
      if (was && !(s.copy ?? s.remove ?? s.mkdir)) focusActive()
    })
    const offQueue = useQueueStore.subscribe((s, prev) => {
      if ((prev.answering !== null && s.answering === null) || (prev.details && !s.details))
        focusActive()
    })
    // Stage C05: the lister closed, Tab out of quick view, the open dialogs.
    const offViewers = useViewersStore.subscribe((s, prev) => {
      if (s.panelFocus !== prev.panelFocus) focusActive()
    })
    const offOpen = useOpenStore.subscribe((s, prev) => {
      if ((prev.program && !s.program) || (prev.newFile && !s.newFile)) focusActive()
    })
    // Stage C06: the find dialog.
    const offFind = useFindStore.subscribe((s, prev) => {
      if (prev.dialog && !s.dialog) focusActive()
    })
    // Stage C07: pack and unpack.
    const offArchives = useArchivesStore.subscribe((s, prev) => {
      if ((prev.pack ?? prev.unpack) && !(s.pack ?? s.unpack)) focusActive()
    })
    // Stage C08: synchronize, compare by content, create checksums.
    const offCompare = useCompareStore.subscribe((s, prev) => {
      if (
        (prev.sync ?? prev.diff ?? prev.hash ?? prev.many) &&
        !(s.sync ?? s.diff ?? s.hash ?? s.many)
      )
        focusActive()
    })
    // Stage C09: multi-rename, attributes, properties.
    const offRename = useRenameStore.subscribe((s, prev) => {
      if (prev.dialog && !s.dialog) focusActive()
    })
    const offAttributes = useAttributesStore.subscribe((s, prev) => {
      if ((prev.dialog ?? prev.properties) && !(s.dialog ?? s.properties)) focusActive()
    })
    // Stage C10.5: a tab's name edited in the tab bar, the tab set dialogs.
    const offTabRename = useTabRenameStore.subscribe((s, prev) => {
      if (prev.tabId !== null && s.tabId === null) focusActive()
    })
    const offTabSets = useTabSetsStore.subscribe((s, prev) => {
      if (prev.dialog && !s.dialog) focusActive()
    })
    return () => {
      offTabRename()
      offTabSets()
      offRename()
      offAttributes()
      offCompare()
      offArchives()
      offFind()
      offMask()
      offHelp()
      offDrives()
      offHotlist()
      offSettings()
      offSettingsWindow()
      offFiles()
      offQueue()
      offViewers()
      offOpen()
    }
  }, [])

  // Shown again by the app switch: focus the active panel, unless the user
  // is already typing in a field here (a slow start can report "shown"
  // after a path is being typed, and the blur would close the path editor).
  useEffect(() => {
    if (!isBridgeAvailable()) return
    return bridge.on("app.visibility", ({ app, visible }) => {
      if (app !== "commander" || !visible) return
      if (document.activeElement instanceof HTMLInputElement) return
      lists.current[usePanelsStore.getState().active]?.focus()
    })
  }, [])

  // A rebuilt panel group (another arrangement, a reset split) takes the
  // focused list with it: the keys go back to the active panel.
  const builtToken = useRef(layoutToken)
  useEffect(() => {
    if (builtToken.current === layoutToken) return
    builtToken.current = layoutToken
    const focused = document.activeElement
    if (focused && focused !== document.body) return
    lists.current[usePanelsStore.getState().active]?.focus()
  }, [layoutToken])

  const slots: Record<Side, ReactNode> = {
    left: (
      <PanelSlot key="left" side="left" quick={quick === "left"} tree={tree === "two"}>
        <Panel
          side="left"
          active={active === "left"}
          onActivate={() => setActivePanel("left")}
          ref={(el) => {
            lists.current.left = el
          }}
        />
      </PanelSlot>
    ),
    right: (
      <PanelSlot key="right" side="right" quick={quick === "right"} tree={tree === "two"}>
        <Panel
          side="right"
          active={active === "right"}
          onActivate={() => setActivePanel("right")}
          ref={(el) => {
            lists.current.right = el
          }}
        />
      </PanelSlot>
    ),
  }

  return (
    <TooltipProvider>
      <GlyphSprite />
      <div className="glass-shell relative grid h-full grid-cols-[2.75rem_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)]">
        <AppSwitcher
          current="commander"
          shortcut={SWITCH_SHORTCUT}
          onSwitch={(to) => (to === "system" ? switchToSystem() : switchToViewer())}
          onSettings={openSettings}
        />
        <CommanderTitleBar />
        <div className="glass-stack flex min-h-0 min-w-0 flex-col">
          {showToolbar && <QuickActionBar />}
          <div className="flex min-h-0 flex-1">
            {/* One tree for the active panel (Stage C10.5); a tree per panel sits in its slot. */}
            {tree === "one" && <TreePane id="one" />}
            <div className="min-h-0 min-w-0 flex-1">
              {single ? (
                // One panel across the window (the Single preset); Tab shows the other one here.
                slots[active]
              ) : (
                <Group
                  key={layoutToken}
                  id="panels"
                  // Side by side, or the left panel on top of the right one.
                  orientation={stacked ? "vertical" : "horizontal"}
                  defaultLayout={{ left: split, right: 100 - split }}
                  onLayoutChanged={(layout, meta) => {
                    const left = layout.left
                    if (meta.isUserInteraction && typeof left === "number") setSplit(left)
                  }}
                >
                  <ResizablePanel id="left" minSize="10%">
                    {slots.left}
                  </ResizablePanel>
                  <Separator
                    id="panels-separator"
                    elementRef={splitBorder}
                    aria-label={t("Resize panels")}
                    className={`${stacked ? "glass-gutter-y h-1" : "glass-gutter w-1"} bg-border outline-none hover:bg-accent focus-visible:bg-accent`}
                    onDoubleClick={resetSplit}
                  />
                  <SeparatorReadout separator={splitBorder} />
                  <ResizablePanel id="right" minSize="10%">
                    {slots.right}
                  </ResizablePanel>
                </Group>
              )}
            </div>
          </div>
          {/* One card for the bars at the bottom in the glass style (ADR-0041); no box of its own otherwise. */}
          <div
            className="glass-region glass-dock flex shrink-0 flex-col"
            data-glass-overflow="visible"
          >
            <QueuePanel />
            {showCommandLine && <CommandLine />}
            {showFunctionKeys && <FunctionKeyBar />}
            <StatusBar />
          </div>
        </div>
        {/* Over the panels while the commander starts or opens a folder carried over by a switch. */}
        <AppLoadingOverlay app="commander" />
        <CommanderShortcuts />
        <MaskDialog />
        <HotlistDialog />
        <CopyDialog />
        <DeleteDialog />
        <MkdirDialog />
        <CommitDialog />
        <DiscardDialog />
        <NewBranchDialog />
        <HistoryDialog />
        <PackDialog />
        <UnpackDialog />
        <ProgressDialog />
        <ConflictDialog />
        <JobDetailsDialog />
        <SettingsDialog />
        <TabSetDialogs />
        <RemoteDialogs />
        <ProgramDialog />
        <NewFileDialog />
        <FindDialog />
        <SyncDialog />
        <DiffDialog />
        <CompareManyDialog />
        <ChecksumDialog />
        <MultiRenameDialog />
        <AttributesDialog />
        <PropertiesDialog />
        <Lister />
        {mediaViewer && (
          <MediaViewerOverlay
            key={mediaViewer.item.id}
            item={mediaViewer.item}
            lane="cmd-open"
            onClose={closeMediaViewer}
            onStep={(direction) => void stepMediaViewer(direction)}
            onJump={(to) => void jumpMediaViewer(to)}
            onEdit={() => {
              const id = mediaViewer.item.id
              closeMediaViewer()
              void editInViewer(id).catch(() => undefined)
            }}
          />
        )}
      </div>
    </TooltipProvider>
  )
}

/** The title strip with the active panel's location, written as its path bar writes it. */
function CommanderTitleBar() {
  const active = usePanelsStore((s) => s.active)
  const location = useListingStore((s) => {
    const panel = s[active]
    if (panel.remote) return remoteUrl(panel.remote)
    return panel.archive ? archivePath(panel.path, panel.archive) : panel.path
  })
  return (
    <TitleBar
      title="Panelyth Commander"
      detail={location || null}
      controls={<CommanderTitleControls />}
    />
  )
}

/**
 * A panel, or quick view in its place (Stage C05). The panel stays mounted
 * underneath (its listing, scroll and cursor are kept) but inert.
 */
function PanelSlot({
  side,
  quick,
  tree,
  children,
}: {
  side: Side
  quick: boolean
  /** A folder tree of its own beside the panel (Stage C10.5). */
  tree: boolean
  children: ReactNode
}) {
  return (
    <div className="flex h-full" data-slot={side}>
      {tree && <TreePane id={side} />}
      <div className="relative h-full min-w-0 flex-1">
        <div className={quick ? "invisible h-full" : "h-full"} inert={quick}>
          {children}
        </div>
        {quick && (
          <div className="absolute inset-0">
            <QuickView />
          </div>
        )}
      </div>
    </div>
  )
}

/** F1 / Ctrl+/: the commander's shortcuts on the dialog shared with the viewer. */
function CommanderShortcuts() {
  const open = useKeymapStore((s) => s.helpOpen)
  const chords = useKeymapStore((s) => s.keymap.chords)
  const overrides = useKeymapStore((s) => s.overrides.bindings)
  // The built-in actions and the user's commands (Stage C10).
  const actions = useKeymapStore((s) => s.actions)
  const customized = useMemo(() => new Set(Object.keys(overrides)), [overrides])
  return (
    <ShortcutsDialog
      open={open}
      onOpenChange={setHelpOpen}
      actions={actions}
      chords={chords}
      customized={customized}
      onSet={setBinding}
      onReset={resetBinding}
      onResetAll={resetAllBindings}
    />
  )
}
