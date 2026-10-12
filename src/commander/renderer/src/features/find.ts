import {
  ENTRY_ATTRS,
  MAX_FIND_ROOTS,
  MAX_FIND_TEXT_CHARS,
  MAX_NAME_MASK_CHARS,
  type FindEncoding,
  type FindProgress,
  type FindStartParams,
  type QuerySnapshot,
} from "@panelyth/contracts"
import { createPageStore, type PageStore } from "@panelyth/renderer-core"
import { create } from "zustand"
import { bridge, isBridgeAvailable } from "../bridge"
import { refusedOnConnection } from "./files"
import { goToEntry, isExpired, showFindResults, useListingStore } from "./listing"
import type { Side } from "./panels"
import { t } from "@panelyth/i18n"

// Find files (Alt+F7, Stage C06). The search runs in Go and its results are
// a query session (found order) paged like a folder; Feed to panel opens a
// second, sorted session over the same results in a panel.

export const HISTORY_KEY = "commander.findHistory"
const MAX_HISTORY = 20

export type FindTab = "general" | "advanced" | "results"
export type AttrRule = "any" | "set" | "clear"
export type SizeUnit = "B" | "KB" | "MB" | "GB"

export const FIND_ATTRS = ["readOnly", "hidden", "system", "archive", "executable"] as const
export type FindAttr = (typeof FIND_ATTRS)[number]

export interface FindForm {
  mask: string
  /** Start folders separated by ";". */
  roots: string
  /** Subfolder levels; -1 = all. */
  depth: number
  hidden: boolean
  text: string
  caseSensitive: boolean
  wholeWords: boolean
  /** "auto" = UTF-8, UTF-16 LE and Windows-1252 (Go's default). */
  encoding: FindEncoding | "auto"
  skipBinary: boolean
  minSize: string
  maxSize: string
  sizeUnit: SizeUnit
  /** yyyy-mm-dd; "" = unbounded. */
  after: string
  before: string
  attrs: Record<FindAttr, AttrRule>
}

export const DEFAULT_FORM: FindForm = {
  mask: "*.*",
  roots: "",
  depth: -1,
  hidden: false,
  text: "",
  caseSensitive: false,
  wholeWords: false,
  encoding: "auto",
  skipBinary: true,
  minSize: "",
  maxSize: "",
  sizeUnit: "KB",
  after: "",
  before: "",
  attrs: { readOnly: "any", hidden: "any", system: "any", archive: "any", executable: "any" },
}

export interface FindHistory {
  masks: string[]
  texts: string[]
}

export interface FindRun {
  findId: number
  /** The results tab's session (found order). */
  queryId: number
  version: number
  total: number
  /** What was searched, for the path bar of a fed panel. */
  label: string
}

interface FindState {
  /** The dialog and the panel it works for; null = closed. */
  dialog: { side: Side } | null
  tab: FindTab
  form: FindForm
  run: FindRun | null
  progress: FindProgress | null
  error: string | null
  /** The results list's cursor. */
  cursor: number
  history: FindHistory
}

export const useFindStore = create<FindState>(() => ({
  dialog: null,
  tab: "general",
  form: DEFAULT_FORM,
  run: null,
  progress: null,
  error: null,
  cursor: 0,
  history: { masks: [], texts: [] },
}))

/** The results tab's rows. */
export const resultsStore: PageStore = createPageStore({
  fetch: (q, offset, limit) => bridge.page(q, offset, limit),
  isExpired,
})
resultsStore.setExpiredHandler(() => {
  resultsStore.reset(null)
  useFindStore.setState({ run: null, error: t("The search results are no longer available.") })
})

export const isRunning = (s: Pick<FindState, "run" | "progress">): boolean =>
  s.run !== null && (s.progress === null || s.progress.state === "running")

// Spec ------------------------------------------------------------------------

const UNIT: Record<SizeUnit, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }

function size(value: string, unit: SizeUnit): number | null | undefined {
  const v = value.trim()
  if (v === "") return null
  const n = Number(v.replace(",", "."))
  return Number.isFinite(n) && n >= 0 ? Math.round(n * UNIT[unit]) : undefined
}

/** Local midnight of a yyyy-mm-dd date, plus days. */
function day(value: string, plus = 0): number | null | undefined {
  if (value === "") return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return undefined
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + plus).getTime()
}

export const splitRoots = (roots: string): string[] =>
  roots
    .split(";")
    .map((r) => r.trim())
    .filter((r) => r !== "")

/** The form as find.start params, or what is wrong with it. */
export function buildSpec(form: FindForm): { spec: FindStartParams } | { error: string } {
  const roots = splitRoots(form.roots)
  if (roots.length === 0) return { error: t("Enter a folder to search in.") }
  if (roots.length > MAX_FIND_ROOTS)
    return { error: t("Search at most {count} folders.", { count: MAX_FIND_ROOTS }) }
  const mask = form.mask.trim()
  if (mask.length > MAX_NAME_MASK_CHARS) return { error: t("The file mask is too long.") }
  if (form.text.length > MAX_FIND_TEXT_CHARS) return { error: t("The text is too long.") }
  const minSize = size(form.minSize, form.sizeUnit)
  const maxSize = size(form.maxSize, form.sizeUnit)
  if (minSize === undefined || maxSize === undefined) return { error: t("Enter sizes as numbers.") }
  if (minSize !== null && maxSize !== null && minSize > maxSize)
    return { error: t("The minimum size is larger than the maximum.") }
  const after = day(form.after)
  // "Before" includes the whole day.
  const before = day(form.before, 1)
  if (after === undefined || before === undefined) return { error: t("Enter valid dates.") }
  if (after !== null && before !== null && after >= before)
    return { error: t("The date range is empty.") }
  let attrsSet = 0
  let attrsClear = 0
  for (const attr of FIND_ATTRS) {
    if (form.attrs[attr] === "set") attrsSet |= ENTRY_ATTRS[attr]
    else if (form.attrs[attr] === "clear") attrsClear |= ENTRY_ATTRS[attr]
  }
  return {
    spec: {
      roots,
      mask: mask === "" ? "*.*" : mask,
      depth: form.depth,
      // Asking for hidden or system files searches them too.
      hidden: form.hidden || (attrsSet & (ENTRY_ATTRS.hidden | ENTRY_ATTRS.system)) !== 0,
      text: form.text,
      caseSensitive: form.caseSensitive,
      wholeWords: form.wholeWords,
      encodings: form.encoding === "auto" ? [] : [form.encoding],
      skipBinary: form.skipBinary,
      minSize,
      maxSize,
      modifiedAfter: after,
      modifiedBefore: before,
      attrsSet,
      attrsClear,
    },
  }
}

const labelOf = (spec: FindStartParams): string =>
  spec.text
    ? t("{mask} containing “{text}” in {roots}", {
        mask: spec.mask,
        text: spec.text,
        roots: spec.roots.join("; "),
      })
    : t("{mask} in {roots}", { mask: spec.mask, roots: spec.roots.join("; ") })

// History ---------------------------------------------------------------------

const remember = (list: string[], value: string): string[] =>
  value === "" ? list : [value, ...list.filter((v) => v !== value)].slice(0, MAX_HISTORY)

export function readHistory(value: unknown): FindHistory {
  const v = (value ?? {}) as { masks?: unknown; texts?: unknown }
  const strings = (x: unknown): string[] =>
    Array.isArray(x)
      ? x.filter((s): s is string => typeof s === "string").slice(0, MAX_HISTORY)
      : []
  return { masks: strings(v.masks), texts: strings(v.texts) }
}

function saveHistory(spec: FindStartParams): void {
  const { history } = useFindStore.getState()
  const next = {
    masks: remember(history.masks, spec.mask),
    texts: remember(history.texts, spec.text),
  }
  useFindStore.setState({ history: next })
  if (isBridgeAvailable())
    void bridge.setSetting(HISTORY_KEY, { v: 1, ...next }).catch(() => undefined)
}

// Actions ---------------------------------------------------------------------

/** Alt+F7: the dialog for a panel; a new search starts in the panel's folder. */
export function openFind(side: Side): void {
  const s = useFindStore.getState()
  if (s.dialog) return
  // Find searches this computer's index; a server has none (ADR-0037).
  if (refusedOnConnection(side)) return
  const path = useListingStore.getState()[side].path
  useFindStore.setState({
    dialog: { side },
    tab: s.run ? "results" : "general",
    error: null,
    form: s.run || !path ? s.form : { ...s.form, roots: path },
  })
}

export const setFindTab = (tab: FindTab): void => useFindStore.setState({ tab })

export const updateForm = (change: Partial<FindForm>): void =>
  useFindStore.setState((s) => ({ form: { ...s.form, ...change }, error: null }))

/** Forgets the dialog's search; running searches stop unless a panel shows them. */
async function discardRun(stop: boolean): Promise<void> {
  const { run, progress } = useFindStore.getState()
  if (!run) return
  useFindStore.setState({ run: null, progress: null, cursor: 0 })
  resultsStore.reset(null)
  if (stop && isRunning({ run, progress })) await bridge.findCancel(run.findId).catch(() => false)
  await bridge.closeQuery(run.queryId).catch(() => undefined)
}

/** Events that arrived before find.start answered (fast searches). */
const early = {
  progress: new Map<number, FindProgress>(),
  snapshots: new Map<number, QuerySnapshot>(),
}

let startSeq = 0
/** find.start is in flight: its first events are buffered. */
let starting = false

export async function startSearch(): Promise<void> {
  const built = buildSpec(useFindStore.getState().form)
  if ("error" in built) {
    useFindStore.setState({ error: built.error, tab: "general" })
    return
  }
  const seq = ++startSeq
  await discardRun(true)
  saveHistory(built.spec)
  starting = true
  try {
    const started = await bridge.findStart(built.spec)
    if (seq !== startSeq || !useFindStore.getState().dialog) {
      void bridge.findCancel(started.findId).catch(() => false)
      void bridge.closeQuery(started.queryId).catch(() => undefined)
      return
    }
    const snapshot = latest(started, early.snapshots.get(started.queryId))
    resultsStore.reset(snapshot)
    useFindStore.setState({
      run: {
        findId: started.findId,
        queryId: snapshot.queryId,
        version: snapshot.version,
        total: snapshot.total,
        label: labelOf(built.spec),
      },
      progress: early.progress.get(started.findId) ?? null,
      tab: "results",
      cursor: 0,
      error: null,
    })
  } catch (error) {
    if (seq === startSeq)
      useFindStore.setState({
        error: error instanceof Error ? error.message : String(error),
        tab: "general",
      })
  } finally {
    starting = false
    early.progress.clear()
    early.snapshots.clear()
  }
}

const latest = (a: QuerySnapshot, b: QuerySnapshot | undefined): QuerySnapshot =>
  b && b.version > a.version ? b : a

/** Stop: the results found so far stay. */
export function stopSearch(): void {
  const { run } = useFindStore.getState()
  if (run) void bridge.findCancel(run.findId).catch(() => false)
}

/** Esc / Close: the dialog's search ends with it. */
export function closeFind(): void {
  useFindStore.setState({ dialog: null })
  void discardRun(true)
}

/** Back to the General tab for a new search; the current one stops. */
export function newSearch(): void {
  void discardRun(true)
  useFindStore.setState({ tab: "general", error: null })
}

/** Feed to panel: the results replace the panel's listing and keep arriving there. */
export async function feedToPanel(): Promise<void> {
  const { dialog, run } = useFindStore.getState()
  if (!dialog || !run) return
  try {
    await showFindResults(dialog.side, { findId: run.findId, label: run.label })
  } catch (error) {
    useFindStore.setState({ error: error instanceof Error ? error.message : String(error) })
    return
  }
  useFindStore.setState({ dialog: null })
  // The panel's session keeps the search (and its results) alive.
  void discardRun(false)
}

/** Go to file: the result's folder in the panel, the cursor on it. */
export async function goToResult(index: number): Promise<void> {
  const { dialog } = useFindStore.getState()
  const item = resultsStore.getItem(index) ?? (await resultsStore.ensureIndex(index))
  if (!dialog || !item) return
  closeFind()
  await goToEntry(dialog.side, item.id)
}

export function moveResultCursor(index: number): void {
  const total = useFindStore.getState().run?.total ?? 0
  useFindStore.setState({ cursor: Math.max(0, Math.min(index, total - 1)) })
}

// Events ----------------------------------------------------------------------

export function startFind(): () => void {
  if (!isBridgeAvailable()) return () => undefined
  void bridge
    .library()
    .then((l) => useFindStore.setState({ history: readHistory(l.settings[HISTORY_KEY]) }))
    .catch(() => undefined)
  const offs = [
    bridge.on("query.invalidated", (snapshot) => {
      const { run } = useFindStore.getState()
      if (!run) {
        if (starting) early.snapshots.set(snapshot.queryId, snapshot)
        return
      }
      if (snapshot.queryId !== run.queryId || snapshot.version <= run.version) return
      resultsStore.invalidate(snapshot)
      useFindStore.setState({ run: { ...run, version: snapshot.version, total: snapshot.total } })
    }),
    bridge.on("find.progress", (progress) => {
      const { run } = useFindStore.getState()
      if (run?.findId === progress.findId) useFindStore.setState({ progress })
      else if (!run && starting) early.progress.set(progress.findId, progress)
    }),
  ]
  return () => offs.forEach((off) => off())
}

/** Tests. */
export function resetFind(): void {
  startSeq = 0
  starting = false
  early.progress.clear()
  early.snapshots.clear()
  resultsStore.reset(null)
  useFindStore.setState({
    dialog: null,
    tab: "general",
    form: DEFAULT_FORM,
    run: null,
    progress: null,
    error: null,
    cursor: 0,
    history: { masks: [], texts: [] },
  })
}
