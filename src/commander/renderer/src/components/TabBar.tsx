import { useRef, useState } from "react"
import { formatChord } from "@panelyth/renderer-core"
import { Tooltip } from "@panelyth/ui"
import { useKeymapStore } from "../features/keymap"
import { useListingStore } from "../features/listing"
import { setActivePanel, type Side } from "../features/panels"
import { useSettingsStore } from "../features/settings"
import {
  activateTab,
  closedTabCount,
  closeOtherTabs,
  closeTab,
  closeTabsToRight,
  duplicateTab,
  MAX_TAB_TITLE,
  MAX_TABS,
  moveTab,
  newTab,
  renameTab,
  reopenTab,
  startTabRename,
  stopTabRename,
  toggleLock,
  useTabRenameStore,
  useTabsStore,
} from "../features/tabs"
import { openSaveTabs, openTabSets } from "../features/tabsets"
import { tabTarget } from "../features/files"
import { dropTarget } from "./panelDnd"
import { PopupMenu } from "./PopupMenu"
import { t } from "@panelyth/i18n"

/**
 * Folder tabs of a panel (Stage C03, CFR-08): click to show, middle-click or
 * × to close, drag to reorder, right-click for the tab's commands. A locked
 * tab shows a lock glyph. Since Stage C10.5 the bar is always there (a
 * setting hides it while a panel has one tab) and ends with a "+" button;
 * a double-click renames a tab.
 */
export function TabBar({ side }: { side: Side }) {
  const tabs = useTabsStore((s) => s[side].tabs)
  const active = useTabsStore((s) => s[side].active)
  const liveName = useListingStore((s) => s[side].name)
  // A tab on a connection is called by the connection (Stage C10.5).
  const liveRemote = useListingStore(
    (s) => s[side].remote?.label ?? s[side].disconnected?.label ?? null,
  )
  const mode = useSettingsStore((s) => s.settings.tabBar)
  const renaming = useTabRenameStore((s) => (s.side === side ? s.tabId : null))
  const newChord = useKeymapStore((s) => s.keymap.chords["tab.new"]?.[0])
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [menu, setMenu] = useState<number | null>(null)
  if (mode === "multiple" && tabs.length < 2) return null
  const full = tabs.length >= MAX_TABS
  return (
    <div
      data-testid={`tabs-${side}`}
      className="relative flex h-7 shrink-0 items-end gap-px border-b border-border bg-chrome px-1 text-2xs"
    >
      <div
        role="tablist"
        aria-label={side === "left" ? t("Left panel tabs") : t("Right panel tabs")}
        className="flex min-w-0 items-end gap-px overflow-x-auto"
      >
        {tabs.map((tab, index) => {
          const selected = index === active
          const remote = selected ? liveRemote : (tab.remote?.label ?? null)
          const folder = remote ?? ((selected ? liveName : tab.name) || tab.path || t("New tab"))
          const name = tab.title || folder
          const files = dropTarget(side, () => tabTarget(side, index))
          return (
            <Tooltip key={tab.id} content={tab.title ? `${tab.title} · ${tab.path}` : tab.path}>
              <div
                role="tab"
                aria-selected={selected}
                data-testid={`tab-${side}-${index}`}
                data-locked={tab.locked || undefined}
                draggable={renaming !== tab.id}
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
                onDoubleClick={() => startTabRename(side, tab.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu(index)
                }}
                className={`group/tab flex h-6 max-w-40 min-w-0 shrink-0 cursor-default items-center gap-1 rounded-t border border-b-0 px-2 font-medium ${selected ? "border-border bg-canvas text-text" : "border-transparent text-muted hover:bg-raised hover:text-text"}`}
              >
                {tab.locked && (
                  <span aria-label={t("Locked")} className="text-muted">
                    🔒︎
                  </span>
                )}
                {renaming === tab.id ? (
                  <TabTitleField
                    initial={name}
                    onDone={(title) => {
                      // The folder's own name back in the field means "no title".
                      if (title !== null) renameTab(side, index, title === folder ? "" : title)
                      stopTabRename()
                    }}
                  />
                ) : (
                  <span className="truncate">{name}</span>
                )}
                {!tab.locked && tabs.length > 1 && renaming !== tab.id && (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={t("Close {name}", { name })}
                    onMouseDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      void closeTab(side, index)
                    }}
                    className={`ml-0.5 size-4 place-items-center rounded text-muted hover:bg-raised hover:text-text ${selected ? "grid" : "hidden group-hover/tab:grid"}`}
                  >
                    ×
                  </button>
                )}
              </div>
            </Tooltip>
          )
        })}
      </div>
      <Tooltip content={newChord ? `${t("New tab")} (${formatChord(newChord)})` : t("New tab")}>
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("New tab")}
          data-testid={`tab-new-${side}`}
          disabled={full}
          onMouseDown={() => setActivePanel(side)}
          onClick={() => newTab(side)}
          className="mb-0.5 grid size-5 shrink-0 place-items-center rounded text-sm leading-none text-muted hover:bg-raised hover:text-text disabled:opacity-40"
        >
          +
        </button>
      </Tooltip>
      {menu !== null && tabs[menu] && (
        <PopupMenu
          label={t("Tab")}
          testId={`tab-menu-${side}`}
          className="top-7 left-2"
          onClose={() => setMenu(null)}
          entries={[
            {
              id: "rename",
              label: t("Rename tab…"),
              onSelect: () => startTabRename(side, tabs[menu]!.id),
            },
            {
              id: "duplicate",
              label: t("Duplicate tab"),
              disabled: full,
              onSelect: () => duplicateTab(side, menu),
            },
            {
              id: "lock",
              label: tabs[menu].locked ? t("Unlock tab") : t("Lock tab"),
              onSelect: () => toggleLock(side, menu),
            },
            { id: "s1", label: "", separator: true },
            {
              id: "close",
              label: t("Close tab"),
              disabled: tabs[menu].locked || tabs.length < 2,
              onSelect: () => void closeTab(side, menu),
            },
            {
              id: "others",
              label: t("Close other tabs"),
              disabled: tabs.length < 2,
              onSelect: () => closeOtherTabs(side, menu),
            },
            {
              id: "right",
              label: t("Close tabs to the right"),
              disabled: menu >= tabs.length - 1,
              onSelect: () => void closeTabsToRight(side, menu),
            },
            {
              id: "reopen",
              label: t("Reopen closed tab"),
              disabled: closedTabCount(side) === 0 || full,
              onSelect: () => void reopenTab(side),
            },
            { id: "s2", label: "", separator: true },
            { id: "save", label: t("Save tabs…"), onSelect: () => openSaveTabs(side) },
            { id: "sets", label: t("Tab sets…"), onSelect: () => openTabSets(side) },
          ]}
        />
      )}
    </div>
  )
}

/** The name of a tab being edited in place: Enter or leaving the field keeps it, Esc does not. */
function TabTitleField({
  initial,
  onDone,
}: {
  initial: string
  onDone(title: string | null): void
}) {
  const [value, setValue] = useState(initial)
  // Esc removes the field, which may still report a blur: only the first answer counts.
  const answered = useRef(false)
  const done = (title: string | null): void => {
    if (answered.current) return
    answered.current = true
    onDone(title)
  }
  return (
    <input
      autoFocus
      aria-label={t("Tab name")}
      value={value}
      maxLength={MAX_TAB_TITLE}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => done(value)}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Enter") {
          e.preventDefault()
          e.currentTarget.blur()
        } else if (e.key === "Escape") {
          e.preventDefault()
          done(null)
        }
      }}
      className="h-5 w-28 min-w-0 rounded-sm border border-accent bg-canvas px-1 text-2xs text-text outline-none"
    />
  )
}
