import { formatChord, hasMarks } from "@panelyth/renderer-core"
import { useEffect } from "react"
import { createPortal } from "react-dom"
import { runPanelAction, useUiStore } from "../features/commands"
import { useKeymapStore, type ActionId } from "../features/keymap"
import { enter, pageStoreOf, parentRows, useListingStore } from "../features/listing"
import { countOf, marksOf } from "../features/marks"
import type { Side } from "../features/panels"
import { PopupMenu, type MenuEntry } from "./PopupMenu"

type Item = { action: ActionId; label: string } | "separator"

// Commands for the marked entries, or the cursor entry when nothing is marked.
const ENTRY_ITEMS: readonly Item[] = [
  { action: "files.view", label: "View" },
  { action: "files.edit", label: "Edit" },
  "separator",
  { action: "files.copy", label: "Copy to the other panel…" },
  { action: "files.move", label: "Move to the other panel…" },
  { action: "files.rename", label: "Rename" },
  { action: "files.trash", label: "Delete" },
  "separator",
  { action: "clip.cut", label: "Cut" },
  { action: "clip.copy", label: "Copy" },
  { action: "clip.paste", label: "Paste" },
  "separator",
  { action: "copy.paths", label: "Copy full paths as text" },
  { action: "copy.names", label: "Copy names as text" },
  "separator",
  { action: "archive.pack", label: "Pack…" },
  { action: "archive.unpack", label: "Unpack…" },
  "separator",
  { action: "files.mkdir", label: "New folder" },
  { action: "view.refresh", label: "Refresh" },
]

// Commands for the folder itself: "..", or the empty area below the entries.
const FOLDER_ITEMS: readonly Item[] = [
  { action: "clip.paste", label: "Paste" },
  "separator",
  { action: "files.mkdir", label: "New folder" },
  { action: "files.newText", label: "New text file" },
  { action: "view.refresh", label: "Refresh" },
  "separator",
  { action: "mark.all", label: "Mark all" },
  { action: "mark.invert", label: "Invert marks" },
]

const MENU_WIDTH = 256
const ITEM_HEIGHT = 28
const SEPARATOR_HEIGHT = 9

/** What the entry commands will act on: "12 marked", or the cursor entry's name. */
function operandLabel(side: Side): string {
  const marks = marksOf(side)
  if (hasMarks(marks)) return `${countOf(marks).toLocaleString()} marked`
  const p = useListingStore.getState()[side]
  return pageStoreOf(side).getItem(p.cursor - parentRows(p))?.name ?? "Entry"
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
      label: item.label,
      detail: chord ? formatChord(chord) : undefined,
      onSelect: () => runPanelAction(side, item.action),
    })
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
        label={menu.entry ? "Entry commands" : "Folder commands"}
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
