// Batch mode of the image editor (Stage 16, ADR-0036): the structural check
// of a recipe from a renderer, and the guards for what the sidecar answers.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  BATCH_FOLDER_ID,
  BUILTIN_RECIPES,
  COMMANDER_METHODS,
  EDIT_OPS,
  FREEHAND_OPS,
  JOB_ITEM_ERROR_CODES,
  JOB_KINDS,
  MAIN_METHODS,
  MAX_RECIPE_OPS,
  MAX_TEMPLATE_CHARS,
  VIEWER_METHODS,
  isBatchOp,
  isBatchPlanResult,
  isRecipeListResult,
  isResponseFrame,
  recipeProblem,
  sidecarResultGuards,
  templateProblem,
  templateTokens,
  type Recipe,
} from "../src"

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures")
const load = (name: string): { r: Record<string, unknown> } => {
  const frame: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"))
  if (!isResponseFrame(frame) || !frame.ok) throw new Error(`${name} is not a success`)
  return frame as { r: Record<string, unknown> }
}

const output = {
  format: "jpeg",
  quality: 85,
  metadata: "keep",
  destination: "beside",
  template: "{name}-web",
  conflict: "keepBoth",
} as const
const recipe: Recipe = {
  version: 1,
  ops: [
    { op: "resize", p: { mode: "fit", w: 1600, h: 1600, noEnlarge: true } },
    { op: "watermark", p: { text: "© {year} {exif.model}", size: 4, anchor: "se" } },
  ],
  output,
}
const withOutput = (change: object): unknown => ({ ...recipe, output: { ...output, ...change } })

describe("recipeProblem", () => {
  it("accepts the recipes the batch editor builds", () => {
    expect(recipeProblem(recipe)).toBeNull()
    expect(recipeProblem({ version: 1, ops: [], output: { ...output, template: "" } })).toBeNull()
    expect(
      recipeProblem(
        withOutput({ format: "keep", destination: "replace", template: undefined, quality: 0 }),
      ),
    ).toBeNull()
    expect(
      recipeProblem({
        version: 1,
        ops: [],
        output: { format: "png", metadata: "strip", destination: "folder", conflict: "skip" },
      }),
    ).toBeNull()
    expect(
      recipeProblem({
        ...recipe,
        ops: Array.from({ length: MAX_RECIPE_OPS }, () => recipe.ops[0]),
      }),
    ).toBeNull()
  })

  it("holds every operation but the free-hand ones", () => {
    for (const op of EDIT_OPS) {
      const freehand = (FREEHAND_OPS as readonly string[]).includes(op)
      expect(isBatchOp(op), op).toBe(!freehand)
      const problem = recipeProblem({ ...recipe, ops: [{ op, p: {} }] })
      if (freehand) expect(problem, op).toContain("several pictures")
      else expect(problem, op).toBeNull()
    }
    expect(isBatchOp("exec")).toBe(false)
  })

  it.each([
    ["not an object", [recipe]],
    ["a string", JSON.stringify(recipe)],
    ["a missing part", { version: 1, ops: [] }],
    ["something more than a recipe", { ...recipe, run: "calc.exe" }],
    ["another version", { ...recipe, version: 2 }],
    ["an unknown operation", { ...recipe, ops: [{ op: "shell", p: { cmd: "calc" } }] }],
    [
      "too many operations",
      { ...recipe, ops: Array.from({ length: MAX_RECIPE_OPS + 1 }, () => recipe.ops[0]) },
    ],
    ["an output that is no object", { ...recipe, output: "jpeg" }],
    ["a folder in the output", withOutput({ folder: "C:\\out" })],
    ["a path in the output", withOutput({ path: "/tmp/x" })],
    ["an unknown format", withOutput({ format: "webp" })],
    ["an unknown metadata policy", withOutput({ metadata: "all" })],
    ["a destination that is a path", withOutput({ destination: "C:\\out" })],
    ["the ask policy", withOutput({ conflict: "ask" })],
    ["replacing in another format", withOutput({ destination: "replace" })],
    ["a quality out of range", withOutput({ quality: 101 })],
    ["a fractional quality", withOutput({ quality: 80.5 })],
    ["a negative resolution", withOutput({ dpi: -1 })],
    ["a resolution that is no number", withOutput({ dpi: "300" })],
    ["a template that is no text", withOutput({ template: 5 })],
    ["a template with a folder", withOutput({ template: "out/{name}" })],
    ["a template that climbs", withOutput({ template: "..\\{name}" })],
    ["a template with an unknown token", withOutput({ template: "{name}-{user}" })],
    ["a template that is too long", withOutput({ template: "x".repeat(MAX_TEMPLATE_CHARS + 1) })],
    ["a template with characters a name can't have", withOutput({ template: "{name}: final?" })],
  ])("rejects %s", (_name, value) => {
    expect(recipeProblem(value)).not.toBeNull()
  })
})

describe("name templates", () => {
  it("finds the tokens, whatever their case", () => {
    expect(templateTokens("{Name}_{n:3}-{EXIF.Model} {} {a b} {n:0}")).toEqual([
      "name",
      "n",
      "exif.model",
    ])
    expect(templateTokens("plain")).toEqual([])
  })

  it("accepts what the sidecar accepts", () => {
    for (const template of [
      "",
      "{name}",
      "{n:4}-{name}",
      "{folder} {date} {width}x{height}",
      "{name} {exif.lens}",
      "{name} {} {a b}",
      "IMG ({n})",
    ]) {
      expect(templateProblem(template), template).toBeNull()
    }
  })

  it.each([
    ["{who}", "unknownToken", "who"],
    ["{name}-{exif.}", "unknownToken", "exif."],
    ["a/b", "template", "a name, not a path"],
    ["a\\b", "template", "a name, not a path"],
    ["{name}: {n:0}?", "template", "characters a file name can't have"],
    ["{name:3}", "template", "characters a file name can't have"],
    ["x".repeat(MAX_TEMPLATE_CHARS + 1), "template", "too long"],
  ])("refuses %s", (template, code, detail) => {
    expect(templateProblem(template)).toEqual({ code, detail })
  })
})

describe("what the sidecar answers", () => {
  const plan = load("res-edit.plan.json").r

  it("a plan holds names, never paths", () => {
    expect(isBatchPlanResult(plan)).toBe(true)
    expect(plan).toMatchObject({ count: 2, names: ["photo_0000-half.jpg", "photo_0001-half.jpg"] })
    for (const bad of [
      { ...plan, names: ["C:\\out\\a.jpg"] },
      { ...plan, names: ["/out/a.jpg"] },
      { ...plan, names: Array.from({ length: 6 }, () => "a.jpg") },
      { ...plan, samples: [{ id: 1, name: "sub/a.jpg" }] },
      { ...plan, samples: [{ id: 0, name: "a.jpg" }] },
      { ...plan, samples: Array.from({ length: 13 }, (_, i) => ({ id: i + 1, name: "a.jpg" })) },
      { ...plan, skipped: [{ reason: "boring", count: 1 }] },
      { ...plan, warnings: ["anything"] },
      { ...plan, problems: [{ code: "nope", op: "", detail: "" }] },
      { ...plan, count: -1 },
      { ...plan, estimateBytes: 1.5 },
    ]) {
      expect(isBatchPlanResult(bad), JSON.stringify(bad).slice(0, 120)).toBe(false)
    }
    expect(
      isBatchPlanResult({
        ...plan,
        skipped: [{ reason: "video", count: 3 }],
        warnings: ["trashUnavailable", "formatChange", "alphaLoss"],
        problems: [{ code: "notBatchable", op: "draw", detail: "" }],
      }),
    ).toBe(true)
  })

  it("the stored recipes are recipes a renderer could have sent", () => {
    const list = load("res-recipe.list.json").r
    expect(isRecipeListResult(list)).toBe(true)
    const recipes = list.recipes as { builtin: string; id: number; name: string }[]
    // The built-in ones first, in their order, then the saved one.
    expect(recipes.slice(0, BUILTIN_RECIPES.length).map((r) => r.builtin)).toEqual([
      ...BUILTIN_RECIPES,
    ])
    expect(recipes.at(-1)).toMatchObject({ builtin: "", id: 1, name: "Half size" })
    expect(
      isRecipeListResult({
        recipes: [
          { id: 1, builtin: "", name: "x", recipe: { ...recipe, ops: [{ op: "draw", p: {} }] } },
        ],
      }),
    ).toBe(false)
    expect(isRecipeListResult({ recipes: [{ id: 1, builtin: "", name: "", recipe }] })).toBe(false)
  })

  it("an edit job and its undo are jobs like any other", () => {
    expect(sidecarResultGuards["edit.batch"](load("res-edit.batch.json").r)).toBe(true)
    expect(load("res-edit.batch.json").r).toMatchObject({ kind: "edit", total: 2 })
    expect(sidecarResultGuards["batch.undo"](load("res-batch.undo.json").r)).toBe(true)
    expect(load("res-batch.undo.json").r).toMatchObject({ kind: "undoEdit", total: 2 })
    expect(JOB_KINDS).toContain("edit")
    expect(JOB_KINDS).toContain("undoEdit")
    for (const code of ["DECODE_FAILED", "UNSUPPORTED", "TOO_LARGE", "TRASH_UNAVAILABLE"]) {
      expect(JOB_ITEM_ERROR_CODES as readonly string[]).toContain(code)
    }
  })
})

describe("who may call what", () => {
  const batch = [
    "batch.pickFolder",
    "batch.plan",
    "batch.start",
    "batch.undo",
    "recipe.list",
    "recipe.save",
    "recipe.delete",
  ]

  it("the viewer has batch editing; the commander has none of it (ADR-0027)", () => {
    for (const m of batch) {
      expect(VIEWER_METHODS as readonly string[], m).toContain(m)
      expect(COMMANDER_METHODS as readonly string[], m).not.toContain(m)
    }
  })

  it("the methods that take a folder path are main's alone", () => {
    for (const m of ["edit.plan", "edit.batch"]) {
      expect(VIEWER_METHODS as readonly string[], m).not.toContain(m)
      expect(COMMANDER_METHODS as readonly string[], m).not.toContain(m)
    }
    for (const m of ["batch.pickFolder", "batch.plan", "batch.start"]) {
      expect(MAIN_METHODS as readonly string[], m).toContain(m)
    }
    expect(BATCH_FOLDER_ID.test("0123456789abcdef")).toBe(true)
    expect(BATCH_FOLDER_ID.test("C:\\out")).toBe(false)
  })
})
