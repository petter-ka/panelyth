import type { SortKey } from "@panelyth/contracts"
import { create } from "zustand"
import { bridge, isBridgeAvailable } from "../bridge"
import { SIDES, type ViewMode } from "./listing"
import type { Side } from "./panels"
import { readTab } from "./session"
import { captureActive, MAX_TABS, openTabs, useTabsStore } from "./tabs"

// Saved tab sets (Stage C10.5, CFR-08): a panel's tabs, or both panels',
// kept under a name in commander.tabSets and opened again later, in place of
// the current tabs or after them. A set holds what a tab holds in the
// session, without its history and cursor.

export const TAB_SETS_KEY = "commander.tabSets"
export const MAX_TAB_SETS = 50
export const MAX_SET_NAME = 64

export interface SetTab {
  path: string
  name: string
  title: string
  sort: SortKey
  showHidden: boolean
  view: ViewMode
  locked: boolean
}

export interface SetPanel {
  tabs: SetTab[]
  active: number
}

export interface TabSet {
  id: number
  name: string
  /** One panel's tabs (they open in the active panel), or the left and the right panel's. */
  panels: SetPanel[]
}

export type TabSetDialog = { kind: "save"; side: Side } | { kind: "manage"; side: Side }

interface TabSetsState {
  sets: TabSet[]
  dialog: TabSetDialog | null
}

export const useTabSetsStore = create<TabSetsState>(() => ({ sets: [], dialog: null }))

const set = useTabSetsStore.setState
const get = useTabSetsStore.getState

function readPanel(v: unknown): SetPanel | null {
  const p = (v ?? {}) as { tabs?: unknown; active?: unknown }
  if (!Array.isArray(p.tabs)) return null
  const tabs = p.tabs
    .slice(0, MAX_TABS)
    .map(readTab)
    .filter((t) => t !== null)
    .map(({ path, name, title, sort, showHidden, view, locked }): SetTab => ({
      path,
      name,
      title,
      sort,
      showHidden,
      view,
      locked,
    }))
  if (tabs.length === 0) return null
  const active = typeof p.active === "number" ? Math.trunc(p.active) : 0
  return { tabs, active: Math.max(0, Math.min(active, tabs.length - 1)) }
}

/** Validated stored sets; anything of an unknown shape is dropped. */
export function readTabSets(value: unknown): TabSet[] {
  const v = (value ?? {}) as { v?: unknown; sets?: unknown }
  if (v.v !== 1 || !Array.isArray(v.sets)) return []
  const out: TabSet[] = []
  const ids = new Set<number>()
  for (const raw of v.sets.slice(0, MAX_TAB_SETS)) {
    const s = (raw ?? {}) as { id?: unknown; name?: unknown; panels?: unknown }
    const name = typeof s.name === "string" ? s.name.trim().slice(0, MAX_SET_NAME) : ""
    if (typeof s.id !== "number" || !Number.isSafeInteger(s.id) || s.id <= 0 || ids.has(s.id))
      continue
    if (name === "" || !Array.isArray(s.panels)) continue
    const panels = s.panels.slice(0, 2).map(readPanel)
    if (panels.length === 0 || panels.some((p) => p === null)) continue
    ids.add(s.id)
    out.push({ id: s.id, name, panels: panels as SetPanel[] })
  }
  return out
}

function persist(): void {
  if (isBridgeAvailable())
    void bridge.setSetting(TAB_SETS_KEY, { v: 1, sets: get().sets }).catch(() => undefined)
}

export async function loadTabSets(): Promise<void> {
  if (!isBridgeAvailable()) return
  const { settings } = await bridge.library()
  set({ sets: readTabSets(settings[TAB_SETS_KEY]) })
}

export const openSaveTabs = (side: Side): void => set({ dialog: { kind: "save", side } })
export const openTabSets = (side: Side): void => set({ dialog: { kind: "manage", side } })
export const closeTabSetDialog = (): void => set({ dialog: null })

const sameName = (a: string, b: string): boolean =>
  a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0

export const findTabSet = (name: string): TabSet | undefined =>
  get().sets.find((s) => sameName(s.name, name.trim()))

/** A panel's tabs as a set keeps them, and how many it cannot keep (tabs that never opened a folder). */
function panelOf(side: Side): { panel: SetPanel | null; leftOut: number } {
  captureActive(side)
  const { tabs, active } = useTabsStore.getState()[side]
  const kept = tabs.filter((t) => t.path !== "")
  const panel: SetPanel | null =
    kept.length === 0
      ? null
      : {
          tabs: kept.map(({ path, name, title, sort, showHidden, view, locked }) => ({
            path,
            name,
            title,
            sort,
            showHidden,
            view,
            locked,
          })),
          active: Math.max(0, kept.indexOf(tabs[active]!)),
        }
  return { panel, leftOut: tabs.length - kept.length }
}

export type SaveScope = "panel" | "both"

export type SaveResult =
  { ok: true; leftOut: number } | { ok: false; reason: "name" | "empty" | "full" }

/**
 * "Save tabs…": the panel's tabs, or both panels', under a name. A set of
 * that name is replaced.
 */
export function saveTabSet(name: string, scope: SaveScope, side: Side): SaveResult {
  const title = name.trim().slice(0, MAX_SET_NAME)
  if (title === "") return { ok: false, reason: "name" }
  const parts = (scope === "both" ? SIDES : [side]).map(panelOf)
  const leftOut = parts.reduce((n, p) => n + p.leftOut, 0)
  if (parts.some((p) => p.panel === null)) return { ok: false, reason: "empty" }
  const panels = parts.map((p) => p.panel!)
  const sets = get().sets
  const existing = sets.find((s) => sameName(s.name, title))
  if (!existing && sets.length >= MAX_TAB_SETS) return { ok: false, reason: "full" }
  const id = existing?.id ?? sets.reduce((max, s) => Math.max(max, s.id), 0) + 1
  const saved: TabSet = { id, name: title, panels }
  set({ sets: existing ? sets.map((s) => (s.id === id ? saved : s)) : [...sets, saved] })
  persist()
  return { ok: true, leftOut }
}

export function renameTabSet(id: number, name: string): boolean {
  const title = name.trim().slice(0, MAX_SET_NAME)
  const other = get().sets.find((s) => s.id !== id && sameName(s.name, title))
  if (title === "" || other) return false
  set({ sets: get().sets.map((s) => (s.id === id ? { ...s, name: title } : s)) })
  persist()
  return true
}

export function removeTabSet(id: number): void {
  set({ sets: get().sets.filter((s) => s.id !== id) })
  persist()
}

/** The panels a set opens in: both for a set of both panels, else the given one. */
const targets = (s: TabSet, side: Side): readonly Side[] => (s.panels.length === 2 ? SIDES : [side])

/** Locked tabs that opening the set in place of the current tabs would close. */
export function lockedTabsReplaced(id: number, side: Side): number {
  const s = get().sets.find((x) => x.id === id)
  if (!s) return 0
  return targets(s, side).reduce(
    (n, at) => n + useTabsStore.getState()[at].tabs.filter((t) => t.locked).length,
    0,
  )
}

/**
 * Opens a saved set: in place of the tabs or after them. Each panel opens
 * one session, for the tab it shows.
 */
export async function openTabSet(id: number, side: Side, mode: "replace" | "add"): Promise<void> {
  const s = get().sets.find((x) => x.id === id)
  if (!s) return
  await Promise.all(
    targets(s, side).map((at, i) => {
      const panel = s.panels[i]!
      return openTabs(at, panel.tabs, panel.active, mode)
    }),
  )
}

/** Tests. */
export function resetTabSets(): void {
  set({ sets: [], dialog: null })
}
