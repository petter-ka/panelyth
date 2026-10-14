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
  openRemoteDir,
  parkSession,
  patch,
  releaseRemote,
  schedulePersist,
  setHidden,
  setRemoteHolders,
  showDisconnected,
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

/**
 * Where a tab is on a connection (Stage C10.5, ADR-0037). `remoteId` is 0
 * when the connection is not open, as after a restart: the tab then shows
 * "Not connected" and nothing connects until the user says so.
 */
export interface TabRemote {
  remoteId: number
  /** The saved connection it came from; null for a quick connect. */
  connectionId: number | null
  label: string
  host: string
  port: number
  user: string
  encrypted: boolean
  /** The folder on the server. */
  path: string
}

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
  /** The user's name for the tab (Stage C10.5); "" shows the folder's name. */
  title: string
  history: string[]
  historyIndex: number
  /** The entry under the cursor when the tab was left (restored on return). */
  cursorId: number | null
  /** On a connection: `path` is then the folder of this computer behind it. */
  remote: TabRemote | null
}

export interface PanelTabs {
  tabs: Tab[]
  /** Index of the visible tab. */
  active: number
}

export const MAX_TABS = 32
export const MAX_TAB_TITLE = 64
/** Closed tabs a panel can bring back (Ctrl+Shift+T); kept in memory only. */
export const MAX_CLOSED_TABS = 10

let nextId = 1

export function blankTab(over: Partial<Tab> = {}): Tab {
  return {
    id: nextId++,
    path: "",
    name: "",
    sort: DEFAULT_SORT,
    showHidden: true,
    view: "full",
    locked: false,
    title: "",
    history: [],
    historyIndex: -1,
    cursorId: null,
    remote: null,
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

// Closed tabs, newest last, with the place each had in its tab bar.
interface ClosedTab {
  tab: Omit<Tab, "id">
  index: number
}
const closed: Record<Side, ClosedTab[]> = { left: [], right: [] }

/** A tab without its id: what a closed tab, a copy or a saved set keeps. */
export function tabRecord(tab: Tab): Omit<Tab, "id"> {
  const { id, ...rest } = tab
  void id
  return rest
}

function remember(side: Side, tab: Tab, index: number): void {
  if (tab.path === "") return
  closed[side].push({ tab: tabRecord(tab), index })
  if (closed[side].length > MAX_CLOSED_TABS) closed[side].shift()
}

/** How many closed tabs "Reopen closed tab" can bring back. */
export const closedTabCount = (side: Side): number => closed[side].length

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
    remote:
      p.dirId === null
        ? current.remote
        : p.remote
          ? {
              remoteId: p.remote.remoteId,
              connectionId: p.remote.connectionId,
              label: p.remote.label,
              host: p.remote.host,
              port: p.remote.port,
              user: p.remote.user,
              encrypted: p.remote.encrypted,
              path: p.remote.path,
            }
          : p.disconnected
            ? { remoteId: 0, ...p.disconnected }
            : null,
  }
  const tabs = t.tabs.slice()
  tabs[t.active] = tab
  setSide(side, { ...t, tabs })
  return tab
}

/**
 * The connections that tabs which are not shown are on (listing.ts closes a
 * connection nothing shows). A closed tab holds none: brought back, it finds
 * its connection open or says "Not connected".
 */
function* heldRemotes(): Iterable<number> {
  const all = useTabsStore.getState()
  for (const side of ["left", "right"] as const) {
    const { tabs, active } = all[side]
    for (let i = 0; i < tabs.length; i++) {
      const id = tabs[i]!.remote?.remoteId
      if (i !== active && id) yield id
    }
  }
}

/** A tab went away: its connection closes when nothing else shows it. */
function released(tab: Pick<Tab, "remote">): void {
  if (tab.remote?.remoteId) releaseRemote(tab.remote.remoteId)
}

/**
 * A connection closed: tabs that were on it keep their place on the server
 * but are "Not connected" from now on.
 */
export function tabsDisconnected(remoteId: number): void {
  const gone = (r: TabRemote | null): TabRemote | null =>
    r && r.remoteId === remoteId ? { ...r, remoteId: 0 } : r
  for (const side of ["left", "right"] as const) {
    const t = get(side)
    if (t.tabs.some((tab) => tab.remote?.remoteId === remoteId)) {
      setSide(side, { ...t, tabs: t.tabs.map((tab) => ({ ...tab, remote: gone(tab.remote) })) })
    }
    for (const c of closed[side]) c.tab.remote = gone(c.tab.remote)
  }
  schedulePersist()
}

/**
 * Settings → Show hidden and system files: every panel and tab follows at
 * once (Ctrl+H still switches one panel). A tab not shown drops its parked
 * session, which was opened the other way.
 */
export function showHiddenEverywhere(showHidden: boolean): void {
  for (const side of ["left", "right"] as const) {
    const t = get(side)
    t.tabs.forEach((tab, i) => {
      if (i !== t.active && tab.showHidden !== showHidden) dropParked(tab.id)
    })
    setSide(side, { ...t, tabs: t.tabs.map((tab) => ({ ...tab, showHidden })) })
    for (const c of closed[side]) c.tab.showHidden = showHidden
    setHidden(side, showHidden)
  }
  schedulePersist()
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
  const remote = tab.remote
  await openPath(side, tab.path, {
    focusId: remote ? null : tab.cursorId,
    tabLoad: true,
    ...(tab.history.length > 0 && { historyIndex: tab.historyIndex }),
  })
  if (!remote || activeTab(side).id !== tab.id) return
  // A tab on a connection: its folder on the server again while the
  // connection is open; otherwise "Not connected". Nothing connects here.
  const { remoteId, path, ...rest } = remote
  if (remoteId === 0) showDisconnected(side, { ...rest, path })
  else {
    await openRemoteDir(side, { remoteId, ...rest }, path, {
      ...(tab.cursorId !== null && { focusId: tab.cursorId }),
    })
  }
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
export function newTab(side: Side, keepTitle = false): void {
  const t = get(side)
  if (t.tabs.length >= MAX_TABS) return
  const current = captureActive(side)
  const tab = blankTab({
    path: current.path,
    name: current.name,
    title: keepTitle ? current.title : "",
    sort: current.sort,
    showHidden: current.showHidden,
    view: current.view,
    history: current.history,
    historyIndex: current.historyIndex,
    cursorId: current.cursorId,
    remote: current.remote,
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
  // The visible tab is remembered as the panel shows it now.
  remember(side, index === t.active ? captureActive(side) : tab, index)
  const tabs = t.tabs.filter((_, i) => i !== index)
  dropParked(tab.id)
  if (index !== t.active) {
    setSide(side, { tabs, active: t.active - (index < t.active ? 1 : 0) })
    released(tab)
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
  const went: Tab[] = []
  const tabs = t.tabs.filter((tab, i) => {
    const stays = i === keep || tab.locked
    if (!stays) {
      dropParked(tab.id)
      remember(side, tab, i)
      went.push(tab)
    }
    return stays
  })
  setSide(side, { tabs, active: tabs.indexOf(kept) })
  went.forEach(released)
  schedulePersist()
}

/** The tab menu: every unlocked tab after this one closes. */
export async function closeTabsToRight(side: Side, index = get(side).active): Promise<void> {
  const goes = (tab: Tab, i: number): boolean => i > index && !tab.locked
  let t = get(side)
  if (!t.tabs[index] || !t.tabs.some(goes)) return
  // The visible tab is among them: the tab the command was given on shows first.
  if (goes(t.tabs[t.active]!, t.active)) {
    await activateTab(side, index)
    t = get(side)
  }
  const activeId = t.tabs[t.active]!.id
  const went: Tab[] = []
  const tabs = t.tabs.filter((tab, i) => {
    if (!goes(tab, i)) return true
    dropParked(tab.id)
    remember(side, tab, i)
    went.push(tab)
    return false
  })
  setSide(side, { tabs, active: tabs.findIndex((x) => x.id === activeId) })
  went.forEach(released)
  schedulePersist()
}

/**
 * Ctrl+Shift+T: the tab closed last comes back where it was and is shown.
 * Its folder is opened again; the session it had is gone.
 */
export async function reopenTab(side: Side): Promise<void> {
  if (get(side).tabs.length >= MAX_TABS) return
  const last = closed[side].pop()
  if (!last) return
  const leaving = captureActive(side)
  parkSession(side, leaving.id)
  const tabs = get(side).tabs.slice()
  const at = Math.min(last.index, tabs.length)
  const tab = blankTab(last.tab)
  tabs.splice(at, 0, tab)
  setSide(side, { tabs, active: at })
  await loadTab(side, tab)
}

// The tab whose name is being edited in the tab bar (a double-click, the tab menu, tab.rename).
export const useTabRenameStore = create<{ side: Side | null; tabId: number | null }>(() => ({
  side: null,
  tabId: null,
}))

export const startTabRename = (side: Side, tabId = activeTab(side).id): void =>
  useTabRenameStore.setState({ side, tabId })

export const stopTabRename = (): void => useTabRenameStore.setState({ side: null, tabId: null })

/** A name of the user's for a tab; "" shows the folder's name again. */
export function renameTab(side: Side, index: number, title: string): void {
  const t = get(side)
  const tab = t.tabs[index]
  const value = title.trim().slice(0, MAX_TAB_TITLE)
  if (!tab || tab.title === value) return
  const tabs = t.tabs.slice()
  tabs[index] = { ...tab, title: value }
  setSide(side, { ...t, tabs })
  schedulePersist()
}

/**
 * The tab menu: a copy of a tab right after it. A copy of the visible tab
 * is Ctrl+T's new tab; a copy of another tab waits as a record until shown.
 */
export function duplicateTab(side: Side, index = get(side).active): void {
  const t = get(side)
  const tab = t.tabs[index]
  if (!tab || t.tabs.length >= MAX_TABS) return
  if (index === t.active) {
    newTab(side, true)
    return
  }
  const tabs = t.tabs.slice()
  tabs.splice(index + 1, 0, blankTab({ ...tabRecord(tab), locked: false }))
  setSide(side, { tabs, active: t.active + (index < t.active ? 1 : 0) })
  schedulePersist()
}

/**
 * A saved tab set (tabsets.ts) opens in a panel: in place of its tabs, or
 * after them. Only the tab that becomes visible opens a session; the others
 * are records until shown (ADR-0028).
 */
export async function openTabs(
  side: Side,
  list: readonly Partial<Omit<Tab, "id">>[],
  active: number,
  mode: "replace" | "add",
): Promise<void> {
  if (list.length === 0) return
  const leaving = captureActive(side)
  const before = get(side)
  if (mode === "add") {
    const added = list.slice(0, MAX_TABS - before.tabs.length).map((x) => blankTab(x))
    if (added.length === 0) return
    parkSession(side, leaving.id)
    const shown = Math.max(0, Math.min(active, added.length - 1))
    setSide(side, { tabs: [...before.tabs, ...added], active: before.tabs.length + shown })
    await loadTab(side, added[shown]!)
    return
  }
  before.tabs.forEach((tab, i) => {
    dropParked(tab.id)
    remember(side, tab, i)
  })
  const tabs = list.slice(0, MAX_TABS).map((x) => blankTab(x))
  const shown = Math.max(0, Math.min(active, tabs.length - 1))
  setSide(side, { tabs, active: shown })
  await loadTab(side, tabs[shown]!)
  before.tabs.forEach(released)
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
  installRemoteHolders()
}

/** Ctrl+U: the tabs trade panels with everything else. */
export function swapTabs(): void {
  const { left, right } = useTabsStore.getState()
  useTabsStore.setState({ left: right, right: left })
  ;[closed.left, closed.right] = [closed.right, closed.left]
}

/** session.ts: restored tabs (ids are new each start). */
export function setTabs(side: Side, tabs: Omit<Tab, "id">[], active: number): void {
  const list = tabs.slice(0, MAX_TABS).map((t) => blankTab(t))
  if (list.length === 0) list.push(blankTab())
  setSide(side, { tabs: list, active: Math.max(0, Math.min(active, list.length - 1)) })
}

/** listing.ts asks which connections the tabs that are not shown still use. */
export function installRemoteHolders(): void {
  setRemoteHolders(heldRemotes)
}

/** Tests. */
export function resetTabs(): void {
  nextId = 1
  closed.left = []
  closed.right = []
  stopTabRename()
  useTabsStore.setState({ left: single(), right: single() })
}
