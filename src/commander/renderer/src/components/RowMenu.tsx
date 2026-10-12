import { formatChord, hasMarks } from "@panelyth/renderer-core"
import { useEffect } from "react"
import { createPortal } from "react-dom"
import { runPanelAction, useUiStore } from "../features/commands"
import { toolAction, useKeymapStore, type ActionId } from "../features/keymap"
import { useToolsStore } from "../features/tools"
import { enter, pageStoreOf, parentRows, useListingStore } from "../features/listing"
import { compareLabel } from "../features/compare"
import { countOf, marksOf } from "../features/marks"
import type { Side } from "../features/panels"
import { PopupMenu, type MenuEntry } from "./PopupMenu"
import { msg, t } from "@panelyth/i18n"

type Item = { action: ActionId; label: string } | "separator"

// Commands for the marked entries, or the cursor entry when nothing is marked.
const ENTRY_ITEMS: readonly Item[] = [
  { action: "files.view", label: msg("View") },
  { action: "files.edit", label: msg("Edit") },
  "separator",
  { action: "files.copy", label: msg("Copy to the other panel…") },
  { action: "files.move", label: msg("Move to the other panel…") },
  { action: "files.rename", label: msg("Rename") },
  { action: "files.multiRename", label: msg("Multi-rename…") },
  { action: "files.trash", label: msg("Delete") },
  "separator",
  { action: "clip.cut", label: msg("Cut") },
  { action: "clip.copy", label: msg("Copy") },
  { action: "clip.paste", label: msg("Paste") },
  "separator",
  { action: "copy.paths", label: msg("Copy full paths as text") },
  { action: "copy.names", label: msg("Copy names as text") },
  "separator",
  { action: "archive.pack", label: msg("Pack…") },
  { action: "archive.unpack", label: msg("Unpack…") },
  "separator",
  { action: "compare.content", label: msg("Compare by content") },
  { action: "hash.create", label: msg("Create checksums") },
  { action: "hash.verify", label: msg("Verify checksums") },
  "separator",
  { action: "files.mkdir", label: msg("New folder") },
  { action: "view.refresh", label: msg("Refresh") },
  "separator",
  { action: "files.attributes", label: msg("Change attributes…") },
  { action: "files.properties", label: msg("Properties") },
]

// Commands for the folder itself: "..", or the empty area below the entries.
const FOLDER_ITEMS: readonly Item[] = [
  { action: "clip.paste", label: msg("Paste") },
  "separator",
  { action: "files.mkdir", label: msg("New folder") },
  { action: "files.newText", label: msg("New text file") },
  { action: "view.refresh", label: msg("Refresh") },
  "separator",
  { action: "mark.all", label: msg("Mark all") },
  { action: "mark.invert", label: msg("Invert marks") },
  "separator",
  { action: "compare.dirs", label: msg("Compare directories") },
  { action: "compare.sync", label: msg("Synchronize directories") },
]

const MENU_WIDTH = 256
const ITEM_HEIGHT = 28
const SEPARATOR_HEIGHT = 9

/** What the entry commands will act on: "12 marked", or the cursor entry's name. */
function operandLabel(side: Side): string {
  const marks = marksOf(side)
  if (hasMarks(marks)) return t("{count} marked", { count: countOf(marks).toLocaleString() })
  const p = useListingStore.getState()[side]
  return pageStoreOf(side).getItem(p.cursor - parentRows(p))?.name ?? t("Entry")
}

/**
 * The context menu of a panel's entries (CFR-06, `useRightButton`): the
 * panel's own commands with their shortcuts. It acts like the keys do, on the
 * marks or else on the cursor entry, which the heading names. Modal: it sits
 * above everything in the window on a backdrop that takes every click and
 * wheel turn, so nothing behind it reacts until it closes.
 */
export function RowMenu({ side }: { side: Side }) {
  const menu = useUiStore((s) => (s.rowMenu?.side === side ? s.rowMenu : null))
  const chords = useKeymapStore((s) => s.keymap.chords)
  // The user's commands that ask for a place in the entry menu (Stage C10).
  const tools = useToolsStore((s) => s.commands)
  const open = menu !== null
  // The backdrop paints nothing, so Chromium would still scroll the list
  // behind it; a cancelling (non-passive) wheel listener stops that. The menu
  // itself may scroll when it is taller than the window.
  useEffect(() => {
    if (!open) return
    const onWheel = (e: WheelEvent): void => {
      if (!(e.target as Element | null)?.closest?.("[role=menu]")) e.preventDefault()
    }
    window.addEventListener("wheel", onWheel, { capture: true, passive: false })
    return () => window.removeEventListener("wheel", onWheel, { capture: true })
  }, [open])
  if (!menu) return null

  const entries: MenuEntry[] = menu.entry
    ? [
        { id: "operand", label: operandLabel(side), heading: true },
        { id: "open", label: "Open", detail: "Enter", onSelect: () => void enter(side) },
      ]
    : []
  let separators = 0
  for (const item of menu.entry ? ENTRY_ITEMS : FOLDER_ITEMS) {
    if (item === "separator") {
      entries.push({ id: `separator-${separators++}`, label: "", separator: true })
      continue
    }
    const chord = chords[item.action]?.[0]
    entries.push({
      id: item.action,
      // Compare by content says what it will compare (Stage C10.5).
      label: item.action === "compare.content" ? compareLabel(side) : t(item.label),
      detail: chord ? formatChord(chord) : undefined,
      onSelect: () => runPanelAction(side, item.action),
    })
  }

  const listed = menu.entry ? tools.filter((tool) => tool.menu) : []
  if (listed.length > 0) {
    entries.push({ id: `separator-${separators++}`, label: "", separator: true })
    for (const tool of listed) {
      const action = toolAction(tool.id)
      const chord = chords[action]?.[0]
      entries.push({
        id: action,
        label: tool.title,
        detail: chord ? formatChord(chord) : undefined,
        onSelect: () => runPanelAction(side, action),
      })
    }
  }

  const height =
    (entries.length - separators) * ITEM_HEIGHT + separators * SEPARATOR_HEIGHT + ITEM_HEIGHT / 2
  return createPortal(
    // A press on the backdrop closes the menu (PopupMenu) and goes no further.
    <div
      data-testid="row-menu-backdrop"
      className="fixed inset-0 z-50"
      onContextMenu={(e) => e.preventDefault()}
    >
      <PopupMenu
        label={menu.entry ? t("Entry commands") : t("Folder commands")}
        testId={`row-menu-${side}`}
        entries={entries}
        onClose={() => useUiStore.setState({ rowMenu: null })}
        className=""
        style={{
          left: Math.max(0, Math.min(menu.left, window.innerWidth - MENU_WIDTH)),
          top: Math.max(0, Math.min(menu.top, window.innerHeight - height)),
          maxHeight: "100%",
        }}
      />
    </div>,
    document.body,
  )
}
