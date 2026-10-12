// Batch mode of the image editor (Stage 16, ADR-0036), outside React
// (ADR-0011). The editor builds the recipe on a sample picture; this store
// holds what a batch adds to it: the selection (as a descriptor, never a
// list of ids), the output rules, the plan Go answers (counts, names,
// warnings, samples) and the saved recipes. Running the batch is one call;
// the work is a job in Go.
import {
  RECIPE_VERSION,
  type BatchFolder,
  type BatchParams,
  type BatchPlanResult,
  type BatchSample,
  type Recipe,
  type RecipeOutput,
  type RecipeProblem,
  type SelectionDescriptor,
  type StoredRecipe,
} from "@panelyth/contracts"
import { create } from "zustand"
import { msg, t } from "@panelyth/i18n"
import { bridge, PanelythError } from "../../bridge"
import { notify } from "../clipboard/clipboard"
import { adoptJob, currentSelection } from "../jobs/jobsStore"
import { singleSelectedId } from "../properties/propertiesStore"
import { getItem } from "../tiles/pageStore"
import { useSelectionStore } from "../tiles/selectionStore"
import { useEditorSettings } from "./editorSettings"
import {
  closeEditorNow,
  openEditor,
  replaceList,
  switchPicture,
  toEditList,
  useEditorStore,
} from "./editorStore"
import { TOOLS } from "./tools"

export type BatchDialog = "output" | "recipes" | "replace"

interface BatchState {
  open: boolean
  selection: SelectionDescriptor | null
  /** How many items are selected, pictures or not. */
  selected: number
  plan: BatchPlanResult | null
  planning: boolean
  /** The pictures the filmstrip offers, and their thumbnails by entry id. */
  samples: readonly BatchSample[]
  thumbs: Readonly<Record<number, string>>
  output: RecipeOutput
  /** The folder picked for a "folder" output: a handle of main's and a name. */
  folder: BatchFolder | null
  recipes: readonly StoredRecipe[] | null
  dialog: BatchDialog | null
  starting: boolean
  error: string
}

const defaultOutput = (): RecipeOutput => {
  const prefs = useEditorSettings.getState().settings
  return {
    format: "keep",
    quality: prefs.jpegQuality,
    metadata: prefs.metadata,
    destination: "beside",
    template: "",
    conflict: "keepBoth",
  }
}

const initial = (): BatchState => ({
  open: false,
  selection: null,
  selected: 0,
  plan: null,
  planning: false,
  samples: [],
  thumbs: {},
  output: defaultOutput(),
  folder: null,
  recipes: null,
  dialog: null,
  starting: false,
  error: "",
})

export const useBatchStore = create<BatchState>(initial)

const set = useBatchStore.setState
const get = useBatchStore.getState

/** The plan follows the recipe and the output once they rest this long. */
export const PLAN_DELAY_MS = 300

let planSeq = 0
let planTimer: ReturnType<typeof setTimeout> | null = null
let thumbEpoch = 0
let offPreview: (() => void) | null = null
let offEditor: (() => void) | null = null

function describe(error: unknown): string {
  if (error instanceof PanelythError) {
    switch (error.code) {
      case "NOT_FOUND":
        return t("The folder changed. Select the pictures again.")
      case "BUSY":
        return t("Too many operations are waiting. Try again in a moment.")
      case "INVALID_PATH":
        return t("Choose a folder for the results.")
    }
    return error.message
  }
  return error instanceof Error ? error.message : String(error)
}

/** The output as it is sent: what the destination does not use is left out. */
function sentOutput(o: RecipeOutput): RecipeOutput {
  const replace = o.destination === "replace"
  const format = replace ? "keep" : o.format
  const template = replace ? "" : (o.template ?? "").trim()
  return {
    format,
    metadata: o.metadata,
    destination: o.destination,
    conflict: o.conflict,
    ...((format === "jpeg" || format === "keep") && o.quality ? { quality: o.quality } : {}),
    ...(o.dpi ? { dpi: o.dpi } : {}),
    ...(template ? { template } : {}),
  }
}

/** The recipe as it stands: the editor's list and this store's output. */
export function currentRecipe(): Recipe {
  return {
    version: RECIPE_VERSION,
    ops: toEditList(useEditorStore.getState().items),
    output: sentOutput(get().output),
  }
}

function batchParams(): BatchParams | null {
  const s = get()
  if (!s.selection) return null
  const recipe = currentRecipe()
  return {
    source: { selection: s.selection },
    recipe,
    ...(recipe.output.destination === "folder" && s.folder && { folderId: s.folder.folderId }),
  }
}

async function plan(): Promise<BatchPlanResult | null> {
  const params = batchParams()
  if (!params) return null
  const seq = ++planSeq
  set({ planning: true })
  try {
    const result = await bridge.batchPlan(params)
    if (seq !== planSeq || !get().open) return null
    set({ plan: result, planning: false, error: "" })
    return result
  } catch (error) {
    if (seq === planSeq && get().open) set({ planning: false, error: describe(error) })
    return null
  }
}

/** Asks for the plan again once the recipe and the output have rested. */
export function schedulePlan(): void {
  if (!get().open) return
  if (planTimer) clearTimeout(planTimer)
  planTimer = setTimeout(() => {
    planTimer = null
    void plan()
  }, PLAN_DELAY_MS)
}

async function loadThumbs(samples: readonly BatchSample[]): Promise<void> {
  if (samples.length === 0) return
  const wanted = new Set(samples.map((s) => s.id))
  const take = (items: readonly { id: number; url?: string }[]): void => {
    const found: Record<number, string> = {}
    for (const item of items) {
      if (wanted.has(item.id) && typeof item.url === "string") found[item.id] = item.url
    }
    if (Object.keys(found).length > 0 && get().open) set({ thumbs: { ...get().thumbs, ...found } })
  }
  offPreview?.()
  offPreview = bridge.on("preview.ready", ({ items }) => take(items))
  try {
    // One call for the whole strip (at most twelve pictures).
    const known = await bridge.ensurePreviews({
      lane: "batch",
      epoch: ++thumbEpoch,
      profile: "grid-sm",
      items: samples.map((s) => ({ id: s.id, priority: 0 as const })),
      force: [],
    })
    take(known.items)
  } catch {
    // The strip shows the names without thumbnails.
  }
}

function stop(): void {
  if (planTimer) clearTimeout(planTimer)
  planTimer = null
  planSeq++
  offPreview?.()
  offEditor?.()
  offPreview = offEditor = null
  set(initial())
}

/**
 * Opens the batch editor on the current selection: Go says which of it are
 * pictures and offers samples; the editor opens on the first. A selection
 * without a picture opens nothing.
 */
export async function openBatchEditor(): Promise<void> {
  const cur = currentSelection()
  if (!cur || get().open) return
  set({ ...initial(), open: true, selection: cur.selection, selected: cur.count })
  const first = await plan()
  if (!get().open) return
  const sample = first?.samples[0]
  if (!first || !sample) {
    const reason = get().error
    stop()
    notify(reason || t("None of the selected items is a picture that can be edited."), "error")
    return
  }
  set({ samples: first.samples })
  void loadThumbs(first.samples)
  // The plan follows the recipe; the store ends with the editor.
  let items = useEditorStore.getState().items
  offEditor = useEditorStore.subscribe((s) => {
    if (s.status === "closed") {
      stop()
      return
    }
    if (s.items !== items) {
      items = s.items
      schedulePlan()
    }
  })
  await openEditor(sample, [], { batch: true })
}

/** Ctrl/Cmd+E in the tile view: one picture opens the editor, several the batch editor. */
export function editSelection(): void {
  const cur = currentSelection()
  if (!cur) return
  if (cur.count > 1) {
    void openBatchEditor()
    return
  }
  const id = singleSelectedId()
  const item = getItem(useSelectionStore.getState().focusIndex)
  if (id !== null && item?.id === id && item.kind === "image") {
    void openEditor({ id: item.id, name: item.name })
  }
}

export function selectSample(sample: BatchSample): void {
  if (get().open) void switchPicture(sample)
}

export function setOutput(patch: Partial<RecipeOutput>): void {
  set({ output: { ...get().output, ...patch } })
  schedulePlan()
}

export function openBatchDialog(dialog: BatchDialog | null): void {
  set({ dialog })
  if (dialog === "recipes") void loadRecipes()
}

/** Opens main's folder dialog; the results then go into that folder. */
export async function pickFolder(): Promise<void> {
  try {
    const folder = await bridge.batchPickFolder()
    if (!folder || !get().open) return
    set({ folder, output: { ...get().output, destination: "folder" }, error: "" })
    schedulePlan()
  } catch (error) {
    set({ error: describe(error) })
  }
}

const PROBLEM_TEXT: Record<RecipeProblem["code"], string> = {
  version: msg("This recipe was made by a newer version of Panelyth."),
  tooManyOps: msg("A recipe holds at most {detail} steps."),
  notBatchable: msg("{tool} works on one picture at a time."),
  invalidOp: msg("{tool} has a setting that can't be used: {detail}"),
  missingAsset: msg("{tool}: choose its picture again."),
  unknownToken: msg("The name template has a token Panelyth doesn't know: {detail}"),
  template: msg("The name template can't be used as a file name."),
  format: msg("This format can't be written."),
  quality: msg("The JPEG quality is 1 to 100."),
  metadata: msg("Choose what happens to the camera data."),
  dpi: msg("The resolution is 1 to 10,000 dpi."),
  destination: msg("Choose where the results go."),
  conflict: msg("Choose what happens when a name is taken."),
}

/** A reason the recipe cannot run, in words. */
export function problemText(p: RecipeProblem): string {
  const known = TOOLS.find((def) => def.id === p.op)?.label
  return t(PROBLEM_TEXT[p.code], { tool: known ? t(known) : p.op, detail: p.detail })
}

/** Why Run is not possible now; null when it is. */
export function runBlocker(s: BatchState): string | null {
  if (!s.plan) return t("Counting the pictures…")
  if (s.plan.count === 0) return t("None of the selected items is a picture that can be edited.")
  const problem = s.plan.problems[0]
  if (problem) return problemText(problem)
  if (s.output.destination === "folder" && !s.folder) return t("Choose a folder for the results.")
  if (s.plan.warnings.includes("trashUnavailable")) {
    return s.output.destination === "replace"
      ? t("A drive in this selection has no trash, so the originals can't be replaced safely.")
      : t("The destination has no trash, so existing files can't be replaced safely.")
  }
  return null
}

/**
 * Runs the batch: one call, then the editor closes and the jobs panel shows
 * the progress. Replacing the originals asks first.
 */
export async function runBatch(confirmed = false): Promise<void> {
  const s = get()
  if (!s.open || s.starting) return
  // The plan in hand may be older than the last change.
  if (planTimer) {
    clearTimeout(planTimer)
    planTimer = null
    await plan()
  }
  const now = get()
  if (runBlocker(now) !== null) {
    set({ dialog: "output" })
    return
  }
  if (now.output.destination === "replace" && !confirmed) {
    set({ dialog: "replace" })
    return
  }
  const params = batchParams()
  const count = now.plan?.count ?? 0
  if (!params) return
  set({ starting: true, dialog: null })
  try {
    const snap = await bridge.batchStart(params)
    adoptJob(snap, t("Editing {count, plural, one {# picture} other {# pictures}}", { count }))
    closeEditorNow()
    notify(
      t("Editing {count, plural, one {# picture} other {# pictures}} in the background.", {
        count,
      }),
    )
  } catch (error) {
    set({ starting: false, error: describe(error), dialog: "output" })
  }
}

// --- saved recipes ---

export async function loadRecipes(): Promise<void> {
  try {
    const recipes = await bridge.recipeList()
    if (get().open) set({ recipes })
  } catch (error) {
    set({ error: describe(error) })
  }
}

/** Makes a recipe the current one: its steps replace the list (one undo step), its output the output. */
export function applyRecipe(stored: StoredRecipe): void {
  if (!get().open) return
  replaceList(stored.recipe.ops)
  const o = stored.recipe.output
  const defaults = defaultOutput()
  set({
    output: {
      ...defaults,
      ...o,
      template: o.template ?? "",
      quality: o.quality || defaults.quality || useEditorSettings.getState().settings.jpegQuality,
    },
    dialog: null,
  })
  schedulePlan()
}

/** Saves the current recipe under a name; resolves to an error message, or null. */
export async function saveRecipe(name: string): Promise<string | null> {
  try {
    await bridge.recipeSave({ id: 0, name: name.trim(), recipe: currentRecipe() })
    await loadRecipes()
    return null
  } catch (error) {
    return describe(error)
  }
}

export async function deleteRecipe(id: number): Promise<void> {
  try {
    await bridge.recipeDelete(id)
  } catch (error) {
    set({ error: describe(error) })
  }
  await loadRecipes()
}

export function resetBatchStore(): void {
  stop()
}
