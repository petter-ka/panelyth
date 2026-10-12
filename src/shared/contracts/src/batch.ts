// Batch mode of the image editor (Stage 16, ADR-0036). A recipe is data: an
// edit list of operations that need no pointed position, and the rules for
// the files a batch writes. It never holds a path: the folder a batch writes
// into is chosen in main's dialog and named to the renderer by a handle.
import {
  EDIT_OPS,
  MAX_DPI,
  MAX_JPEG_QUALITY,
  METADATA_POLICIES,
  SAVE_FORMATS,
  editListProblem,
  type EditList,
  type EditOpKind,
  type MetadataPolicy,
  type SaveFormat,
} from "./edit"
import type { JobSource } from "./rpc"

export const RECIPE_VERSION = 1
export const MAX_RECIPE_OPS = 64
export const MAX_RECIPE_NAME_CHARS = 80
export const MAX_TEMPLATE_CHARS = 120
/** Pictures a plan offers to judge a recipe on. */
export const MAX_BATCH_SAMPLES = 12
/** Result names a plan previews. */
export const MAX_PLAN_NAMES = 5

/** Operations that point at a place in one picture: a recipe cannot hold them. */
export const FREEHAND_OPS = [
  "draw",
  "clone",
  "heal",
  "redeye",
] as const satisfies readonly EditOpKind[]
const freehand: ReadonlySet<string> = new Set(FREEHAND_OPS)
/** Whether an operation can run over other pictures (imaging.OpInfo.Batchable). */
export const isBatchOp = (kind: string): boolean =>
  (EDIT_OPS as readonly string[]).includes(kind) && !freehand.has(kind)

/** "keep": each picture's own format (one that can't be written, WebP, becomes PNG). */
export const BATCH_FORMATS = ["keep", ...SAVE_FORMATS] as const
export type BatchFormat = "keep" | SaveFormat

/** beside: next to each original; folder: one chosen folder; replace: the original goes to the trash. */
export const BATCH_DESTINATIONS = ["beside", "folder", "replace"] as const
export type BatchDestination = (typeof BATCH_DESTINATIONS)[number]

/** What happens when the name is taken; "replace" sends the file with that name to the trash first. */
export const BATCH_CONFLICTS = ["keepBoth", "skip", "replace"] as const
export type BatchConflict = (typeof BATCH_CONFLICTS)[number]

/** The default name templates: beside the original a copy must not take its name. */
export const TEMPLATE_BESIDE = "{name}-edited"
export const TEMPLATE_FOLDER = "{name}"

export interface RecipeOutput {
  format: BatchFormat
  /** JPEG quality 1..100; absent or 0 is the default. */
  quality?: number
  metadata: MetadataPolicy
  /** The resolution to write; absent or 0 keeps each picture's. */
  dpi?: number
  destination: BatchDestination
  /** A file name without its extension, with {tokens}; absent or "" is the destination's default. */
  template?: string
  conflict: BatchConflict
}

export interface Recipe {
  version: number
  ops: EditList
  output: RecipeOutput
}

/** Tokens every picture has; `n` is its number in the batch ({n:3} pads it), `exif.<tag>` an EXIF tag. */
export const NAME_TOKENS = [
  "name",
  "filename",
  "ext",
  "folder",
  "date",
  "time",
  "year",
  "month",
  "day",
  "width",
  "height",
] as const

const TOKEN = /\{([A-Za-z0-9._]+)(?::([1-9]))?\}/g
const known: ReadonlySet<string> = new Set(NAME_TOKENS)
const knownToken = (name: string): boolean =>
  name === "n" || known.has(name) || (name.startsWith("exif.") && name.length > 5)

/** The tokens of a template, lower case; `{n:3}` is `n`. */
export function templateTokens(template: string): string[] {
  const out: string[] = []
  for (const m of template.matchAll(TOKEN)) {
    const name = m[1]!.toLowerCase()
    if (m[2] === undefined || name === "n") out.push(name)
  }
  return out
}

/** Why a name template cannot be used; null when it can (editor.Recipe.Problems has the same rules). */
export function templateProblem(
  template: string,
): { code: "template" | "unknownToken"; detail: string } | null {
  if (template.length > MAX_TEMPLATE_CHARS) return { code: "template", detail: "too long" }
  if (/[/\\\0]/.test(template)) return { code: "template", detail: "a name, not a path" }
  for (const name of templateTokens(template)) {
    if (!knownToken(name)) return { code: "unknownToken", detail: name }
  }
  const literal = template.replace(TOKEN, (all, name: string, width: string | undefined) =>
    width === undefined || name.toLowerCase() === "n" ? "" : all,
  )
  // eslint-disable-next-line no-control-regex
  if (/[<>:"|?*\u0000-\u001f\u007f]/.test(literal)) {
    return { code: "template", detail: "characters a file name can't have" }
  }
  return null
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const oneOf = (set: readonly string[], v: unknown): boolean =>
  typeof v === "string" && set.includes(v)
const OUTPUT_KEYS = ["format", "quality", "metadata", "dpi", "destination", "template", "conflict"]

/**
 * The structural check main runs on a recipe from a renderer: the operation
 * allowlist, the limits, the token syntax and nothing that names a path.
 * Returns null for a recipe that may reach the sidecar, otherwise the reason.
 * The sidecar checks every operation's parameters and the assets again.
 */
export function recipeProblem(v: unknown): string | null {
  if (!isPlain(v)) return "expected a recipe"
  const keys = Object.keys(v)
  if (keys.length !== 3 || !["version", "ops", "output"].every((k) => keys.includes(k))) {
    return "a recipe has version, ops and output"
  }
  if (v.version !== RECIPE_VERSION) return "unknown recipe version"
  const listProblem = editListProblem(v.ops)
  if (listProblem) return listProblem
  const ops = v.ops as EditList
  if (ops.length > MAX_RECIPE_OPS) return `at most ${MAX_RECIPE_OPS} operations`
  for (const op of ops) {
    if (!isBatchOp(op.op)) return `${op.op} can't run on several pictures`
  }
  const o = v.output
  if (!isPlain(o) || !Object.keys(o).every((k) => OUTPUT_KEYS.includes(k))) {
    return "expected an output"
  }
  if (!oneOf(BATCH_FORMATS, o.format)) return "unknown format"
  if (!oneOf(METADATA_POLICIES, o.metadata)) return "unknown metadata policy"
  if (!oneOf(BATCH_DESTINATIONS, o.destination)) return "unknown destination"
  if (!oneOf(BATCH_CONFLICTS, o.conflict)) return "unknown conflict policy"
  if (o.destination === "replace" && o.format !== "keep") {
    return "replacing the originals keeps their format"
  }
  if (
    o.quality !== undefined &&
    !(
      Number.isInteger(o.quality) &&
      (o.quality as number) >= 0 &&
      (o.quality as number) <= MAX_JPEG_QUALITY
    )
  ) {
    return "quality is 1..100"
  }
  if (
    o.dpi !== undefined &&
    !(typeof o.dpi === "number" && Number.isFinite(o.dpi) && o.dpi >= 0 && o.dpi <= MAX_DPI)
  ) {
    return "resolution is 1..10000 dpi"
  }
  if (o.template !== undefined) {
    if (typeof o.template !== "string") return "the name template is text"
    const problem = templateProblem(o.template)
    if (problem) {
      return problem.code === "unknownToken"
        ? `unknown token {${problem.detail}}`
        : `the name template: ${problem.detail}`
    }
  }
  return null
}

// The plan ------------------------------------------------------------------

export const RECIPE_PROBLEM_CODES = [
  "version",
  "tooManyOps",
  "notBatchable",
  "invalidOp",
  "missingAsset",
  "unknownToken",
  "template",
  "format",
  "quality",
  "metadata",
  "dpi",
  "destination",
  "conflict",
] as const
export type RecipeProblemCode = (typeof RECIPE_PROBLEM_CODES)[number]

/** One reason a recipe cannot run; the UI words it. */
export interface RecipeProblem {
  code: RecipeProblemCode
  /** The operation it is about; "" for the output. */
  op: string
  /** The token, or what the operation's check said. */
  detail: string
}

/** Why part of a selection is left out of a batch. */
export const BATCH_SKIP_REASONS = [
  "folder",
  "video",
  "other",
  "unsupported",
  "notWritable",
] as const
export type BatchSkipReason = (typeof BATCH_SKIP_REASONS)[number]

export const BATCH_WARNINGS = ["trashUnavailable", "formatChange", "alphaLoss"] as const
export type BatchWarning = (typeof BATCH_WARNINGS)[number]

export interface BatchSample {
  id: number
  name: string
}

/** What a batch would do, for the summary before Run; no pixels are read for it. */
export interface BatchPlanResult {
  /** Pictures the batch edits. */
  count: number
  skipped: { reason: BatchSkipReason; count: number }[]
  /** The files the first pictures become. */
  names: string[]
  /** What the pictures take now, and what the results will, roughly. */
  bytes: number
  estimateBytes: number
  warnings: BatchWarning[]
  problems: RecipeProblem[]
  /** Pictures to judge the recipe on: the first, the last and some between. */
  samples: BatchSample[]
}

/** Renderer → main: the selection, the recipe and, for a "folder" output, the handle of the picked folder. */
export interface BatchParams {
  source: JobSource
  recipe: Recipe
  folderId?: string
}

/** Main → sidecar: the same with the folder's path. */
export interface EditBatchParams {
  source: JobSource
  recipe: Recipe
  folder?: string
}

/** A folder picked in main's dialog: a handle, and the name to show. */
export interface BatchFolder {
  folderId: string
  name: string
}
export const BATCH_FOLDER_ID = /^[0-9a-f]{16}$/

export interface BatchPickFolderResult {
  /** null when the dialog was cancelled. */
  folder: BatchFolder | null
}

// Saved recipes -------------------------------------------------------------

/** The recipes every installation starts with; the UI words their names. */
export const BUILTIN_RECIPES = [
  "web1600",
  "email1024",
  "thumb256",
  "print10x15",
  "watermark",
  "bwContrast",
] as const
export type BuiltinRecipe = (typeof BUILTIN_RECIPES)[number]

export interface StoredRecipe {
  /** The saved recipe's id; 0 for a built-in one. */
  id: number
  /** The built-in recipe's key; "" for a saved one. */
  builtin: string
  name: string
  recipe: Recipe
}

export interface RecipeListResult {
  recipes: StoredRecipe[]
}

export interface RecipeSaveParams {
  /** 0: a new recipe, or the one that has this name; otherwise the recipe to change. */
  id: number
  name: string
  recipe: Recipe
}

export interface RecipeSaveResult {
  id: number
  name: string
}

export interface RecipeDeleteParams {
  id: number
}
