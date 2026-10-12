// The image editor's state (Stage 12, ADR-0035), outside React (ADR-0011).
// It holds the edit list, its history and what the session answered; pixels
// never come here: a frame is a token URL the canvas shows.
//
// Undo and redo are snapshots of the edit list (a few objects), not of
// pixels. A live control changes the list on every move; the history gets
// one step per gesture.
import type {
  ColorScope,
  EditAsset,
  EditColorsResult,
  EditFrame,
  EditHistogram,
  EditInfoGroup,
  EditList,
  EditOp,
  EditOpenResult,
  EditOutput,
  JobSnapshot,
  MetadataPolicy,
  NormalizedRect,
  SaveFormat,
  SaveTarget,
  Stroke,
} from "@panelyth/contracts"
import { isBatchOp } from "@panelyth/contracts"
import { create } from "zustand"
import { t } from "@panelyth/i18n"
import { bridge, PanelythError } from "../../bridge"
import { notify } from "../clipboard/clipboard"
import { useFolderStore } from "../folder/folderStore"
import { focusSelectAndReveal } from "../tiles/selectionStore"
import { FULL } from "./crop"
import { useEditorSettings } from "./editorSettings"
import { DEFAULT_PAINT, redEyeOp, type PaintSettings } from "./paint"
import { createScheduler, type Scheduler } from "./scheduler"
import {
  ADDS_ON_OPEN,
  defaultOp,
  isNoOp,
  LOOKS,
  toolDef,
  type ImageFacts,
  type Look,
  type ToolGroup,
  type ToolId,
} from "./tools"

export interface EditItem {
  /** Stable within a session: React keys and the active operation. */
  id: number
  op: EditOp
}

export type EditorStatus = "closed" | "opening" | "ready" | "failed"

export interface SaveState {
  state: "idle" | "saving" | "done" | "failed"
  jobId: number | null
  name: string
  error: string
}

export interface SaveOptions {
  format: SaveFormat
  quality: number
  metadata: MetadataPolicy
  /** 0 keeps the picture's resolution. */
  dpi: number
}

export interface CountedColors {
  /** The list the colors were counted for: the same array means the answer still holds. */
  items: readonly EditItem[]
  result: EditColorsResult
}

/** The crop being drawn: the box, and the operation it edits (null = a new one). */
export interface CropDraft {
  rect: NormalizedRect
  editing: number | null
  /** How many operations are shown under the box (those before the crop). */
  limit: number
}

interface EditorState {
  status: EditorStatus
  /**
   * Batch mode (Stage 16): the list is a recipe for many pictures and the
   * picture on the canvas a sample of them. Nothing is saved from here; the
   * batch store runs the recipe as a job.
   */
  batch: boolean
  entry: { id: number; name: string } | null
  session: EditOpenResult | null
  error: string
  items: readonly EditItem[]
  past: readonly (readonly EditItem[])[]
  future: readonly (readonly EditItem[])[]
  /** The list as it was last saved; the same array means nothing is unsaved. */
  savedItems: readonly EditItem[]
  /** The group the tool rail shows, the open tool panel and the operation it edits. */
  group: ToolGroup
  tool: ToolId | null
  activeId: number | null
  crop: CropDraft | null
  /** Drawing a line to straighten along. */
  straighten: boolean
  /** Showing the original while a key or button is held. */
  compare: boolean
  frame: { url: string; width: number; height: number } | null
  output: EditOutput | null
  histogram: EditHistogram | null
  /** The histogram of the picture the open levels or curves tool is given. */
  before: EditHistogram | null
  /** An eyedropper is waiting for a click on the canvas: which one. */
  picker: string | null
  /** Thumbnails of the looks for the current picture, in LOOKS order. */
  looks: readonly (EditFrame | null)[] | null
  /** Count colors: the last answer per scope, with the list it was counted for. */
  colors: Readonly<Partial<Record<ColorScope, CountedColors>>>
  colorsBusy: ColorScope | null
  /** Font families by name (Stage 14); null until asked for. */
  fonts: readonly string[] | null
  /** The pictures picked in this editor run, by id: a name and a thumbnail token each. */
  assets: Readonly<Record<string, EditAsset>>
  /** Main's file dialog is open. */
  picking: boolean
  /** The brush of the draw and retouch tools (Stage 15); kept while the editor is open. */
  paint: PaintSettings
  /** A render has been running for a while (the progress line). */
  busy: boolean
  renderError: string
  save: SaveState
  saveOptions: SaveOptions
  info: readonly EditInfoGroup[] | null
  estimate: number | null
  /** The close prompt for unsaved changes. */
  confirmClose: boolean
}

const EMPTY: readonly EditItem[] = []
const IDLE: SaveState = { state: "idle", jobId: null, name: "", error: "" }
const MAX_HISTORY = 200
/** A drag asks for the full-quality frame once it rests this long. */
export const SETTLE_MS = 150
/** The progress line appears for renders longer than this. */
export const BUSY_MS = 200

const initial: EditorState = {
  status: "closed",
  batch: false,
  entry: null,
  session: null,
  error: "",
  items: EMPTY,
  past: [],
  future: [],
  savedItems: EMPTY,
  group: "adjust",
  tool: null,
  activeId: null,
  crop: null,
  straighten: false,
  compare: false,
  frame: null,
  output: null,
  histogram: null,
  before: null,
  picker: null,
  looks: null,
  colors: {},
  colorsBusy: null,
  fonts: null,
  assets: {},
  picking: false,
  paint: DEFAULT_PAINT,
  busy: false,
  renderError: "",
  save: IDLE,
  saveOptions: { format: "jpeg", quality: 92, metadata: "keep", dpi: 0 },
  info: null,
  estimate: null,
  confirmClose: false,
}

export const useEditorStore = create<EditorState>(() => initial)

const set = useEditorStore.setState
const get = useEditorStore.getState

let nextId = 1
let scheduler: Scheduler | null = null
let settleTimer: ReturnType<typeof setTimeout> | null = null
let busyTimer: ReturnType<typeof setTimeout> | null = null
let viewEdge = 1600
let gesture = false
let openSeq = 0
/** The last finished save of this editor run, for selecting it on close. */
let lastSavedJob: number | null = null
/** The list a running save was started with. */
let savingItems: readonly EditItem[] | null = null
let savingTarget: SaveTarget = "copy"
/** The operation the open panel lost to an undo: a redo gives it back. */
let detached: number | null = null

export const isDirty = (s: Pick<EditorState, "items" | "savedItems">): boolean =>
  s.items !== s.savedItems

/** The edit list a render or a save sends: the items, without their ids. */
export function toEditList(items: readonly EditItem[]): EditList {
  return items.map((i) => i.op)
}

/** What the canvas shows: everything, the part under a crop box, or the original. */
function shownList(s: EditorState): EditList {
  if (s.compare) return []
  return toEditList(s.crop ? s.items.slice(0, s.crop.limit) : s.items)
}

function errorText(error: unknown): string {
  if (error instanceof PanelythError) {
    switch (error.code) {
      case "EDIT_TOO_LARGE":
        return t("This picture is too large to edit (the limit is 100 megapixels).")
      case "EDIT_UNSUPPORTED":
        return t("This kind of picture can't be edited.")
      case "EDIT_SESSION_GONE":
        return t("The editing session has ended. Close the editor and open the picture again.")
      case "CORRUPT_MEDIA":
        return t("The picture can't be read.")
      case "NOT_FOUND":
        return t("The picture no longer exists.")
      case "PERMISSION_DENIED":
        return t("Panelyth doesn't have permission to read this picture.")
      case "TRASH_UNAVAILABLE":
        return t("This drive has no trash, so the original can't be replaced. Save a copy instead.")
      case "EDIT_ASSET_INVALID":
        return t(
          "This file can't be used. Choose a PNG, JPEG, WebP or GIF picture of at most 16 MB and 8,000 pixels a side.",
        )
    }
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

/** Operations before `id` that are switched on (all of them when `id` is not in the list). */
function activeBefore(items: readonly EditItem[], id: number | null): number {
  let n = 0
  for (const item of items) {
    if (item.id === id) break
    if (!item.op.off) n++
  }
  return n
}

function render(quality: "draft" | "final"): void {
  const s = get()
  if (s.status !== "ready" || !scheduler) return
  // Levels and curves draw the histogram of the picture they are given.
  const wantsBefore = (s.tool === "levels" || s.tool === "curves") && !s.compare && !s.crop
  scheduler.request({
    editList: shownList(s),
    quality,
    maxEdge: viewEdge,
    histogram: true,
    ...(wantsBefore && { histogramAt: activeBefore(s.items, s.activeId) }),
  })
}

/** A change while a control moves: a draft now, the full frame when it rests. */
function renderLive(): void {
  render("draft")
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    settleTimer = null
    render("final")
  }, SETTLE_MS)
}

function renderNow(): void {
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = null
  render("final")
}

function startScheduler(sessionId: string): void {
  scheduler?.stop()
  const mine = createScheduler({
    render: (rev, request) =>
      bridge.editRender({
        sessionId,
        rev,
        editList: request.editList,
        view: { maxEdge: request.maxEdge },
        quality: request.quality,
        histogram: request.histogram,
        ...(request.histogramAt !== undefined && { histogramAt: request.histogramAt }),
      }),
    onFrame(result) {
      if (scheduler !== mine || !result.frame) return
      set({
        frame: result.frame,
        output: result.output ?? get().output,
        histogram: result.histogram ?? get().histogram,
        ...(result.before && { before: result.before }),
        renderError: "",
      })
    },
    onError(error) {
      if (scheduler !== mine) return
      set({ renderError: errorText(error) })
    },
    onBusy(busy) {
      if (scheduler !== mine) return
      if (busyTimer) clearTimeout(busyTimer)
      busyTimer = null
      if (!busy) set({ busy: false })
      else if (!get().busy) busyTimer = setTimeout(() => set({ busy: true }), BUSY_MS)
    },
  })
  scheduler = mine
}

/** Reasons a tile cannot be edited, for a disabled button's tooltip; null when it can. */
export function editBlocker(item: { kind: string } | null | undefined): string | null {
  if (!item) return t("Select a picture to edit")
  switch (item.kind) {
    case "image":
      return null
    case "video":
      return t("Videos can't be edited")
    case "dir":
      return t("Folders can't be edited")
  }
  return t("This file can't be edited")
}

/**
 * Opens the editor on a picture. The session opens in Go; the editor shows at
 * once. `first` are operations to start with (the turn and flip the viewer
 * showed); they count as unsaved changes.
 */
export async function openEditor(
  entry: { id: number; name: string },
  first: EditList = [],
  options: { batch?: boolean } = {},
): Promise<void> {
  const seq = ++openSeq
  const previous = get().session
  if (previous) void bridge.editClose(previous.sessionId).catch(() => undefined)
  scheduler?.stop()
  scheduler = null
  lastSavedJob = null
  set({ ...initial, status: "opening", entry, batch: options.batch === true })
  try {
    const session = await bridge.editOpen(entry.id)
    if (seq !== openSeq) {
      void bridge.editClose(session.sessionId).catch(() => undefined)
      return
    }
    const prefs = useEditorSettings.getState().settings
    set({
      status: "ready",
      session,
      ...(first.length > 0 && { items: first.map((op) => ({ id: nextId++, op })) }),
      entry: { id: entry.id, name: session.name },
      output: { width: session.width, height: session.height, dpi: session.dpi },
      saveOptions: {
        format: session.saveFormat,
        quality: prefs.jpegQuality,
        metadata: prefs.metadata,
        dpi: 0,
      },
    })
    startScheduler(session.sessionId)
    renderNow()
    if (session.notice === "bitDepth") {
      notify(t("This picture has more than 8 bits per channel; it is edited and saved with 8."))
    }
  } catch (error) {
    if (seq === openSeq) set({ status: "failed", error: errorText(error) })
  }
}

/**
 * Batch mode: shows another sample picture under the same recipe. The list,
 * its history and the open tool stay; what belonged to the picture (frame,
 * histogram, thumbnails, counted colors) is asked for again.
 */
export async function switchPicture(entry: { id: number; name: string }): Promise<void> {
  const s = get()
  if (s.status === "closed" || s.entry?.id === entry.id) return
  const seq = ++openSeq
  endGesture()
  if (s.session) void bridge.editClose(s.session.sessionId).catch(() => undefined)
  scheduler?.stop()
  scheduler = null
  if (settleTimer) clearTimeout(settleTimer)
  if (busyTimer) clearTimeout(busyTimer)
  settleTimer = busyTimer = null
  onPick = null
  set({
    status: "opening",
    entry,
    session: null,
    error: "",
    crop: null,
    straighten: false,
    compare: false,
    picker: null,
    before: null,
    looks: null,
    colors: {},
    colorsBusy: null,
    info: null,
    busy: false,
    renderError: "",
  })
  try {
    const session = await bridge.editOpen(entry.id)
    if (seq !== openSeq) {
      void bridge.editClose(session.sessionId).catch(() => undefined)
      return
    }
    set({
      status: "ready",
      session,
      entry: { id: entry.id, name: session.name },
      output: { width: session.width, height: session.height, dpi: session.dpi },
    })
    startScheduler(session.sessionId)
    renderNow()
    if (get().tool === "looks") void loadLooks()
  } catch (error) {
    if (seq === openSeq) set({ status: "failed", error: errorText(error) })
  }
}

/** Replaces the whole list as one history step (a recipe was chosen). */
export function replaceList(ops: EditList): void {
  const s = get()
  if (s.status !== "ready") return
  endGesture()
  detached = null
  commit(
    ops.map((op) => ({ id: nextId++, op })),
    { tool: null, activeId: null, crop: null, straighten: false, picker: null, before: null },
  )
  renderNow()
}

function teardown(): void {
  openSeq++
  const { session } = get()
  if (session) void bridge.editClose(session.sessionId).catch(() => undefined)
  scheduler?.stop()
  scheduler = null
  if (settleTimer) clearTimeout(settleTimer)
  if (busyTimer) clearTimeout(busyTimer)
  settleTimer = busyTimer = null
  gesture = false
}

/** Closes without asking. The tile view selects the picture saved last, if any. */
export function closeEditorNow(): void {
  const job = lastSavedJob
  teardown()
  set(initial)
  lastSavedJob = null
  if (job !== null) void selectSaved(job)
}

async function selectSaved(jobId: number): Promise<void> {
  const query = useFolderStore.getState().query
  if (!query) return
  const saved = await bridge.editSaved(jobId).catch(() => null)
  if (!saved || saved.entryId <= 0) return
  const at = await bridge.indexOf(query.queryId, saved.entryId).catch(() => null)
  if (at && at.index >= 0 && useFolderStore.getState().query?.queryId === query.queryId) {
    focusSelectAndReveal(at.index, saved.entryId)
  }
}

/** Esc and the Close button: asks first when something is unsaved. */
export function requestClose(remind: boolean): void {
  const s = get()
  if (s.status === "closed") return
  if (s.batch) {
    // A recipe that was built and not run is asked about, whatever the setting.
    if (s.status === "ready" && s.items.length > 0 && !s.confirmClose) set({ confirmClose: true })
    else closeEditorNow()
    return
  }
  if (s.status === "ready" && remind && isDirty(s) && s.save.state !== "saving") {
    set({ confirmClose: true })
    return
  }
  closeEditorNow()
}

export function cancelClose(): void {
  set({ confirmClose: false })
}

// --- the edit list ---

function imageFacts(s: EditorState): ImageFacts {
  const o = s.output
  return { width: o?.width ?? 1, height: o?.height ?? 1, dpi: o?.dpi.x ?? 0 }
}

/** Replaces the list as one history step. */
function commit(items: readonly EditItem[], extra: Partial<EditorState> = {}): void {
  const s = get()
  set({
    items,
    past: [...s.past.slice(-(MAX_HISTORY - 1)), s.items],
    future: [],
    ...extra,
  })
}

/** Replaces the list inside a gesture: the history gets the step once. */
function change(items: readonly EditItem[], live: boolean, extra: Partial<EditorState> = {}): void {
  if (live && gesture) set({ items, ...extra })
  else commit(items, extra)
  gesture = live
  if (live) renderLive()
  else renderNow()
}

/** A drag ended: the next change is a new history step, and the frame is final. */
export function endGesture(): void {
  if (!gesture) return
  gesture = false
  renderNow()
}

/** Shows a group's tools in the panel (the tool rail). */
export function openGroup(group: ToolGroup): void {
  const s = get()
  if (s.group === group) return
  // The open tool belongs to the group it was opened from.
  if (s.tool && toolDef(s.tool).group !== group) openTool(null)
  // A group with one tool shows it at once.
  set({ group })
  if (group === "looks") openTool("looks")
}

/**
 * Opens a tool's panel. A gesture tool (crop) starts drawing on the canvas;
 * a tool without a neutral state (grayscale, negative, …) adds its
 * operation at once: opening it is choosing it.
 */
export function openTool(kind: ToolId | null, editId: number | null = null): void {
  const s = get()
  if (s.status !== "ready") return
  // A recipe holds no tool that points at a place in one picture.
  if (s.batch && kind && kind !== "looks" && !isBatchOp(kind)) return
  endGesture()
  detached = null
  const wasCropping = s.crop !== null
  const next: Partial<EditorState> = {
    tool: kind,
    activeId: editId,
    crop: null,
    straighten: false,
    picker: null,
    before: null,
    ...(kind && { group: toolDef(kind).group }),
  }
  if (kind && kind !== "looks" && editId === null && ADDS_ON_OPEN.has(kind)) {
    const id = nextId++
    commit([...s.items, { id, op: defaultOp(kind, imageFacts(s)) }], { ...next, activeId: id })
    suggestFormat(kind)
    renderNow()
    return
  }
  if (kind === "crop") {
    const at = editId === null ? -1 : s.items.findIndex((i) => i.id === editId)
    const existing = at >= 0 ? s.items[at]!.op : null
    next.crop = {
      rect: existing?.op === "crop" ? existing.p.rect : FULL,
      editing: at >= 0 ? editId : null,
      limit: at >= 0 ? at : s.items.length,
    }
  }
  set(next)
  // The canvas shows another prefix of the list while a crop box is open;
  // levels and curves ask for the histogram of what they are given.
  if (wasCropping || next.crop || kind === "levels" || kind === "curves") renderNow()
  if (kind === "looks") void loadLooks()
}

/** Reducing colors is for an indexed file: a JPEG would bring the colors back. */
function suggestFormat(kind: ToolId): void {
  // A batch's format is chosen in its Output dialog.
  if (get().batch) return
  const o = get().saveOptions
  if (kind === "reduceColors" && o.format !== "png" && o.format !== "gif") {
    set({ saveOptions: { ...o, format: "png" }, estimate: null })
    notify(t("Save format set to PNG: it keeps the reduced colors as a palette."))
  }
}

/** The operation the open panel shows: the active one, or the tool's default. */
export function panelOp(s: EditorState): EditOp | null {
  if (!s.tool || s.tool === "looks") return null
  const active = s.activeId === null ? undefined : s.items.find((i) => i.id === s.activeId)
  if (active && active.op.op === s.tool) return active.op
  return defaultOp(s.tool, imageFacts(s))
}

/**
 * Sets the parameters of the open panel's operation. The first change of a
 * fresh panel adds the operation to the list. `live` marks a change while a
 * control is being dragged.
 */
export function setParams(op: EditOp, live = false): void {
  const s = get()
  if (s.status !== "ready") return
  const at = s.activeId === null ? -1 : s.items.findIndex((i) => i.id === s.activeId)
  if (at < 0) {
    const id = nextId++
    change([...s.items, { id, op }], live, { activeId: id })
    return
  }
  const items = s.items.slice()
  items[at] = {
    id: s.items[at]!.id,
    op: { ...op, ...(s.items[at]!.op.off && { off: true }) } as EditOp,
  }
  change(items, live)
}

/** Adds an operation that needs no panel (flip, a quarter turn). */
export function addOp(op: EditOp): void {
  const s = get()
  if (s.status !== "ready") return
  endGesture()
  commit([...s.items, { id: nextId++, op }])
  renderNow()
}

export function removeOp(id: number): void {
  const s = get()
  endGesture()
  const items = s.items.filter((i) => i.id !== id)
  if (items.length === s.items.length) return
  commit(items, s.activeId === id ? { activeId: null, tool: null, crop: null } : {})
  renderNow()
}

/** The eye in the edit stack. */
export function toggleOp(id: number): void {
  const s = get()
  endGesture()
  const items = s.items.map((i): EditItem => {
    if (i.id !== id) return i
    const { off, ...rest } = i.op
    return { id, op: (off ? rest : { ...rest, off: true }) as EditOp }
  })
  commit(items)
  renderNow()
}

/** Moves an operation to another place in the list. */
export function moveOp(id: number, to: number): void {
  const s = get()
  const from = s.items.findIndex((i) => i.id === id)
  const target = Math.min(Math.max(to, 0), s.items.length - 1)
  if (from < 0 || from === target) return
  endGesture()
  const items = s.items.slice()
  const [item] = items.splice(from, 1)
  items.splice(target, 0, item!)
  commit(items, { crop: null, tool: s.crop ? null : s.tool })
  renderNow()
}

export function resetAll(): void {
  const s = get()
  if (s.items.length === 0) return
  endGesture()
  commit(EMPTY, { tool: null, activeId: null, crop: null, straighten: false })
  renderNow()
}

function restore(
  items: readonly EditItem[],
  past: EditorState["past"],
  future: EditorState["future"],
): void {
  const s = get()
  // The open panel follows its operation only while that still exists; when
  // a redo brings the operation back, the panel edits it again.
  const alive = s.activeId !== null && items.some((i) => i.id === s.activeId)
  if (!alive && s.activeId !== null) detached = s.activeId
  const back =
    !alive && detached !== null && items.some((i) => i.id === detached && i.op.op === s.tool)
      ? detached
      : null
  set({
    items,
    past,
    future,
    crop: null,
    straighten: false,
    ...(!alive && { activeId: back }),
    ...(s.crop && { tool: null }),
  })
  renderNow()
}

export function undo(): void {
  const s = get()
  if (s.past.length === 0) return
  endGesture()
  restore(s.past[s.past.length - 1]!, s.past.slice(0, -1), [s.items, ...s.future])
}

export function redo(): void {
  const s = get()
  if (s.future.length === 0) return
  endGesture()
  restore(s.future[0]!, [...s.past, s.items], s.future.slice(1))
}

// --- gestures on the canvas ---

export function setCropRect(rect: NormalizedRect): void {
  const { crop } = get()
  if (crop) set({ crop: { ...crop, rect } })
}

/** Enter in the crop tool: the box becomes the operation. */
export function applyCrop(): void {
  const s = get()
  if (!s.crop) return
  const { rect, editing } = s.crop
  const op: EditOp = { op: "crop", p: { rect } }
  if (editing !== null) {
    const items = s.items.map((i) => (i.id === editing ? { id: i.id, op } : i))
    commit(items, { crop: null, tool: null, activeId: null })
  } else if (isNoOp(op, imageFacts(s))) {
    set({ crop: null, tool: null, activeId: null })
  } else {
    commit([...s.items, { id: nextId++, op }], { crop: null, tool: null, activeId: null })
  }
  renderNow()
}

export function cancelCrop(): void {
  if (!get().crop) return
  set({ crop: null, tool: null, activeId: null })
  renderNow()
}

export function setStraighten(on: boolean): void {
  set({ straighten: on })
}

export function setCompare(on: boolean): void {
  const s = get()
  if (s.compare === on || s.status !== "ready") return
  set({ compare: on })
  renderNow()
}

/** The canvas reports how many device pixels its long edge needs. */
export function setViewEdge(edge: number): void {
  const wanted = Math.round(edge)
  if (!(wanted > 0)) return
  // Small changes (a few zoom steps) reuse the frame; it is scaled by the browser.
  const grew = wanted > viewEdge * 1.15
  const shrank = wanted < viewEdge * 0.6
  if (!grew && !shrank) return
  viewEdge = wanted
  render("final")
}

// --- info and save ---

export async function loadInfo(): Promise<void> {
  const s = get()
  if (!s.session || s.info) return
  const sessionId = s.session.sessionId
  const groups = await bridge.editInfo(sessionId).catch(() => [])
  if (get().session?.sessionId === sessionId) set({ info: groups })
}

export function setSaveOptions(patch: Partial<SaveOptions>): void {
  set({ saveOptions: { ...get().saveOptions, ...patch }, estimate: null })
}

let estimateSeq = 0

/** The size a save with the current options would have ("about"). */
export async function refreshEstimate(): Promise<void> {
  const s = get()
  if (!s.session) return
  const seq = ++estimateSeq
  const bytes = await bridge
    .editEstimate({
      sessionId: s.session.sessionId,
      editList: toEditList(s.items),
      format: s.saveOptions.format,
      quality: s.saveOptions.format === "jpeg" ? s.saveOptions.quality : 0,
      metadata: s.saveOptions.metadata,
    })
    .catch(() => null)
  if (seq === estimateSeq && get().session?.sessionId === s.session.sessionId) {
    set({ estimate: bytes })
  }
}

/** Starts a save job. "as" opens the native dialog in Electron main. */
export async function save(target: SaveTarget): Promise<boolean> {
  const s = get()
  if (!s.session || s.batch || s.save.state === "saving") return false
  endGesture()
  const items = get().items
  const o = s.saveOptions
  // Replace keeps the original's name, so it keeps its format.
  const format = target === "replace" ? s.session.saveFormat : o.format
  set({ save: { state: "saving", jobId: null, name: "", error: "" } })
  try {
    const res = await bridge.editSave({
      sessionId: s.session.sessionId,
      editList: toEditList(items),
      target,
      format,
      quality: format === "jpeg" ? o.quality : 0,
      metadata: o.metadata,
      dpi: o.dpi,
    })
    if (res.jobId === null) {
      set({ save: IDLE })
      return false
    }
    savingItems = items
    savingTarget = target
    set({ save: { state: "saving", jobId: res.jobId, name: res.name, error: "" } })
    return true
  } catch (error) {
    set({ save: { state: "failed", jobId: null, name: "", error: errorText(error) } })
    return false
  }
}

export function cancelSave(): void {
  const { save: current } = get()
  if (current.state === "saving" && current.jobId !== null) {
    void bridge.cancelJob(current.jobId).catch(() => undefined)
  }
}

export function dismissSave(): void {
  if (get().save.state !== "saving") set({ save: IDLE })
}

export function revealSaved(): void {
  const { save: current } = get()
  if (current.jobId !== null) void bridge.editReveal(current.jobId).catch(() => undefined)
}

function onJob(snap: JobSnapshot): void {
  const s = get()
  if (s.save.state !== "saving" || snap.jobId !== s.save.jobId) return
  switch (snap.state) {
    case "completed": {
      lastSavedJob = snap.jobId
      const closing = s.confirmClose
      set({
        save: { ...s.save, state: "done" },
        // Changes made while the save ran stay unsaved.
        savedItems: savingItems ?? s.items,
        confirmClose: false,
      })
      notify(t("Saved as {name}", { name: s.save.name }))
      if (closing) closeEditorNow()
      else if (savingTarget === "replace" && s.entry) {
        // The original is the edited picture now: continue on it, with an
        // empty list (the edits are in the file).
        void reopen(s.entry, s.save)
      }
      break
    }
    case "failed":
      set({
        save: {
          ...s.save,
          state: "failed",
          error: snap.error || t("The picture could not be saved."),
        },
      })
      break
    case "cancelled":
      set({ save: IDLE })
      break
  }
}

async function reopen(entry: { id: number; name: string }, saved: SaveState): Promise<void> {
  const job = lastSavedJob
  await openEditor(entry)
  lastSavedJob = job
  if (get().status === "ready") set({ save: { ...saved, state: "done" } })
}

/** Follows the save job and the commander's "Edit" hand-off; returns the stop function. */
export function startEditor(): () => void {
  const offJob = bridge.on("job.progress", onJob)
  const offRequest = bridge.on("edit.request", ({ entryId }) => {
    void openEditor({ id: entryId, name: "" })
  })
  return () => {
    offJob()
    offRequest()
  }
}

// --- eyedroppers ---

let onPick: ((rgba: readonly [number, number, number, number]) => void) | null = null

/** The list an eyedropper reads: what the open tool is given (the operations before it). */
function pickList(s: EditorState): EditList {
  const at = s.activeId === null ? -1 : s.items.findIndex((i) => i.id === s.activeId)
  return toEditList(at >= 0 ? s.items.slice(0, at) : s.items)
}

/** Starts an eyedropper: the next click on the canvas calls `done` with the color there. */
export function startPick(
  id: string,
  done: (rgba: readonly [number, number, number, number]) => void,
): void {
  if (get().status !== "ready") return
  onPick = done
  set({ picker: id })
}

export function cancelPick(): void {
  onPick = null
  if (get().picker) set({ picker: null })
}

/** The color at a point of the picture (0..1), as Go sees it; null when it cannot be read. */
export async function probeAt(
  x: number,
  y: number,
  radius = 2,
): Promise<{ rgba: [number, number, number, number]; hex: string } | null> {
  const s = get()
  if (!s.session) return null
  return bridge
    .editProbe({
      sessionId: s.session.sessionId,
      editList: pickList(s),
      view: { maxEdge: viewEdge },
      x: Math.min(Math.max(x, 0), 1),
      y: Math.min(Math.max(y, 0), 1),
      radius,
    })
    .catch(() => null)
}

/** A click on the canvas while an eyedropper is active. */
export async function pickAt(x: number, y: number): Promise<void> {
  const done = onPick
  if (!done || !get().picker) return
  const color = await probeAt(x, y)
  if (!color || onPick !== done) return
  onPick = null
  set({ picker: null })
  done(color.rgba)
}

// --- looks ---

const LOOK_EDGE = 112
let looksSeq = 0

/** Renders a thumbnail of each look on the current picture, in one batch. */
export async function loadLooks(): Promise<void> {
  const s = get()
  if (!s.session || gesture) return
  const seq = ++looksSeq
  const base = toEditList(s.items)
  const res = await bridge
    .editThumbs({
      sessionId: s.session.sessionId,
      // A batch is at most 16 lists; there are a dozen looks.
      editLists: LOOKS.map((look) => [...base, ...look.ops]),
      edge: LOOK_EDGE,
    })
    .catch(() => null)
  if (seq === looksSeq && get().session?.sessionId === s.session.sessionId) {
    set({ looks: res?.thumbs ?? LOOKS.map(() => null) })
  }
}

/** Adds a look's operations to the list as one history step. */
export function applyLook(look: Look): void {
  const s = get()
  if (s.status !== "ready") return
  endGesture()
  commit([...s.items, ...look.ops.map((op) => ({ id: nextId++, op }))])
  renderNow()
  void loadLooks()
}

// --- count colors ---

/** Counts the colors of the picture: exactly for the full picture, quickly for the preview. */
export async function countColors(scope: ColorScope, maxColors = 16): Promise<void> {
  const s = get()
  if (!s.session || s.colorsBusy) return
  const items = s.items
  set({ colorsBusy: scope })
  const result = await bridge
    .editColors({
      sessionId: s.session.sessionId,
      editList: toEditList(items),
      scope,
      maxColors,
    })
    .catch(() => null)
  if (get().session?.sessionId !== s.session.sessionId) return
  set({
    colorsBusy: null,
    ...(result && { colors: { ...get().colors, [scope]: { items, result } } }),
  })
  if (!result) notify(t("The colors could not be counted."), "error")
}

// --- draw and retouch (Stage 15) ---

/** An edit list travels as one message of at most a megabyte; strokes stop a little before. */
const LIST_ROOM = 900_000

export function setPaint(patch: Partial<PaintSettings>): void {
  set({ paint: { ...get().paint, ...patch } })
}

/**
 * A stroke begins. The Draw tool keeps adding to its drawing; every other
 * stroke is an operation of its own. False when the list has no room left.
 */
export function paintBegin(): boolean {
  const s = get()
  if (s.status !== "ready") return false
  endGesture()
  if (JSON.stringify(toEditList(s.items)).length > LIST_ROOM) {
    notify(t("This picture has as many strokes as fit. Save it and continue on the copy."), "error")
    return false
  }
  if (s.tool !== "draw" && s.activeId !== null) set({ activeId: null })
  return true
}

/** The strokes of the drawing the Draw tool adds to (none before its first stroke). */
export function drawnStrokes(s: Pick<EditorState, "items" | "activeId">): readonly Stroke[] {
  const active = s.activeId === null ? undefined : s.items.find((i) => i.id === s.activeId)
  return active?.op.op === "draw" ? active.op.p.strokes : NO_STROKES
}
const NO_STROKES: readonly Stroke[] = []

/** Takes the newest stroke off the drawing (one step); the tool stays open. */
export function removeLastStroke(): void {
  const s = get()
  const rest = drawnStrokes(s).slice(0, -1)
  if (s.activeId === null || drawnStrokes(s).length === 0) return
  endGesture()
  if (rest.length > 0) {
    setParams({ op: "draw", p: { strokes: rest } })
    return
  }
  // An empty drawing is no edit.
  commit(
    s.items.filter((i) => i.id !== s.activeId),
    { activeId: null },
  )
  renderNow()
}

/** The stroke as it is while the pointer is down; a draft frame follows. */
export function paintLive(op: EditOp): void {
  setParams(op, true)
}

/** The pointer was released: the stroke is one step of the history. */
export function paintEnd(): void {
  endGesture()
  const s = get()
  if (s.tool !== "draw" && s.activeId !== null) set({ activeId: null })
}

/** A stroke made in one go (a click, a shape by numbers): one step. */
export function paintOnce(op: EditOp): void {
  if (!paintBegin()) return
  setParams(op)
  paintEnd()
}

/**
 * The red-eye tool's Auto: Go finds the pupils, each becomes an ordinary
 * red-eye step (one undo for all). Returns how many, or null when it failed.
 */
export async function findEyes(): Promise<number | null> {
  const s = get()
  if (!s.session || s.status !== "ready") return null
  endGesture()
  const sessionId = s.session.sessionId
  const items = get().items
  const eyes = await bridge.editEyes({ sessionId, editList: toEditList(items) }).catch(() => null)
  if (get().session?.sessionId !== sessionId || get().items !== items) return null
  if (!eyes) {
    notify(t("The picture could not be searched for red eyes."), "error")
    return null
  }
  if (eyes.length === 0) {
    notify(t("No red eyes found."))
    return 0
  }
  const paint = get().paint
  commit([...items, ...eyes.map((rect) => ({ id: nextId++, op: redEyeOp(paint, rect) }))], {
    activeId: null,
  })
  renderNow()
  notify(t("Red eyes fixed: {count}", { count: eyes.length }))
  return eyes.length
}

// --- fonts and picked pictures (Stage 14) ---

/** Loads the font families once per session. */
export async function loadFonts(): Promise<void> {
  const s = get()
  if (!s.session || s.fonts) return
  const sessionId = s.session.sessionId
  const families = await bridge.editFonts(sessionId).catch(() => null)
  if (families && get().session?.sessionId === sessionId) set({ fonts: families })
}

/**
 * Asks Electron main for a picture (a logo, a mask, a texture). The dialog
 * and the path are main's: what comes back is an id for the edit list, with
 * a name and a thumbnail for the panel. Null when the dialog was cancelled
 * or the file cannot be used (the reason is shown).
 */
export async function pickAsset(): Promise<EditAsset | null> {
  const s = get()
  if (!s.session || s.picking) return null
  const sessionId = s.session.sessionId
  set({ picking: true })
  try {
    const asset = await bridge.assetPick(sessionId)
    if (get().session?.sessionId !== sessionId) return null
    if (asset) set({ assets: { ...get().assets, [asset.assetId]: asset } })
    return asset
  } catch (error) {
    notify(errorText(error), "error")
    return null
  } finally {
    if (get().session?.sessionId === sessionId) set({ picking: false })
  }
}

/** Tests. */
export function resetEditor(): void {
  teardown()
  nextId = 1
  viewEdge = 1600
  lastSavedJob = null
  savingItems = null
  onPick = null
  detached = null
  set(initial, true)
}
