import { AppSwitchButton } from "@fastview/ui"
import { useEffect, useRef } from "react"
import { Group, Panel as ResizablePanel, Separator } from "react-resizable-panels"
import { bridge, isBridgeAvailable } from "../bridge"
import { switchToViewer as switchWithContext } from "../features/carry"
import {
  resetSplit,
  setActivePanel,
  setSplit,
  toggleActivePanel,
  usePanelsStore,
  type Side,
} from "../features/panels"
import { FunctionKeyBar } from "./FunctionKeyBar"
import { Panel, type PanelHandle } from "./Panel"
import { StatusBar } from "./StatusBar"

const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform)
export const SWITCH_SHORTCUT = IS_MAC ? "⌘⇧M" : "Ctrl+Shift+M"

/** Publishes the active panel's folder and cursor entry, then shows the viewer (C01). */
const switchToViewer = (): void => void switchWithContext().catch(() => undefined)

/** Ctrl/Cmd+Shift+M, as in the viewer (docs/shared/APP-SWITCHING.md). */
const isSwitchKey = (e: KeyboardEvent): boolean =>
  (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "m"

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

  // The active panel's list holds keyboard focus.
  useEffect(() => {
    lists.current[active]?.focus()
  }, [active])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (isSwitchKey(e)) {
        e.preventDefault()
        switchToViewer()
      } else if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        toggleActivePanel()
      } else if (FUNCTION_KEYS.has(e.key) && !e.altKey) {
        // Reserved for the file commands (Stages C04, C05); never the browser's defaults.
        e.preventDefault()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
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
    </div>
  )
}
