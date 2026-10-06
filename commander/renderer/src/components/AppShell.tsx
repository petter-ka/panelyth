import { chordAllowedWhileTyping, eventChord } from "@fastview/renderer-core"
import { AppSwitchButton, ShortcutsDialog } from "@fastview/ui"
import { useEffect, useMemo, useRef } from "react"
import { Group, Panel as ResizablePanel, Separator } from "react-resizable-panels"
import { bridge, isBridgeAvailable } from "../bridge"
import { switchToViewer as switchWithContext } from "../features/carry"
import { resetSplit, setActivePanel, setSplit, usePanelsStore, type Side } from "../features/panels"
import { runShellAction, useUiStore } from "../features/commands"
import {
  ACTIONS,
  actionFor,
  resetAllBindings,
  resetBinding,
  setBinding,
  setHelpOpen,
  useKeymapStore,
} from "../features/keymap"
import { useDrivesStore } from "../features/drives"
import { useHotlistStore } from "../features/hotlist"
import { useSettingsStore } from "../features/settings"
import { FunctionKeyBar } from "./FunctionKeyBar"
import { HotlistDialog } from "./HotlistDialog"
import { MaskDialog } from "./MaskDialog"
import { Panel, type PanelHandle } from "./Panel"
import { SettingsDialog } from "./SettingsDialog"
import { StatusBar } from "./StatusBar"

const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform)
export const SWITCH_SHORTCUT = IS_MAC ? "⌘⇧M" : "Ctrl+Shift+M"

/** Publishes the active panel's folder and cursor entry, then shows the viewer (C01). */
const switchToViewer = (): void => void switchWithContext().catch(() => undefined)

const FUNCTION_KEYS = new Set(["F3", "F4", "F5", "F6", "F7", "F8"])

/**
 * The commander's shell (Stage C00, ADR-0028): app bar with the switch to the
 * viewer, two panels with a resizable divider, the function-key bar and the
 * status bar.
 */
export function AppShell() {
  const active = usePanelsStore((s) => s.active)
  const split = usePanelsStore((s) => s.split)
  const layoutToken = usePanelsStore((s) => s.layoutToken)
  const lists = useRef<Record<Side, PanelHandle | null>>({ left: null, right: null })

  // The active panel's list holds keyboard focus (unless a menu just took it:
  // Alt+F1 / Alt+F2 change the active panel and open the drive menu at once).
  useEffect(() => {
    if (document.activeElement?.closest("[role=menu]")) return
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
      setTimeout(() => lists.current[usePanelsStore.getState().active]?.focus(), 0)
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
    return () => {
      offMask()
      offHelp()
      offDrives()
      offHotlist()
      offSettings()
    }
  }, [])

  // Shown again by the app switch: focus the active panel.
  useEffect(() => {
    if (!isBridgeAvailable()) return
    return bridge.on("app.visibility", ({ app, visible }) => {
      if (app === "commander" && visible) lists.current[usePanelsStore.getState().active]?.focus()
    })
  }, [])

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)_auto_auto]">
      <div
        role="toolbar"
        aria-label="App bar"
        className="flex h-10 items-center gap-1.5 border-b border-border bg-chrome px-2"
      >
        <AppSwitchButton target="viewer" shortcut={SWITCH_SHORTCUT} onSwitch={switchToViewer} />
      </div>
      <Group
        key={layoutToken}
        id="panels"
        orientation="horizontal"
        defaultLayout={{ left: split, right: 100 - split }}
        onLayoutChanged={(layout, meta) => {
          const left = layout.left
          if (meta.isUserInteraction && typeof left === "number") setSplit(left)
        }}
        className="min-h-0"
      >
        <ResizablePanel id="left" minSize="10%">
          <Panel
            side="left"
            active={active === "left"}
            onActivate={() => setActivePanel("left")}
            ref={(el) => {
              lists.current.left = el
            }}
          />
        </ResizablePanel>
        <Separator
          id="panels-separator"
          aria-label="Resize panels"
          className="w-1 bg-border outline-none hover:bg-accent focus-visible:bg-accent"
          onDoubleClick={resetSplit}
        />
        <ResizablePanel id="right" minSize="10%">
          <Panel
            side="right"
            active={active === "right"}
            onActivate={() => setActivePanel("right")}
            ref={(el) => {
              lists.current.right = el
            }}
          />
        </ResizablePanel>
      </Group>
      <FunctionKeyBar />
      <StatusBar />
      <CommanderShortcuts />
      <MaskDialog />
      <HotlistDialog />
      <SettingsDialog />
    </div>
  )
}

/** F1 / Ctrl+/: the commander's shortcuts on the dialog shared with the viewer. */
function CommanderShortcuts() {
  const open = useKeymapStore((s) => s.helpOpen)
  const chords = useKeymapStore((s) => s.keymap.chords)
  const overrides = useKeymapStore((s) => s.overrides.bindings)
  const customized = useMemo(() => new Set(Object.keys(overrides)), [overrides])
  return (
    <ShortcutsDialog
      open={open}
      onOpenChange={setHelpOpen}
      actions={ACTIONS}
      chords={chords}
      customized={customized}
      onSet={setBinding}
      onReset={resetBinding}
      onResetAll={resetAllBindings}
    />
  )
}
