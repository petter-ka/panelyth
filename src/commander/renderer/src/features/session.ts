import type { SortKey } from "@panelyth/contracts"
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
  SIDES,
  useListingStore,
  type ColumnWidths,
  type ColumnLayout,
  type ViewMode,
} from "./listing"
import { usePanelsStore, type Side } from "./panels"
import { readSettings, SETTINGS_KEY } from "./settings"
import { captureActive, installTabHooks, MAX_TABS, setTabs, useTabsStore, type Tab } from "./tabs"

// Session restore (Stage C03): both panels with their tabs, views, sorts,
// column widths, histories and cursor entries, in commander.panels.

export const PANELS_KEY = "commander.panels"
const MAX_STORED_HISTORY = 50

export interface StoredTab {
  path: string
  name: string
  sort: SortKey
  showHidden: boolean
  view: ViewMode
  locked: boolean
  history: string[]
  historyIndex: number
  cursorId: number | null
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
  v: 2
  active: Side
  left?: StoredPanel
  right?: StoredPanel
}

const isPath = (v: unknown): v is string => typeof v === "string" && v !== "" && v.length < 32_768

function readTab(v: unknown): StoredTab | null {
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
    history,
    historyIndex: history.length === 0 ? -1 : Math.max(0, Math.min(index, history.length - 1)),
    cursorId:
      typeof t.cursorId === "number" && Number.isSafeInteger(t.cursorId) && t.cursorId > 0
        ? t.cursorId
        : null,
  }
}

/** Validated stored panels; unknown shapes fall back to defaults. Reads v1 (C01–C02, one folder per panel). */
export function readStoredPanels(value: unknown): StoredPanels {
  const v = (value ?? {}) as Record<string, unknown>
  const out: StoredPanels = { v: 2, active: v.active === "right" ? "right" : "left" }
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
    if (v.v !== 2 || !Array.isArray(p.tabs)) continue
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
  history: t.history.slice(-MAX_STORED_HISTORY),
  historyIndex: Math.min(t.historyIndex, MAX_STORED_HISTORY - 1),
  cursorId: t.cursorId,
})

/** What commander.panels holds now. */
export function storedPanels(): StoredPanels {
  const out: StoredPanels = { v: 2, active: usePanelsStore.getState().active }
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
  const showHidden = readSettings(settings[SETTINGS_KEY]).showHidden
  usePanelsStore.setState({ active: stored.active })
  let home: Promise<string | null> | null = null
  await Promise.all(
    SIDES.map(async (side) => {
      // A folder opened while library.db was read (the user, a carried
      // context) wins over the stored session.
      if (hasNavigated(side)) return
      const saved = stored[side]
      if (saved) setTabs(side, saved.tabs, saved.active)
      else setTabs(side, [], 0)
      const tab = saved?.tabs[saved.active]
      patch(side, {
        columns: saved?.columns ?? useListingStore.getState()[side].columns,
        columnOrder: saved?.columnOrder ?? useListingStore.getState()[side].columnOrder,
        columnVisibility:
          saved?.columnVisibility ?? useListingStore.getState()[side].columnVisibility,
        columnPinning: saved?.columnPinning ?? useListingStore.getState()[side].columnPinning,
        sort: tab?.sort ?? useListingStore.getState()[side].sort,
        showHidden: tab ? tab.showHidden : showHidden,
        view: tab?.view ?? "full",
        history: tab?.history ?? [],
        historyIndex: tab?.historyIndex ?? -1,
      })
      if (carried && side === stored.active) {
        return openFolderEntry(side, carried.dirId, { focusId: carried.focusId })
      }
      if (tab) {
        return openPath(side, tab.path, {
          focusId: tab.cursorId,
          tabLoad: true,
          ...(tab.history.length > 0 && { historyIndex: tab.historyIndex }),
        })
      }
      home ??= bridge.homePath().catch(() => null)
      const path = await home
      if (path) return openPath(side, path)
      return openHome(side)
    }),
  )
}
