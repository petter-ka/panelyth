import { useMemo } from "react"
import {
  addCurrentFolder,
  closeMenus,
  groupBookmarks,
  isBookmarked,
  openLocation,
  setHotlistEditing,
  useHotlistStore,
} from "../features/hotlist"
import { jumpHistory, useListingStore } from "../features/listing"
import type { Side } from "../features/panels"
import { PopupMenu, type MenuEntry } from "./PopupMenu"

/** Recent locations shown in the history menu; library.db keeps more. */
export const RECENT_SHOWN = 10

/**
 * Ctrl+D (Stage C03, CFR-10): the directory hotlist, which is the viewer's
 * bookmark list; groups are a commander addition.
 */
export function HotlistMenu({ side }: { side: Side }) {
  const open = useHotlistStore((s) => s.menu === side)
  const bookmarks = useHotlistStore((s) => s.bookmarks)
  const path = useListingStore((s) => s[side].path)
  const entries = useMemo<MenuEntry[]>(() => {
    const out: MenuEntry[] = [
      {
        id: "add",
        label: "Add the current folder",
        disabled: !path || bookmarks.some((b) => b.path === path),
        accessKey: "a",
        onSelect: () => void addCurrentFolder(side).catch(() => undefined),
      },
      { id: "edit", label: "Configure…", accessKey: "c", onSelect: () => setHotlistEditing(true) },
    ]
    for (const [group, list] of groupBookmarks(bookmarks)) {
      out.push({ id: `g-${group}`, label: group || "Hotlist", heading: true })
      for (const b of list) {
        out.push({
          id: `b-${b.id}`,
          label: b.label,
          detail: b.path,
          current: b.path === path,
          onSelect: () => void openLocation(side, b.path),
        })
      }
    }
    if (bookmarks.length === 0) {
      out.push({ id: "empty", label: "No folders yet", disabled: true })
    }
    return out
  }, [bookmarks, path, side])
  if (!open) return null
  return (
    <PopupMenu
      label="Directory hotlist"
      testId={`hotlist-${side}`}
      className="top-9 left-2"
      entries={entries}
      onClose={closeMenus}
    />
  )
}

/**
 * Alt+↓ (Stage C03, CFR-10): this tab's folder history (newest first), then
 * the recent locations both apps feed.
 */
export function HistoryMenu({ side }: { side: Side }) {
  const open = useHotlistStore((s) => s.history === side)
  const recent = useHotlistStore((s) => s.recent)
  const history = useListingStore((s) => s[side].history)
  const historyIndex = useListingStore((s) => s[side].historyIndex)
  const path = useListingStore((s) => s[side].path)
  const entries = useMemo<MenuEntry[]>(() => {
    const out: MenuEntry[] = [{ id: "h-history", label: "History", heading: true }]
    for (let i = history.length - 1; i >= 0; i--) {
      out.push({
        id: `h-${i}`,
        label: history[i],
        current: i === historyIndex,
        onSelect: () => void jumpHistory(side, i),
      })
    }
    const others = recent.filter((r) => r.path !== path).slice(0, RECENT_SHOWN)
    if (others.length > 0) {
      out.push({ id: "h-recent", label: "Recent (both apps)", heading: true })
      for (const r of others) {
        out.push({
          id: `r-${r.path}`,
          label: r.path,
          detail: isBookmarked(r.path) ? "★" : undefined,
          onSelect: () => void openLocation(side, r.path),
        })
      }
    }
    return out
  }, [history, historyIndex, recent, path, side])
  if (!open) return null
  return (
    <PopupMenu
      label="Folder history"
      testId={`history-${side}`}
      className="top-9 left-2"
      entries={entries}
      onClose={closeMenus}
    />
  )
}
