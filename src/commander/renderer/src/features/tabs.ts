import type { SortKey } from "@panelyth/contracts"
import { create } from "zustand"
import {
  adoptSession,
  cancelNavigation,
  cursorEntryId,
  DEFAULT_SORT,
  dropParked,
  openHome,
  openPath,
  parkSession,
  patch,
  schedulePersist,
  useListingStore,
  type ViewMode,
} from "./listing"
import type { Side } from "./panels"
import { closeQuickSearch } from "./quicksearch"

// Folder tabs per panel (Stage C03, CFR-08, ADR-0028). The visible tab's
// live state is the panel's listing state; the others are small records
// (folder, sort, view, history, cursor entry). Only the visible tab holds a
// query session: a tab being left parks its session for a grace period
// (listing.ts), then it closes.

export interface Tab {
  id: number
  path: string
  /** The folder's display name, from Go when the tab was last shown. */
  name: string
  sort: SortKey
  showHidden: boolean
  view: ViewMode
  /** A locked tab keeps its folder: navigating away opens a new tab. */
  locked: boolean
  history: string[]
  historyIndex: number
  /** The entry under the cursor when the tab was left (restored on return). */
  cursorId: number | null
}

export interface PanelTabs {
  tabs: Tab[]
  /** Index of the visible tab. */
  active: number
}

export const MAX_TABS = 32

let nextId = 1

export function blankTab(over: Partial<Tab> = {}): Tab {
  return {
    id: nextId++,
    path: "",
    name: "",
    sort: DEFAULT_SORT,
    showHidden: false,
    view: "full",
    locked: false,
    history: [],
    historyIndex: -1,
    cursorId: null,
    ...over,
  }
}

const single = (): PanelTabs => ({ tabs: [blankTab()], active: 0 })

export const useTabsStore = create<Record<Side, PanelTabs>>(() => ({
  left: single(),
  right: single(),
}))

const get = (side: Side): PanelTabs => useTabsStore.getState()[side]
const setSide = (side: Side, value: PanelTabs): void => useTabsStore.setState({ [side]: value })

export const activeTab = (side: Side): Tab => {
  const t = get(side)
  return t.tabs[t.active]!
}

/** The visible tab's record, brought up to date from the panel. */
export function captureActive(side: Side): Tab {
  const t = get(side)
  const p = useListingStore.getState()[side]
  const current = t.tabs[t.active]!
  const tab: Tab = {
    ...current,
    path: p.path || current.path,
    name: p.name || current.name,
    sort: p.sort,
    showHidden: p.showHidden,
    view: p.view,
    history: p.history,
    historyIndex: p.historyIndex,
    cursorId: p.dirId === null ? current.cursorId : cursorEntryId(side),
  }
  const tabs = t.tabs.slice()
  tabs[t.active] = tab
  setSide(side, { ...t, tabs })
  return tab
}

/** Shows a tab in its panel: its parked session if still open, else its folder again. */
async function loadTab(side: Side, tab: Tab): Promise<void> {
  closeQuickSearch()
  cancelNavigation(side)
  patch(side, {
    sort: tab.sort,
    showHidden: tab.showHidden,
    view: tab.view,
    history: tab.history,
    historyIndex: tab.historyIndex,
    error: null,
  })
  schedulePersist()
  if (adoptSession(side, tab.id, tab.cursorId)) return
  if (!tab.path) return openHome(side)
  await openPath(side, tab.path, {
    focusId: tab.cursorId,
    tabLoad: true,
    ...(tab.history.length > 0 && { historyIndex: tab.historyIndex }),
  })
}

/** Ctrl+Tab, a click on a tab: that tab becomes visible; the one left is parked. */
export async function activateTab(side: Side, index: number): Promise<void> {
  const t = get(side)
  if (index === t.active || !t.tabs[index]) return
  const leaving = captureActive(side)
  parkSession(side, leaving.id)
  setSide(side, { ...get(side), active: index })
  await loadTab(side, get(side).tabs[index]!)
}

/** Ctrl+Tab / Ctrl+Shift+Tab: the next or previous tab, wrapping. */
export function cycleTab(side: Side, step: 1 | -1): Promise<void> {
  const t = get(side)
  if (t.tabs.length < 2) return Promise.resolve()
  return activateTab(side, (t.active + step + t.tabs.length) % t.tabs.length)
}

/**
 * Ctrl+T: a new tab on the same folder, right after the current one. The
 * new tab takes over the visible session (same folder, nothing to load);
 * the old tab reopens its folder when shown again.
 */
export function newTab(side: Side): void {
  const t = get(side)
  if (t.tabs.length >= MAX_TABS) return
  const current = captureActive(side)
  const tab = blankTab({
    path: current.path,
    name: current.name,
    sort: current.sort,
    showHidden: current.showHidden,
    view: current.view,
    history: current.history,
    historyIndex: current.historyIndex,
    cursorId: current.cursorId,
  })
  const tabs = get(side).tabs.slice()
  tabs.splice(t.active + 1, 0, tab)
  setSide(side, { tabs, active: t.active + 1 })
  schedulePersist()
}

/** Ctrl+W, a tab's close button: closes it (never the last one, never a locked one). */
export async function closeTab(side: Side, index = get(side).active): Promise<void> {
  const t = get(side)
  const tab = t.tabs[index]
  if (!tab || t.tabs.length < 2 || tab.locked) return
  const tabs = t.tabs.filter((_, i) => i !== index)
  dropParked(tab.id)
  if (index !== t.active) {
    setSide(side, { tabs, active: t.active - (index < t.active ? 1 : 0) })
    schedulePersist()
    return
  }
  // The visible tab: its neighbor shows, and its session closes when replaced.
  const active = Math.min(index, tabs.length - 1)
  setSide(side, { tabs, active })
  await loadTab(side, tabs[active]!)
}

/** The tab menu: every other unlocked tab closes. */
export function closeOtherTabs(side: Side, keep = get(side).active): void {
  const t = get(side)
  const kept = t.tabs[keep]
  if (!kept) return
  if (keep !== t.active) {
    void activateTab(side, keep).then(() => closeOtherTabs(side, get(side).active))
    return
  }
  const tabs = t.tabs.filter((tab, i) => {
    const stays = i === keep || tab.locked
    if (!stays) dropParked(tab.id)
    return stays
  })
  setSide(side, { tabs, active: tabs.indexOf(kept) })
  schedulePersist()
}

export function toggleLock(side: Side, index = get(side).active): void {
  const t = get(side)
  const tab = t.tabs[index]
  if (!tab) return
  const tabs = t.tabs.slice()
  tabs[index] = { ...tab, locked: !tab.locked }
  setSide(side, { ...t, tabs })
  schedulePersist()
}

/** Drag and drop in the tab bar. */
export function moveTab(side: Side, from: number, to: number): void {
  const t = get(side)
  if (from === to || !t.tabs[from] || to < 0 || to >= t.tabs.length) return
  const activeId = t.tabs[t.active]!.id
  const tabs = t.tabs.slice()
  const [tab] = tabs.splice(from, 1)
  tabs.splice(to, 0, tab!)
  setSide(side, { tabs, active: tabs.findIndex((x) => x.id === activeId) })
  schedulePersist()
}

/**
 * Before the panel shows another folder: in a locked tab, the new folder
 * branches off into a new tab after it (Total Commander's locked tabs).
 * The locked tab keeps its folder; its session is parked like any tab left.
 */
function onFolderChange(side: Side): void {
  if (!activeTab(side).locked) return
  const t = get(side)
  if (t.tabs.length >= MAX_TABS) return
  const locked = captureActive(side)
  parkSession(side, locked.id)
  const tab = blankTab({
    sort: locked.sort,
    showHidden: locked.showHidden,
    view: locked.view,
    history: locked.history,
    historyIndex: locked.historyIndex,
  })
  const tabs = get(side).tabs.slice()
  tabs.splice(t.active + 1, 0, tab)
  setSide(side, { tabs, active: t.active + 1 })
}

export function installTabHooks(setHook: (hook: ((side: Side) => void) | null) => void): void {
  setHook(onFolderChange)
}

/** Ctrl+U: the tabs trade panels with everything else. */
export function swapTabs(): void {
  const { left, right } = useTabsStore.getState()
  useTabsStore.setState({ left: right, right: left })
}

/** session.ts: restored tabs (ids are new each start). */
export function setTabs(side: Side, tabs: Omit<Tab, "id">[], active: number): void {
  const list = tabs.slice(0, MAX_TABS).map((t) => blankTab(t))
  if (list.length === 0) list.push(blankTab())
  setSide(side, { tabs: list, active: Math.max(0, Math.min(active, list.length - 1)) })
}

/** Tests. */
export function resetTabs(): void {
  nextId = 1
  useTabsStore.setState({ left: single(), right: single() })
}
