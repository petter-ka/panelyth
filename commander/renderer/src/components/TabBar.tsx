import { useState } from "react"
import { useListingStore } from "../features/listing"
import { setActivePanel, type Side } from "../features/panels"
import {
  activateTab,
  closeOtherTabs,
  closeTab,
  moveTab,
  toggleLock,
  useTabsStore,
} from "../features/tabs"
import { tabTarget } from "../features/files"
import { dropTarget } from "./panelDnd"
import { PopupMenu } from "./PopupMenu"

/**
 * Folder tabs of a panel (Stage C03, CFR-08), shown once a panel has more
 * than one: click to show, middle-click or × to close, drag to reorder,
 * right-click for lock and close others. A locked tab shows a lock glyph.
 */
export function TabBar({ side }: { side: Side }) {
  const tabs = useTabsStore((s) => s[side].tabs)
  const active = useTabsStore((s) => s[side].active)
  const liveName = useListingStore((s) => s[side].name)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [menu, setMenu] = useState<number | null>(null)
  if (tabs.length < 2) return null
  return (
    <div
      role="tablist"
      aria-label={`${side === "left" ? "Left" : "Right"} panel tabs`}
      data-testid={`tabs-${side}`}
      className="relative flex h-7 shrink-0 items-end gap-px overflow-x-auto border-b border-border bg-chrome px-1 text-[0.6875rem]"
    >
      {tabs.map((tab, index) => {
        const selected = index === active
        const name = (selected ? liveName : tab.name) || tab.path || "New tab"
        const files = dropTarget(side, () => tabTarget(side, index))
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={selected}
            data-testid={`tab-${side}-${index}`}
            data-locked={tab.locked || undefined}
            title={tab.path}
            draggable
            onDragStart={(e) => {
              setDragFrom(index)
              e.dataTransfer.effectAllowed = "move"
            }}
            onDragOver={(e) => {
              if (dragFrom !== null) e.preventDefault()
              else files.onDragOver(e) // panel items dropped on a tab: its folder
            }}
            onDrop={(e) => {
              if (dragFrom === null) return files.onDrop(e)
              e.preventDefault()
              moveTab(side, dragFrom, index)
              setDragFrom(null)
            }}
            onDragEnd={() => setDragFrom(null)}
            onMouseDown={(e) => {
              setActivePanel(side)
              if (e.button === 1) {
                e.preventDefault()
                void closeTab(side, index)
              }
            }}
            onClick={() => void activateTab(side, index)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu(index)
            }}
            className={`group/tab flex h-6 max-w-40 min-w-0 cursor-default items-center gap-1 rounded-t border border-b-0 px-2 ${selected ? "border-border bg-canvas text-text" : "border-transparent text-muted hover:bg-raised hover:text-text"}`}
          >
            {tab.locked && (
              <span aria-label="Locked" className="text-muted">
                🔒︎
              </span>
            )}
            <span className="truncate">{name}</span>
            {!tab.locked && (
              <button
                type="button"
                tabIndex={-1}
                aria-label={`Close ${name}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  void closeTab(side, index)
                }}
                className="ml-0.5 hidden size-4 place-items-center rounded text-muted group-hover/tab:grid hover:bg-raised hover:text-text"
              >
                ×
              </button>
            )}
          </div>
        )
      })}
      {menu !== null && tabs[menu] && (
        <PopupMenu
          label="Tab"
          testId={`tab-menu-${side}`}
          className="top-7 left-2"
          onClose={() => setMenu(null)}
          entries={[
            {
              id: "lock",
              label: tabs[menu].locked ? "Unlock tab" : "Lock tab",
              onSelect: () => toggleLock(side, menu),
            },
            {
              id: "close",
              label: "Close tab",
              disabled: tabs[menu].locked,
              onSelect: () => void closeTab(side, menu),
            },
            {
              id: "others",
              label: "Close other tabs",
              onSelect: () => closeOtherTabs(side, menu),
            },
          ]}
        />
      )}
    </div>
  )
}
