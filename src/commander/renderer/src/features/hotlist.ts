import type { Bookmark, RecentFolder } from "@panelyth/contracts"
import { create } from "zustand"
import { bridge, isBridgeAvailable } from "../bridge"
import { refusedOnConnection } from "./files"
import { openPath, useListingStore } from "./listing"
import { setActivePanel, type Side } from "./panels"

// The directory hotlist (Stage C03, CFR-10): the bookmarks shared with the
// viewer (one list in library.db; the commander adds groups), and the
// history menu (Alt+↓): the tab's own history plus the recent locations
// both apps feed. Go sends the whole bookmark list after every change
// (bookmarks.changed), so an edit in either app shows in both.

interface HotlistState {
  bookmarks: Bookmark[]
  recent: RecentFolder[]
  /** The hotlist menu (Ctrl+D), when open. */
  menu: Side | null
  /** The history menu (Alt+↓), when open. */
  history: Side | null
  /** The hotlist editor dialog. */
  editing: boolean
}

export const useHotlistStore = create<HotlistState>(() => ({
  bookmarks: [],
  recent: [],
  menu: null,
  history: null,
  editing: false,
}))

const set = useHotlistStore.setState
const get = useHotlistStore.getState

/** Re-reads bookmarks and recent locations from library.db. */
export async function loadHotlist(): Promise<void> {
  if (!isBridgeAvailable()) return
  const { bookmarks, recent } = await bridge.libraryNow()
  set({ bookmarks, recent })
}

/** Groups in first-seen order; "" (no group) first. */
export function groupBookmarks(bookmarks: readonly Bookmark[]): [string, Bookmark[]][] {
  const groups = new Map<string, Bookmark[]>([["", []]])
  for (const b of bookmarks) {
    const list = groups.get(b.group)
    if (list) list.push(b)
    else groups.set(b.group, [b])
  }
  return [...groups].filter(([, list]) => list.length > 0)
}

export function openHotlist(side: Side): void {
  setActivePanel(side)
  set({ menu: side, history: null })
  void loadHotlist().catch(() => undefined)
}

export function openHistoryMenu(side: Side): void {
  setActivePanel(side)
  set({ history: side, menu: null })
  void loadHotlist().catch(() => undefined)
}

export const closeMenus = (): void => set({ menu: null, history: null })

export const setHotlistEditing = (editing: boolean): void => set({ editing, menu: null })

/** A hotlist or recent entry: the folder opens in the panel. */
export function openLocation(side: Side, path: string): Promise<void> {
  closeMenus()
  return openPath(side, path)
}

/** "Add the current folder": appended to the shared list (no group). */
export async function addCurrentFolder(side: Side, group = ""): Promise<Bookmark | null> {
  closeMenus()
  // The hotlist holds folders of this computer; servers are saved as connections.
  if (refusedOnConnection(side)) return null
  const { path } = useListingStore.getState()[side]
  if (!path) return null
  const b = await bridge.addBookmark(path, "", group)
  if (!get().bookmarks.some((x) => x.id === b.id)) set({ bookmarks: [...get().bookmarks, b] })
  return b
}

export async function saveBookmark(b: Bookmark): Promise<Bookmark> {
  const saved = await bridge.updateBookmark(b)
  set({ bookmarks: get().bookmarks.map((x) => (x.id === saved.id ? saved : x)) })
  return saved
}

export async function removeBookmark(id: number): Promise<void> {
  await bridge.removeBookmark(id)
  set({ bookmarks: get().bookmarks.filter((b) => b.id !== id) })
}

/** Move up / down in the editor: one step in the shared order. */
export async function moveBookmark(id: number, step: -1 | 1): Promise<void> {
  const list = get().bookmarks.slice()
  const from = list.findIndex((b) => b.id === id)
  const to = from + step
  if (from < 0 || to < 0 || to >= list.length) return
  const [b] = list.splice(from, 1)
  list.splice(to, 0, b!)
  set({ bookmarks: list })
  await bridge.reorderBookmarks(list.map((x) => x.id))
}

export function isBookmarked(path: string): boolean {
  return get().bookmarks.some((b) => b.path === path)
}

/** Follows bookmarks.changed (either app) and reads the list once. */
export function startHotlist(): () => void {
  if (!isBridgeAvailable()) return () => undefined
  void loadHotlist().catch(() => undefined)
  return bridge.on("bookmarks.changed", ({ bookmarks }) => set({ bookmarks }))
}

/** Tests. */
export function resetHotlist(): void {
  set({ bookmarks: [], recent: [], menu: null, history: null, editing: false })
}
