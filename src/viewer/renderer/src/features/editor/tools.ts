// The editor's tools. A tool makes or edits one operation of the edit list;
// the registry feeds the tool rail (by group), the tool search and the edit
// stack. Stage 12 brought geometry, Stage 13 tone, color and detail, Stage 14
// the effects; later stages add tools here without touching the shell.
import type { EditList, EditOp, EditOpKind } from "@panelyth/contracts"
import { msg, t } from "@panelyth/i18n"

export type ToolGroup = "adjust" | "color" | "detail" | "effects" | "retouch" | "geometry" | "looks"

/** A tool is an operation's panel, or a panel without an operation of its own (the looks). */
export type ToolId = EditOpKind | "looks"

export interface ToolDef {
  id: ToolId
  group: ToolGroup
  label: string
  /** Extra words the tool search matches (English and the interface language). */
  keywords: string
  /**
   * "live": the operation is in the edit list while its panel is open and
   * follows the controls. "gesture": the tool draws on the canvas and adds
   * the operation on Apply. "panel": the panel adds operations itself.
   * "paint": the pointer makes strokes on the canvas, each an edit.
   */
  mode: "live" | "gesture" | "panel" | "paint"
}

export const TOOL_GROUPS: readonly { id: ToolGroup; label: string }[] = [
  { id: "adjust", label: msg("Adjust") },
  { id: "color", label: msg("Color") },
  { id: "detail", label: msg("Detail") },
  { id: "effects", label: msg("Effects") },
  { id: "retouch", label: msg("Draw and retouch") },
  { id: "geometry", label: msg("Geometry") },
  { id: "looks", label: msg("Looks") },
]

const tool = (
  id: ToolId,
  group: ToolGroup,
  label: string,
  keywords: string,
  mode: ToolDef["mode"] = "live",
): ToolDef => ({ id, group, label, keywords, mode })

export const TOOLS: readonly ToolDef[] = [
  tool(
    "lighting",
    "adjust",
    msg("Lighting"),
    msg("lighting exposure brightness contrast gamma shadows highlights"),
  ),
  tool(
    "colors",
    "adjust",
    msg("Colors"),
    msg("colors saturation vibrance hue temperature tint balance"),
  ),
  tool("levels", "adjust", msg("Levels"), msg("levels black white point gamma histogram")),
  tool("curves", "adjust", msg("Curves"), msg("curves tone curve points")),
  tool("grayscale", "color", msg("Grayscale"), msg("grayscale black and white monochrome mixer")),
  tool("sepia", "color", msg("Sepia"), msg("sepia brown tone old")),
  tool("negative", "color", msg("Negative"), msg("negative invert")),
  tool("replaceColor", "color", msg("Replace color"), msg("replace swap change color recolor")),
  tool("swapChannels", "color", msg("Swap channels"), msg("swap channels red green blue order")),
  tool(
    "reduceColors",
    "color",
    msg("Reduce colors"),
    msg("reduce colors palette indexed dither posterize"),
  ),
  tool("sharpen", "detail", msg("Sharpen"), msg("sharpen unsharp mask detail")),
  tool("blur", "detail", msg("Blur"), msg("blur gaussian box motion soften")),
  tool("denoise", "detail", msg("Reduce noise"), msg("noise denoise grain smooth")),
  tool("border", "effects", msg("Border"), msg("border frame edge shadow polaroid rounded")),
  tool("frameMask", "effects", msg("Frame mask"), msg("frame mask vignette oval circle feather")),
  tool("watermark", "effects", msg("Watermark"), msg("watermark text logo stamp copyright")),
  tool("obscure", "effects", msg("Obscure"), msg("obscure blur pixelate censor hide face plate")),
  tool("lens", "effects", msg("Lens"), msg("lens bulge pinch barrel distort magnify")),
  tool("bump", "effects", msg("Bump map"), msg("bump map emboss relief texture")),
  tool("sketch", "effects", msg("Sketch"), msg("sketch pencil ink drawing")),
  tool("oil", "effects", msg("Oil painting"), msg("oil painting paint brush")),
  tool(
    "draw",
    "retouch",
    msg("Draw"),
    msg("draw brush pen eraser line arrow rectangle ellipse text fill"),
    "paint",
  ),
  tool("clone", "retouch", msg("Clone"), msg("clone stamp copy patch"), "paint"),
  tool("heal", "retouch", msg("Heal"), msg("heal spot blemish dust scratch repair"), "paint"),
  tool("redeye", "retouch", msg("Red-eye"), msg("red eye pupil flash"), "paint"),
  tool("rotate", "geometry", msg("Rotate"), msg("rotate straighten angle turn horizon")),
  tool("flip", "geometry", msg("Flip"), msg("flip mirror horizontal vertical"), "panel"),
  tool("crop", "geometry", msg("Crop"), msg("crop cut trim ratio"), "gesture"),
  tool("resize", "geometry", msg("Resize"), msg("resize scale size pixels percent print")),
  tool("canvas", "geometry", msg("Canvas size"), msg("canvas border margin pad extend")),
  tool("dpi", "geometry", msg("Set DPI"), msg("dpi resolution print density")),
  tool("looks", "looks", msg("Looks"), msg("looks presets styles filters"), "panel"),
]

const byId: ReadonlyMap<string, ToolDef> = new Map(TOOLS.map((def) => [def.id, def]))

export function toolDef(id: ToolId): ToolDef {
  return byId.get(id)!
}

/** Tools whose label or keywords contain every word of the query. */
export function searchTools(query: string): ToolDef[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return [...TOOLS]
  return TOOLS.filter((def) => {
    const hay = `${def.label} ${t(def.label)} ${def.keywords} ${t(def.keywords)}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}

export interface ImageFacts {
  /** The size and resolution the picture has before the new operation. */
  width: number
  height: number
  dpi: number
}

/** The straight line: a curve that changes nothing. */
export const IDENTITY_CURVE: [number, number][] = [
  [0, 0],
  [255, 255],
]

/** The operation a tool starts with: one that changes nothing where the tool has such a state. */
export function defaultOp(kind: EditOpKind, image: ImageFacts): EditOp {
  switch (kind) {
    case "rotate":
      return { op: "rotate", p: { angle: 0, mode: "crop", fill: "#ffffff" } }
    case "flip":
      return { op: "flip", p: { axis: "h" } }
    case "crop":
      return { op: "crop", p: { rect: { x: 0, y: 0, w: 1, h: 1 } } }
    case "resize":
      return {
        op: "resize",
        p: { mode: "pixels", w: image.width, h: 0, algo: "lanczos3", noEnlarge: false },
      }
    case "canvas":
      return {
        op: "canvas",
        p: { w: image.width, h: image.height, anchor: "c", fill: "#ffffff" },
      }
    case "dpi":
      return { op: "dpi", p: { x: image.dpi > 0 ? image.dpi : 300, resample: false } }
    case "lighting":
      return { op: "lighting", p: {} }
    case "colors":
      return { op: "colors", p: {} }
    case "levels":
      return { op: "levels", p: {} }
    case "curves":
      return { op: "curves", p: {} }
    case "grayscale":
      return { op: "grayscale", p: { method: "luminance" } }
    case "sepia":
      return { op: "sepia", p: { strength: 80, tone: 0 } }
    case "negative":
      return { op: "negative", p: {} }
    case "swapChannels":
      return { op: "swapChannels", p: { order: "bgr" } }
    case "replaceColor":
      return {
        op: "replaceColor",
        p: { from: "#ff0000", to: "#0000ff", tolerance: 20, softness: 20, keepLuminance: true },
      }
    case "sharpen":
      return { op: "sharpen", p: { amount: 0, radius: 1, threshold: 0 } }
    case "blur":
      return { op: "blur", p: { type: "gaussian", radius: 0 } }
    case "denoise":
      return { op: "denoise", p: { luminance: 0, color: 0, detail: 50, quality: "fast" } }
    case "reduceColors":
      return { op: "reduceColors", p: { count: 16, quantizer: "median", dither: "fs" } }
    case "border":
      return { op: "border", p: { style: "solid", width: 0, color: "#ffffff" } }
    case "frameMask":
      return { op: "frameMask", p: { shape: "rounded", radius: 10, feather: 0, inset: 0 } }
    case "watermark":
      return {
        op: "watermark",
        p: {
          kind: "text",
          text: "© {year} {name}",
          size: 5,
          color: "#ffffff",
          opacity: 60,
          anchor: "se",
          margin: 3,
        },
      }
    case "obscure":
      return {
        op: "obscure",
        p: {
          method: "blur",
          strength: 60,
          shape: "rect",
          rect: { x: 0.35, y: 0.35, w: 0.3, h: 0.3 },
          feather: 0,
        },
      }
    case "lens":
      return { op: "lens", p: { mode: "bulge", amount: 0, cx: 0.5, cy: 0.5, radius: 50, soft: 30 } }
    case "bump":
      return { op: "bump", p: { height: 0, angle: 135, elevation: 45, smooth: 1, color: 0 } }
    case "sketch":
      return { op: "sketch", p: { style: "pencil", detail: 60, strength: 40, paper: 0, color: 60 } }
    case "oil":
      return { op: "oil", p: { radius: 4, levels: 20 } }
    // The paint tools make their operations from strokes; these are only
    // what an empty one looks like.
    case "draw":
      return { op: "draw", p: { strokes: [] } }
    case "clone":
      return { op: "clone", p: { size: 2, source: [0, 0], points: [[0, 0]] } }
    case "heal":
      return { op: "heal", p: { size: 2, points: [[0, 0]] } }
    case "redeye":
      return { op: "redeye", p: { rect: { x: 0, y: 0, w: 0.05, h: 0.05 } } }
  }
}

/** Tools without a neutral state: opening the panel is choosing them, so it adds the operation. */
export const ADDS_ON_OPEN: ReadonlySet<ToolId> = new Set<ToolId>([
  "grayscale",
  "sepia",
  "negative",
  "swapChannels",
  "reduceColors",
  // Stage 14: a mask, a mark, a region and the two painterly looks are there once chosen.
  "frameMask",
  "watermark",
  "obscure",
  "sketch",
  "oil",
])

const zero = (v: number | undefined): boolean => v === undefined || v === 0
const straight = (c: [number, number][] | undefined): boolean =>
  c === undefined ||
  (c.length === 2 && c[0]![0] === 0 && c[0]![1] === 0 && c[1]![0] === 255 && c[1]![1] === 255)

/** True when the operation changes nothing, so a panel that was only opened leaves no entry behind. */
export function isNoOp(op: EditOp, image: ImageFacts): boolean {
  switch (op.op) {
    case "rotate":
      return op.p.angle % 360 === 0
    case "crop": {
      const r = op.p.rect
      return r.x <= 0 && r.y <= 0 && r.w >= 1 && r.h >= 1
    }
    case "resize":
      return (
        (op.p.mode === "pixels" &&
          (op.p.w === 0 || op.p.w === image.width) &&
          (op.p.h === 0 || op.p.h === image.height)) ||
        (op.p.mode === "percent" && op.p.w === 100 && (op.p.h === 0 || op.p.h === 100))
      )
    case "canvas":
      return (op.p.w === 0 || op.p.w === image.width) && (op.p.h === 0 || op.p.h === image.height)
    case "dpi":
      return !op.p.resample && op.p.x === image.dpi && (op.p.y ?? op.p.x) === image.dpi
    case "lighting": {
      const p = op.p
      return (
        zero(p.exposure) &&
        zero(p.brightness) &&
        zero(p.contrast) &&
        (p.gamma === undefined || p.gamma === 1) &&
        zero(p.highlights) &&
        zero(p.shadows) &&
        zero(p.whites) &&
        zero(p.blacks)
      )
    }
    case "colors": {
      const p = op.p
      const b = p.balance
      return (
        zero(p.saturation) &&
        zero(p.vibrance) &&
        zero(p.hue) &&
        zero(p.temperature) &&
        zero(p.tint) &&
        (!b || [...b.shadows, ...b.midtones, ...b.highlights].every((v) => v === 0))
      )
    }
    case "levels":
      return (
        !op.p.auto &&
        [op.p.l, op.p.r, op.p.g, op.p.b].every(
          (c) =>
            !c ||
            (c.inBlack === 0 &&
              c.inWhite === 255 &&
              (c.gamma ?? 1) === 1 &&
              c.outBlack === 0 &&
              c.outWhite === 255),
        )
      )
    case "curves":
      return straight(op.p.l) && straight(op.p.r) && straight(op.p.g) && straight(op.p.b)
    case "sepia":
      return op.p.strength === 0
    case "swapChannels":
      return op.p.order === "rgb"
    case "replaceColor":
      return op.p.from.toLowerCase() === op.p.to.toLowerCase()
    case "sharpen":
      return op.p.amount === 0
    case "blur":
      return op.p.radius === 0
    case "denoise":
      return op.p.luminance === 0 && zero(op.p.color)
    case "border":
      return (
        op.p.width === 0 &&
        zero(op.p.radius) &&
        (op.p.inside || (zero(op.p.blur) && zero(op.p.offset)))
      )
    case "watermark":
      return op.p.opacity === 0 || ((op.p.kind ?? "text") === "text" && !op.p.text)
    case "lens":
      return op.p.amount === 0
    case "bump":
      return op.p.height === 0
    case "draw":
      return op.p.strokes.length === 0
    case "clone":
    case "heal":
    case "redeye":
    case "flip":
    case "grayscale":
    case "negative":
    case "reduceColors":
    case "frameMask":
    case "obscure":
    case "sketch":
    case "oil":
      return false
  }
}

const trim = (n: number, digits = 1): string => String(Number(n.toFixed(digits)))
const signed = (n: number): string => (n > 0 ? `+${trim(n)}` : trim(n))

/** A few words about an operation for its chip in the edit stack. */
export function describeOp(op: EditOp): string {
  switch (op.op) {
    case "rotate":
      return `${trim(op.p.angle)}°`
    case "flip":
      return op.p.axis === "h" ? t("Horizontal") : t("Vertical")
    case "crop":
      return `${trim(op.p.rect.w * 100, 0)} × ${trim(op.p.rect.h * 100, 0)} %`
    case "resize":
      switch (op.p.mode) {
        case "percent":
          return `${trim(op.p.w)} %`
        case "print":
          return `${trim(op.p.w || op.p.h)} ${op.p.unit ?? "cm"}`
        default:
          return op.p.w && op.p.h ? `${op.p.w} × ${op.p.h}` : `${op.p.w || op.p.h} px`
      }
    case "canvas":
      return `${op.p.w || "–"} × ${op.p.h || "–"}`
    case "dpi":
      return `${trim(op.p.x)} dpi`
    case "lighting": {
      const p = op.p
      const v = [p.exposure, p.brightness, p.contrast, p.highlights, p.shadows].find(
        (x) => !zero(x),
      )
      if (v !== undefined) return signed(v)
      return p.gamma && p.gamma !== 1 ? `γ ${trim(p.gamma, 2)}` : ""
    }
    case "colors": {
      const v = [op.p.saturation, op.p.vibrance, op.p.temperature, op.p.tint, op.p.hue].find(
        (x) => !zero(x),
      )
      return v === undefined ? "" : signed(v)
    }
    case "levels":
      return op.p.auto ? t("auto") : op.p.l ? `${op.p.l.inBlack}–${op.p.l.inWhite}` : ""
    case "curves":
    case "grayscale":
    case "negative":
      return ""
    case "sepia":
      return `${trim(op.p.strength, 0)} %`
    case "swapChannels":
      return op.p.order.toUpperCase()
    case "replaceColor":
      return `${op.p.from} → ${op.p.to}`
    case "sharpen":
      return `${trim(op.p.amount, 0)} %`
    case "blur":
      return `${trim(op.p.radius)} px`
    case "denoise":
      return trim(op.p.luminance, 0)
    case "reduceColors":
      return String(op.p.count)
    case "border":
      return `${trim(op.p.width)} ${op.p.unit === "px" ? "px" : "%"}`
    case "watermark":
      return (op.p.kind ?? "text") === "image"
        ? t("image")
        : (op.p.text ?? "").split("\n")[0]!.slice(0, 16)
    case "lens":
      return `${trim(op.p.amount, 0)} %`
    case "bump":
      return `${trim(op.p.height, 0)} %`
    case "obscure":
      return `${trim(op.p.strength, 0)} %`
    case "oil":
      return `${trim(op.p.radius)} px`
    case "frameMask":
    case "sketch":
    case "clone":
    case "heal":
    case "redeye":
      return ""
    case "draw":
      return String(op.p.strokes.length)
  }
}

export interface Look {
  id: string
  label: string
  ops: EditList
}

/** Presets: each is ordinary operations, so it can be tuned afterwards in the edit stack. */
export const LOOKS: readonly Look[] = [
  {
    id: "bw",
    label: msg("Black and white"),
    ops: [{ op: "grayscale", p: { method: "luminance" } }],
  },
  {
    id: "bw-contrast",
    label: msg("Strong black and white"),
    ops: [
      { op: "grayscale", p: { method: "mixer", mix: [60, 50, -10] } },
      { op: "lighting", p: { contrast: 45 } },
    ],
  },
  { id: "sepia", label: msg("Sepia"), ops: [{ op: "sepia", p: { strength: 85, tone: 10 } }] },
  { id: "negative", label: msg("Negative"), ops: [{ op: "negative", p: {} }] },
  {
    id: "vivid",
    label: msg("Vivid"),
    ops: [
      { op: "colors", p: { vibrance: 55, saturation: 10 } },
      { op: "lighting", p: { contrast: 15 } },
    ],
  },
  {
    id: "soft",
    label: msg("Soft"),
    ops: [
      { op: "lighting", p: { contrast: -25, shadows: 20 } },
      { op: "colors", p: { saturation: -15 } },
    ],
  },
  { id: "warm", label: msg("Warm"), ops: [{ op: "colors", p: { temperature: 35, tint: 5 } }] },
  { id: "cool", label: msg("Cool"), ops: [{ op: "colors", p: { temperature: -35 } }] },
  {
    id: "faded",
    label: msg("Faded"),
    ops: [
      {
        op: "curves",
        p: {
          l: [
            [0, 34],
            [128, 132],
            [255, 232],
          ],
        },
      },
      { op: "colors", p: { saturation: -25 } },
    ],
  },
  {
    id: "punch",
    label: msg("Punch"),
    ops: [
      {
        op: "curves",
        p: {
          l: [
            [0, 0],
            [64, 46],
            [192, 212],
            [255, 255],
          ],
        },
      },
    ],
  },
  {
    id: "cross",
    label: msg("Cross-process"),
    ops: [
      {
        op: "curves",
        p: {
          r: [
            [0, 0],
            [90, 60],
            [180, 215],
            [255, 255],
          ],
          g: [
            [0, 0],
            [128, 150],
            [255, 245],
          ],
          b: [
            [0, 35],
            [255, 215],
          ],
        },
      },
    ],
  },
  {
    id: "bright",
    label: msg("Brighten"),
    ops: [{ op: "lighting", p: { exposure: 0.4, shadows: 25 } }],
  },
  // Stage 14: effects as looks.
  {
    id: "vignette",
    label: msg("Vignette"),
    ops: [{ op: "frameMask", p: { shape: "vignette", strength: 55, feather: 30 } }],
  },
  {
    id: "polaroid",
    label: msg("Instant photo"),
    ops: [
      { op: "colors", p: { saturation: -10, temperature: 10 } },
      { op: "border", p: { style: "polaroid", width: 5, color: "#fbf9f4" } },
    ],
  },
  {
    id: "pencil",
    label: msg("Pencil sketch"),
    ops: [{ op: "sketch", p: { style: "pencil", detail: 60, strength: 45, paper: 30 } }],
  },
  { id: "oil", label: msg("Oil painting"), ops: [{ op: "oil", p: { radius: 4, levels: 20 } }] },
]

/** Curve presets for the curves tool. */
export const CURVE_PRESETS: readonly { id: string; label: string; points: [number, number][] }[] = [
  { id: "linear", label: msg("Straight"), points: IDENTITY_CURVE },
  {
    id: "contrast",
    label: msg("More contrast"),
    points: [
      [0, 0],
      [64, 48],
      [192, 208],
      [255, 255],
    ],
  },
  {
    id: "soft",
    label: msg("Less contrast"),
    points: [
      [0, 0],
      [64, 80],
      [192, 176],
      [255, 255],
    ],
  },
  {
    id: "lighten",
    label: msg("Lighten"),
    points: [
      [0, 0],
      [128, 160],
      [255, 255],
    ],
  },
  {
    id: "darken",
    label: msg("Darken"),
    points: [
      [0, 0],
      [128, 96],
      [255, 255],
    ],
  },
  {
    id: "invert",
    label: msg("Invert"),
    points: [
      [0, 255],
      [255, 0],
    ],
  },
]
