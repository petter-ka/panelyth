import { MAX_REMOTE_HOST_CHARS, MAX_REMOTE_PATH_CHARS, type SortKey } from "@panelyth/contracts"
import { bridge } from "../bridge"
import {
  hasNavigated,
  openFolderEntry,
  openHome,
  openPath,
  patch,
  readView,
  readColumnOrder,
  readColumnPinning,
  readColumnVisibility,
  readColumns,
  readSort,
  setFolderChangeHook,
  setPersistHandler,
  showDisconnected,
  SIDES,
  useListingStore,
  type DisconnectedLocation,
  type ColumnWidths,
  type ColumnLayout,
  type ViewMode,
} from "./listing"
import { usePanelsStore, type Side } from "./panels"
import { readSettings, SETTINGS_KEY, SETTINGS_VERSION } from "./settings"
import {
  captureActive,
  installTabHooks,
  MAX_TAB_TITLE,
  MAX_TABS,
  setTabs,
  useTabsStore,
  type Tab,
} from "./tabs"

// Session restore (Stage C03): both panels with their tabs, views, sorts,
// column widths, histories and cursor entries, in commander.panels. Since
// Stage C10.5 (v3) a tab also keeps the title the user gave it, and a tab on
// a connection keeps where it was on the server: no password, and nothing
// that connects by itself (ADR-0037).

export const PANELS_KEY = "commander.panels"
const MAX_STORED_HISTORY = 50

export interface StoredTab {
  path: string
  name: string
  sort: SortKey
  showHidden: boolean
  view: ViewMode
  locked: boolean
  /** v3; "" in older sessions. */
  title: string
  history: string[]
  historyIndex: number
  cursorId: number | null
  /** v3: the tab was on a connection; restored as "Not connected". */
  remote?: DisconnectedLocation
}

export interface StoredPanel {
  tabs: StoredTab[]
  active: number
  columns: ColumnWidths
  columnOrder: ColumnLayout["order"]
  columnVisibility: ColumnLayout["visibility"]
  columnPinning: ColumnLayout["pinning"]
}

export interface StoredPanels {
  v: 3
  active: Side
  left?: StoredPanel
  right?: StoredPanel
}

const isPath = (v: unknown): v is string => typeof v === "string" && v !== "" && v.length < 32_768

const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max

/** Where a tab was on a server; anything of another shape is dropped. */
function readRemote(v: unknown): DisconnectedLocation | null {
  const r = (v ?? {}) as Partial<Record<keyof DisconnectedLocation, unknown>>
  if (!isText(r.host, MAX_REMOTE_HOST_CHARS) || r.host === "") return null
  if (typeof r.port !== "number" || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535)
    return null
  if (!isText(r.path, MAX_REMOTE_PATH_CHARS) || !r.path.startsWith("/")) return null
  const saved = typeof r.connectionId === "number" && Number.isSafeInteger(r.connectionId)
  return {
    connectionId: saved && (r.connectionId as number) > 0 ? (r.connectionId as number) : null,
    label: isText(r.label, 512) ? r.label : r.host,
    host: r.host,
    port: r.port,
    user: isText(r.user, 255) ? r.user : "",
    encrypted: r.encrypted === true,
    path: r.path,
  }
}

export function readTab(v: unknown): StoredTab | null {
  const t = (v ?? {}) as Partial<Record<keyof StoredTab, unknown>>
  if (!isPath(t.path)) return null
  const history = Array.isArray(t.history)
    ? t.history.filter(isPath).slice(-MAX_STORED_HISTORY)
    : []
  const index = typeof t.historyIndex === "number" ? Math.trunc(t.historyIndex) : -1
  return {
    path: t.path,
    name: typeof t.name === "string" ? t.name : "",
    sort: readSort(t.sort),
    showHidden: t.showHidden === true,
    view: readView(t.view),
    locked: t.locked === true,
    title: typeof t.title === "string" ? t.title.trim().slice(0, MAX_TAB_TITLE) : "",
    history,
    historyIndex: history.length === 0 ? -1 : Math.max(0, Math.min(index, history.length - 1)),
    cursorId:
      typeof t.cursorId === "number" && Number.isSafeInteger(t.cursorId) && t.cursorId > 0
        ? t.cursorId
        : null,
    ...(t.remote !== undefined && readRemote(t.remote) && { remote: readRemote(t.remote)! }),
  }
}

/**
 * Validated stored panels; unknown shapes fall back to defaults. Reads v2
 * (C03, tabs without titles) and v1 (C01–C02, one folder per panel).
 */
export function readStoredPanels(value: unknown): StoredPanels {
  const v = (value ?? {}) as Record<string, unknown>
  const out: StoredPanels = { v: 3, active: v.active === "right" ? "right" : "left" }
  for (const side of SIDES) {
    const p = (v[side] ?? {}) as Record<string, unknown>
    if (v.v === 1) {
      const tab = readTab({ ...p, history: [], view: "full" })
      if (tab) {
        out[side] = {
          tabs: [tab],
          active: 0,
          columns: readColumns(p.columns),
          columnOrder: readColumnOrder(p.columnOrder),
          columnVisibility: readColumnVisibility(p.columnVisibility),
          columnPinning: readColumnPinning(p.columnPinning),
        }
      }
      continue
    }
    if ((v.v !== 2 && v.v !== 3) || !Array.isArray(p.tabs)) continue
    const tabs = p.tabs
      .slice(0, MAX_TABS)
      .map(readTab)
      .filter((t) => t !== null)
    if (tabs.length === 0) continue
    const active = typeof p.active === "number" ? Math.trunc(p.active) : 0
    out[side] = {
      tabs,
      active: Math.max(0, Math.min(active, tabs.length - 1)),
      columns: readColumns(p.columns),
      columnOrder: readColumnOrder(p.columnOrder),
      columnVisibility: readColumnVisibility(p.columnVisibility),
      columnPinning: readColumnPinning(p.columnPinning),
    }
  }
  return out
}

const storedTab = (t: Tab): StoredTab => ({
  path: t.path,
  name: t.name,
  sort: t.sort,
  showHidden: t.showHidden,
  view: t.view,
  locked: t.locked,
  title: t.title,
  history: t.history.slice(-MAX_STORED_HISTORY),
  historyIndex: Math.min(t.historyIndex, MAX_STORED_HISTORY - 1),
  // An entry of a connection has no id after a restart.
  cursorId: t.remote ? null : t.cursorId,
  ...(t.remote && {
    remote: {
      connectionId: t.remote.connectionId,
      label: t.remote.label,
      host: t.remote.host,
      port: t.remote.port,
      user: t.remote.user,
      encrypted: t.remote.encrypted,
      path: t.remote.path,
    },
  }),
})

/** A stored tab as the tab bar holds it: its connection, if any, is not open. */
const restoredTab = (t: StoredTab): Omit<Tab, "id"> => {
  const { remote, ...rest } = t
  return { ...rest, remote: remote ? { remoteId: 0, ...remote } : null }
}

/** What commander.panels holds now. */
export function storedPanels(): StoredPanels {
  const out: StoredPanels = { v: 3, active: usePanelsStore.getState().active }
  for (const side of SIDES) {
    captureActive(side)
    const { tabs, active } = useTabsStore.getState()[side]
    const kept = tabs.filter((t) => t.path !== "")
    if (kept.length === 0) continue
    out[side] = {
      tabs: kept.map(storedTab),
      active: Math.max(0, kept.indexOf(tabs[active]!)),
      columns: useListingStore.getState()[side].columns,
      columnOrder: useListingStore.getState()[side].columnOrder,
      columnVisibility: useListingStore.getState()[side].columnVisibility,
      columnPinning: useListingStore.getState()[side].columnPinning,
    }
  }
  return out
}

function writePanels(): void {
  void bridge.setSetting(PANELS_KEY, storedPanels()).catch(() => undefined)
}

/** Hooks tabs and persistence into the listing (once per start, and in tests). */
export function installSession(): void {
  setPersistHandler(writePanels)
  installTabHooks(setFolderChangeHook)
}

/**
 * Start: each panel gets its stored tabs and opens the visible one (home on
 * first run). A folder carried over from the viewer replaces the active
 * panel's.
 */
export async function restorePanels(
  carried: { dirId: number; focusId: number | null } | null,
): Promise<void> {
  installSession()
  const { settings } = await bridge.library()
  const stored = readStoredPanels(settings[PANELS_KEY])
  const storedSettings = settings[SETTINGS_KEY]
  const { showHidden } = readSettings(storedSettings)
  // Settings older than v3: tabs kept the old "hidden off" default, so they
  // all start with the setting once; the settings are stored as v3 then.
  const migrate = (storedSettings as { v?: unknown } | undefined)?.v !== SETTINGS_VERSION
  if (migrate) {
    void bridge
      .setSetting(SETTINGS_KEY, { v: SETTINGS_VERSION, ...readSettings(storedSettings) })
      .catch(() => undefined)
  }
  usePanelsStore.setState({ active: stored.active })
  let home: Promise<string | null> | null = null
  await Promise.all(
    SIDES.map(async (side) => {
      // A folder opened while library.db was read (the user, a carried
      // context) wins over the stored session.
      if (hasNavigated(side)) return
      const saved = stored[side]
      if (saved) {
        const tabs = migrate ? saved.tabs.map((tab) => ({ ...tab, showHidden })) : saved.tabs
        setTabs(side, tabs.map(restoredTab), saved.active)
      } else setTabs(side, [], 0)
      const tab = saved?.tabs[saved.active]
      patch(side, {
        columns: saved?.columns ?? useListingStore.getState()[side].columns,
        columnOrder: saved?.columnOrder ?? useListingStore.getState()[side].columnOrder,
        columnVisibility:
          saved?.columnVisibility ?? useListingStore.getState()[side].columnVisibility,
        columnPinning: saved?.columnPinning ?? useListingStore.getState()[side].columnPinning,
        sort: tab?.sort ?? useListingStore.getState()[side].sort,
        showHidden: tab && !migrate ? tab.showHidden : showHidden,
        view: tab?.view ?? "full",
        history: tab?.history ?? [],
        historyIndex: tab?.historyIndex ?? -1,
      })
      if (carried && side === stored.active) {
        return openFolderEntry(side, carried.dirId, { focusId: carried.focusId })
      }
      if (tab) {
        await openPath(side, tab.path, {
          focusId: tab.cursorId,
          tabLoad: true,
          ...(tab.history.length > 0 && { historyIndex: tab.historyIndex }),
        })
        // The tab was on a server: "Not connected", with Connect. Nothing dials at startup.
        if (tab.remote) showDisconnected(side, tab.remote)
        return
      }
      home ??= bridge.homePath().catch(() => null)
      const path = await home
      if (path) return openPath(side, path)
      return openHome(side)
    }),
  )
}
