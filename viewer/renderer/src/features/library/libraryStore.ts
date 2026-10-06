import type { Bookmark, Place, RecentFolder, SidecarStatus, Volume } from "@fastview/contracts"
import { create } from "zustand"
import { bridge } from "../../bridge"
import { useSidecarStore } from "../system/sidecarStore"

/**
 * Sidebar sources: places (Electron main), volumes (Go), bookmarks and
 * recent folders (library.db). All small lists.
 */
interface LibraryState {
  loaded: boolean
  places: Place[]
  volumes: Volume[]
  bookmarks: Bookmark[]
  recent: RecentFolder[]
  settings: Record<string, unknown>
}

const initial: LibraryState = {
  loaded: false,
  places: [],
  volumes: [],
  bookmarks: [],
  recent: [],
  settings: {},
}

export const useLibraryStore = create<LibraryState>(() => initial)

const set = useLibraryStore.setState
const get = useLibraryStore.getState

/** Shown in the sidebar; library.db keeps more. */
export const RECENT_SHOWN = 8

export function resetLibraryStore(): void {
  set(initial, true)
}

/** Loads everything once the sidecar is ready. Failures leave a section empty. */
export async function loadLibrary(): Promise<void> {
  const [places, volumes, library] = await Promise.allSettled([
    bridge.places(),
    bridge.volumes(),
    bridge.library(),
  ])
  set({
    loaded: true,
    places: places.status === "fulfilled" ? places.value : [],
    volumes: volumes.status === "fulfilled" ? volumes.value : [],
    ...(library.status === "fulfilled"
      ? {
          bookmarks: library.value.bookmarks,
          recent: library.value.recent,
          settings: library.value.settings,
        }
      : {}),
  })
}

/** A folder was opened: Go already recorded it; mirror it at the top of the list. */
export function noteRecent(path: string): void {
  const recent = get().recent.filter((r) => r.path !== path)
  set({ recent: [{ path, lastOpenedAt: Date.now() }, ...recent].slice(0, 20) })
}

export function isBookmarked(bookmarks: readonly Bookmark[], path: string): boolean {
  return bookmarks.some((b) => b.path === path)
}

export async function addBookmark(path: string): Promise<void> {
  const b = await bridge.addBookmark(path)
  if (!get().bookmarks.some((x) => x.id === b.id)) set({ bookmarks: [...get().bookmarks, b] })
}

export async function removeBookmark(id: number): Promise<void> {
  await bridge.removeBookmark(id)
  set({ bookmarks: get().bookmarks.filter((b) => b.id !== id) })
}

export async function toggleBookmark(path: string): Promise<void> {
  const existing = get().bookmarks.find((b) => b.path === path)
  if (existing) await removeBookmark(existing.id)
  else await addBookmark(path)
}

/**
 * Loads the library whenever the sidecar becomes ready (start or restart),
 * follows bookmark changes from either app (the commander's hotlist is this
 * list, Stage C03), and re-reads recent locations when the viewer is shown
 * again, since the commander adds to them too.
 */
export function startLibraryMonitoring(): () => void {
  let pid: number | null = null
  const check = (status: SidecarStatus | null): void => {
    if (status?.state !== "ready" || status.pid === pid) return
    pid = status.pid
    void loadLibrary()
  }
  check(useSidecarStore.getState().status)
  const offStatus = useSidecarStore.subscribe((s) => check(s.status))
  const offBookmarks = bridge.on("bookmarks.changed", ({ bookmarks }) => set({ bookmarks }))
  const offShown = bridge.on("app.visibility", ({ app, visible }) => {
    if (app !== "viewer" || !visible) return
    void bridge
      .library()
      .then((l) => set({ recent: l.recent, bookmarks: l.bookmarks }))
      .catch(() => undefined)
  })
  return () => {
    offStatus()
    offBookmarks()
    offShown()
  }
}
