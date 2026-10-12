// The image editor's contract (Stage 12, ADR-0035). The methods are in the
// viewer's profile only (ADR-0027). The renderer names a picture by entry id
// and a session by its id; it receives frames as token URLs and never a path.

/** Limits of an edit list; main checks them before anything reaches Go. */
export const MAX_EDIT_OPS = 512
export const MAX_EDIT_LIST_CHARS = 1024 * 1024
/** Nesting of an operation's parameters (a stroke list is the deepest). */
export const MAX_EDIT_DEPTH = 6
export const MAX_EDIT_STRING_CHARS = 4096
/** Numbers in one operation: stroke points count here (ADR-0035: 100k). */
export const MAX_EDIT_NUMBERS = 200_000

/** Pictures above this many pixels are refused for editing. */
export const MAX_EDIT_PIXELS = 100_000_000
export const MAX_EDIT_EDGE = 65_535

/** The long edge of a frame, in device pixels. */
export const MIN_FRAME_EDGE = 64
export const MAX_FRAME_EDGE = 2560

/** Operations of an edit list (imaging.RegisterOp); the list grows with the editor stages. */
export const EDIT_OPS = [
  "rotate",
  "flip",
  "crop",
  "resize",
  "canvas",
  "dpi",
  // Stage 13: tone and color.
  "lighting",
  "colors",
  "levels",
  "curves",
  "grayscale",
  "sepia",
  "negative",
  "swapChannels",
  "replaceColor",
  "sharpen",
  "blur",
  "denoise",
  "reduceColors",
  // Stage 14: effects.
  "border",
  "frameMask",
  "watermark",
  "bump",
  "sketch",
  "oil",
  "lens",
  "obscure",
  // Stage 15: draw and retouch.
  "draw",
  "clone",
  "heal",
  "redeye",
] as const
export type EditOpKind = (typeof EDIT_OPS)[number]

export interface NormalizedRect {
  /** 0..1 of the picture at that step. */
  x: number
  y: number
  w: number
  h: number
}

export const ROTATE_MODES = ["expand", "crop", "fill"] as const
export type RotateMode = (typeof ROTATE_MODES)[number]
export interface RotateParams {
  /** Degrees clockwise, -360..360; multiples of 90 move pixels exactly. */
  angle: number
  mode?: RotateMode
  /** "#rrggbb", "#rrggbbaa" or "transparent". */
  fill?: string
}

export interface FlipParams {
  axis: "h" | "v"
}

export interface CropParams {
  rect: NormalizedRect
}

export const RESIZE_MODES = ["pixels", "percent", "fit", "fill", "print"] as const
export type ResizeMode = (typeof RESIZE_MODES)[number]
export const RESIZE_ALGORITHMS = ["lanczos3", "catmull", "bilinear", "nearest"] as const
export type ResizeAlgorithm = (typeof RESIZE_ALGORITHMS)[number]
export interface ResizeParams {
  mode: ResizeMode
  /** A zero side follows the aspect ratio (pixels, percent, print). */
  w: number
  h: number
  /** print: the unit of w and h. */
  unit?: "cm" | "in"
  dpi?: number
  algo?: ResizeAlgorithm
  noEnlarge?: boolean
}

export const CANVAS_ANCHORS = ["nw", "n", "ne", "w", "c", "e", "sw", "s", "se"] as const
export type CanvasAnchor = (typeof CANVAS_ANCHORS)[number]
export interface CanvasParams {
  /** Pixels; zero keeps that side. */
  w: number
  h: number
  anchor?: CanvasAnchor
  /** A color, "transparent" or "edge" (the border repeats). */
  fill?: string
}

export interface DpiParams {
  x: number
  y?: number
  /** Changes the pixel size to keep the print size; otherwise metadata only. */
  resample?: boolean
}

// Stage 13 --------------------------------------------------------------
// Every value has a default that changes nothing; a missing field is that default.

export interface LightingParams {
  /** Stops, -3..3. */
  exposure?: number
  /** -100..100 each. */
  brightness?: number
  contrast?: number
  /** 0.1..5; 1 changes nothing. */
  gamma?: number
  highlights?: number
  shadows?: number
  whites?: number
  blacks?: number
}

/** Shifts towards red, green and blue, -100..100 each. */
export type BalanceTriple = [number, number, number]
export interface ColorBalance {
  shadows: BalanceTriple
  midtones: BalanceTriple
  highlights: BalanceTriple
}

export interface ColorsParams {
  /** -100..100 each; hue in degrees, -180..180. */
  saturation?: number
  vibrance?: number
  hue?: number
  temperature?: number
  tint?: number
  balance?: ColorBalance
}

export interface LevelsChannel {
  /** 0..255, black below white. */
  inBlack: number
  inWhite: number
  /** 0.1..9.99; 1 changes nothing. */
  gamma?: number
  outBlack: number
  outWhite: number
}

export const LEVELS_CHANNELS = ["l", "r", "g", "b"] as const
export type LevelsChannelName = (typeof LEVELS_CHANNELS)[number]

export interface LevelsParams {
  /** `l` applies to all three channels, then each channel's own. */
  l?: LevelsChannel
  r?: LevelsChannel
  g?: LevelsChannel
  b?: LevelsChannel
  /**
   * Go sets the input range from the picture (for batch): `clip` percent may be cut off at each
   * end, per channel ("rgb") or for all together ("lum"); `gamma` also centres the midtones.
   */
  auto?: { clip: number; mode: "rgb" | "lum"; gamma?: boolean }
}

export const MAX_CURVE_POINTS = 16
/** [in, out], both 0..255; inputs rise. */
export type CurvePoint = [number, number]
export interface CurvesParams {
  l?: CurvePoint[]
  r?: CurvePoint[]
  g?: CurvePoint[]
  b?: CurvePoint[]
}

export const GRAYSCALE_METHODS = ["luminance", "average", "desaturate", "mixer"] as const
export type GrayscaleMethod = (typeof GRAYSCALE_METHODS)[number]
export interface GrayscaleParams {
  method?: GrayscaleMethod
  /** mixer: percent of red, green and blue, -200..200 each. */
  mix?: [number, number, number]
}

export interface SepiaParams {
  /** 0..100. */
  strength: number
  /** -100 (cool) .. 100 (warm). */
  tone?: number
}

export interface NegativeParams {
  /** Any of r, g and b, such as "rg"; all three when absent. */
  channels?: string
}

export const CHANNEL_ORDERS = ["bgr", "rbg", "grb", "gbr", "brg"] as const
export type ChannelOrder = (typeof CHANNEL_ORDERS)[number]
export interface SwapChannelsParams {
  /** Where red, green and blue come from: "bgr" swaps red and blue. */
  order: ChannelOrder | "rgb"
}

export interface ReplaceColorParams {
  /** "#rrggbb". */
  from: string
  to: string
  /** 0..100; 0 replaces that exact color only. */
  tolerance: number
  softness?: number
  keepLuminance?: boolean
}

export interface SharpenParams {
  /** Percent, 0..500. */
  amount: number
  /** Pixels of the full picture, 0.1..20. */
  radius: number
  /** 0..255: smaller differences are left alone. */
  threshold?: number
}

export const BLUR_TYPES = ["gaussian", "box", "motion"] as const
export type BlurType = (typeof BLUR_TYPES)[number]
export interface BlurParams {
  type?: BlurType
  /** Pixels of the full picture, 0..100; for motion, the length. */
  radius: number
  /** motion: degrees, -180..180. */
  angle?: number
}

export interface DenoiseParams {
  /** 0..100 each. */
  luminance: number
  color?: number
  detail?: number
  /** fast: edge-preserving; high: non-local means (slower, keeps texture). */
  quality?: "fast" | "high"
}

export const QUANTIZERS = ["median", "octree", "web", "gray"] as const
export type Quantizer = (typeof QUANTIZERS)[number]
export const DITHERS = ["none", "fs", "ordered4", "ordered8"] as const
export type Dither = (typeof DITHERS)[number]
export interface ReduceColorsParams {
  /** 2..256. */
  count: number
  quantizer?: Quantizer
  dither?: Dither
  keepTransparency?: boolean
}

// Stage 14 --------------------------------------------------------------
// Sizes are percentages of the picture's shorter edge unless a field says
// pixels, so one list looks the same on a small and on a large picture.

export const BORDER_STYLES = ["solid", "double", "bevel", "rounded", "shadow", "polaroid"] as const
export type BorderStyle = (typeof BORDER_STYLES)[number]
export interface BorderParams {
  style?: BorderStyle
  /** Percent of the shorter edge (0..50), or pixels of the full picture (0..4000) with unit "px". */
  width: number
  unit?: "percent" | "px"
  /** "#rrggbb"; color2 is the line between the two of a double frame. */
  color?: string
  color2?: string
  /** 0..100 (100 when absent). */
  opacity?: number
  /** Drawn over the picture's edge; otherwise the canvas grows. */
  inside?: boolean
  /** Rounded corners of the picture, 0..50 percent. */
  radius?: number
  /** A drop shadow (outside frames): softness and distance, 0..20 percent; "#rrggbbaa". */
  blur?: number
  offset?: number
  shadow?: string
  /** Around rounded corners and under the shadow: a color or "transparent". */
  background?: string
}

/** A 32-character id of a picture the user picked (a logo, a mask, a texture); never a path. */
export type AssetId = string
export const ASSET_ID = /^[0-9a-f]{32}$/

export const FRAME_SHAPES = [
  "rounded",
  "ellipse",
  "circle",
  "feather",
  "vignette",
  "custom",
] as const
export type FrameShape = (typeof FRAME_SHAPES)[number]
export interface FrameMaskParams {
  shape?: FrameShape
  /** Percent of the shorter edge: inset 0..45, feather and radius 0..50. */
  inset?: number
  feather?: number
  radius?: number
  /** vignette: 0..100. */
  strength?: number
  invert?: boolean
  /** A color or "transparent" (black for a vignette when absent). */
  background?: string
  /** custom: the picture whose brightness is the mask. */
  assetId?: AssetId
}

export const WATERMARK_BLENDS = ["normal", "multiply", "screen"] as const
export type WatermarkBlend = (typeof WATERMARK_BLENDS)[number]
export const MAX_WATERMARK_CHARS = 1000
export interface WatermarkParams {
  kind?: "text" | "image"
  /** At most 1,000 characters; {name}, {date}, {exif.model}, … are replaced per picture. */
  text?: string
  /** A font family by name; the built-in default when absent or unknown. */
  font?: string
  bold?: boolean
  italic?: boolean
  /** Percent of the shorter edge (0.5..100): a line's height, or the image's longer edge. */
  size: number
  color?: string
  /** 0..100 (100 when absent). */
  opacity?: number
  /** Around the letters, in percent of the text size (0..20). */
  outline?: number
  outlineColor?: string
  shadow?: boolean
  assetId?: AssetId
  /** One of the nine points ("se" when absent) and the distance from the edge, 0..50 percent. */
  anchor?: CanvasAnchor
  margin?: number
  /** Degrees, -180..180. */
  rotation?: number
  /** Repeats over the picture; spacing in percent of the mark's longer side (0..500). */
  tile?: boolean
  spacing?: number
  stagger?: boolean
  blend?: WatermarkBlend
}

export interface BumpParams {
  source?: "picture" | "texture"
  assetId?: AssetId
  /** texture: repeated at its own size instead of stretched. */
  tile?: boolean
  /** Where the light comes from, in degrees (0 right, 90 top), and its height (5..90). */
  angle?: number
  elevation?: number
  /** 0..100. */
  height: number
  /** A blur of the heights in pixels of the full picture, 0..20. */
  smooth?: number
  /** 0 is a gray relief, 100 the picture itself, lit. */
  color?: number
}

export const SKETCH_STYLES = ["pencil", "ink", "color"] as const
export type SketchStyle = (typeof SKETCH_STYLES)[number]
export interface SketchParams {
  style?: SketchStyle
  /** 0..100 each. */
  detail?: number
  strength?: number
  paper?: number
  color?: number
}

export interface OilParams {
  /** Pixels of the full picture, 1..12. */
  radius: number
  /** 4..64 (20 when absent). */
  levels?: number
}

export const LENS_MODES = ["bulge", "pinch", "barrel", "pincushion"] as const
export type LensMode = (typeof LENS_MODES)[number]
export interface LensParams {
  mode?: LensMode
  /** 0..100. */
  amount: number
  /** The centre, 0..1 of the picture (the middle when absent; -1..2 is accepted). */
  cx?: number
  cy?: number
  /** bulge and pinch: percent of the shorter edge (1..200) and the rim's softness (0..100). */
  radius?: number
  soft?: number
}

export const OBSCURE_METHODS = ["blur", "pixelate", "mosaic"] as const
export type ObscureMethod = (typeof OBSCURE_METHODS)[number]
export const OBSCURE_SHAPES = ["rect", "ellipse", "polygon"] as const
export type ObscureShape = (typeof OBSCURE_SHAPES)[number]
export const MAX_POLYGON_POINTS = 256
export interface ObscureParams {
  method?: ObscureMethod
  /** 1..100. */
  strength: number
  shape?: ObscureShape
  /** rect and ellipse: the box, 0..1 of the picture. */
  rect?: NormalizedRect
  /** polygon: 3..256 points, 0..1 of the picture. */
  points?: [number, number][]
  /** Fades the effect out beyond the region, 0..100. */
  feather?: number
  /** Obscures everything but the region. */
  invert?: boolean
}

// Stage 15 --------------------------------------------------------------
// The user points at pixels: these operations belong to one picture and are
// never run over others. Points are 0..1 of the picture, sizes percentages
// of its shorter edge.

export const DRAW_TOOLS = [
  "brush",
  "eraser",
  "line",
  "arrow",
  "rect",
  "ellipse",
  "text",
  "fill",
] as const
export type DrawTool = (typeof DRAW_TOOLS)[number]

/** [x, y] or [x, y, pressure]; pressure is 0..1 (a mouse has none). */
export type StrokePoint = [number, number] | [number, number, number]

export const MAX_STROKES = 2000
export const MAX_STROKE_POINTS = 20_000

export interface Stroke {
  tool: DrawTool
  /** "#rrggbb" (black when absent); the eraser has none. */
  color?: string
  /** Percent of the shorter edge, 0.05..50: the brush's width, a line's, the height of a line of text. */
  size?: number
  /** 0..100 each (100 when absent). */
  hardness?: number
  opacity?: number
  /** A brush's path; the two ends of a line or corners of a shape; the place of a text or a fill. */
  points: StrokePoint[]
  /** rect and ellipse: filled instead of outlined. */
  filled?: boolean
  text?: string
  font?: string
  bold?: boolean
  italic?: boolean
  /** fill: how different a color may be and still fill, 0..100. */
  tolerance?: number
}

/** One drawing: strokes painted in order on a layer over the picture. */
export interface DrawParams {
  strokes: Stroke[]
}

export interface CloneParams {
  points: StrokePoint[]
  /** Where the first point copies from, 0..1 of the picture; the source moves with the brush. */
  source: [number, number]
  size: number
  hardness?: number
  opacity?: number
}

export interface HealParams {
  /** spot finds clean texture nearby by itself; brush copies from `source`. */
  mode?: "spot" | "brush"
  points: StrokePoint[]
  source?: [number, number]
  size: number
}

export interface RedEyeParams {
  /** The eye, 0..1 of the picture; or `auto` to find the eyes in the picture. */
  rect?: NormalizedRect
  auto?: boolean
  /** 0..100 (100 when absent). */
  strength?: number
  /** -50..50: a smaller or larger corrected area. */
  pupil?: number
}

interface OpBase {
  /** Kept in the list but not applied (the eye in the edit stack). */
  off?: boolean
}

/** One operation; `p` is checked strictly in Go (unknown fields are errors). */
export type EditOp =
  | ({ op: "rotate"; p: RotateParams } & OpBase)
  | ({ op: "flip"; p: FlipParams } & OpBase)
  | ({ op: "crop"; p: CropParams } & OpBase)
  | ({ op: "resize"; p: ResizeParams } & OpBase)
  | ({ op: "canvas"; p: CanvasParams } & OpBase)
  | ({ op: "dpi"; p: DpiParams } & OpBase)
  | ({ op: "lighting"; p: LightingParams } & OpBase)
  | ({ op: "colors"; p: ColorsParams } & OpBase)
  | ({ op: "levels"; p: LevelsParams } & OpBase)
  | ({ op: "curves"; p: CurvesParams } & OpBase)
  | ({ op: "grayscale"; p: GrayscaleParams } & OpBase)
  | ({ op: "sepia"; p: SepiaParams } & OpBase)
  | ({ op: "negative"; p: NegativeParams } & OpBase)
  | ({ op: "swapChannels"; p: SwapChannelsParams } & OpBase)
  | ({ op: "replaceColor"; p: ReplaceColorParams } & OpBase)
  | ({ op: "sharpen"; p: SharpenParams } & OpBase)
  | ({ op: "blur"; p: BlurParams } & OpBase)
  | ({ op: "denoise"; p: DenoiseParams } & OpBase)
  | ({ op: "reduceColors"; p: ReduceColorsParams } & OpBase)
  | ({ op: "border"; p: BorderParams } & OpBase)
  | ({ op: "frameMask"; p: FrameMaskParams } & OpBase)
  | ({ op: "watermark"; p: WatermarkParams } & OpBase)
  | ({ op: "bump"; p: BumpParams } & OpBase)
  | ({ op: "sketch"; p: SketchParams } & OpBase)
  | ({ op: "oil"; p: OilParams } & OpBase)
  | ({ op: "lens"; p: LensParams } & OpBase)
  | ({ op: "obscure"; p: ObscureParams } & OpBase)
  | ({ op: "draw"; p: DrawParams } & OpBase)
  | ({ op: "clone"; p: CloneParams } & OpBase)
  | ({ op: "heal"; p: HealParams } & OpBase)
  | ({ op: "redeye"; p: RedEyeParams } & OpBase)

export type EditList = EditOp[]

const opKinds: ReadonlySet<unknown> = new Set(EDIT_OPS)

function isPlain(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  )
}

/** Walks a JSON value: finite numbers, bounded strings, depth and count. */
function valueProblem(v: unknown, depth: number, budget: { numbers: number }): string | null {
  switch (typeof v) {
    case "number":
      if (!Number.isFinite(v)) return "numbers must be finite"
      return --budget.numbers < 0 ? "too many values" : null
    case "string":
      return v.length > MAX_EDIT_STRING_CHARS ? "a text is too long" : null
    case "boolean":
      return null
    case "object":
      break
    default:
      return "unsupported value"
  }
  if (v === null) return "unsupported value"
  if (depth >= MAX_EDIT_DEPTH) return "parameters are nested too deeply"
  if (Array.isArray(v)) {
    for (const item of v) {
      const problem = valueProblem(item, depth + 1, budget)
      if (problem) return problem
    }
    return null
  }
  if (!isPlain(v)) return "unsupported value"
  for (const key of Object.keys(v)) {
    if (key.length > 64) return "a parameter name is too long"
    const problem = valueProblem(v[key], depth + 1, budget)
    if (problem) return problem
  }
  return null
}

/**
 * The structural check of an edit list from a renderer (ADR-0012, ADR-0035):
 * a bounded array of known operations whose parameters are plain JSON with
 * finite numbers. What the parameters mean is validated in Go. Returns null
 * for a valid list, otherwise the reason.
 */
export function editListProblem(list: unknown): string | null {
  if (!Array.isArray(list)) return "expected an edit list"
  if (list.length > MAX_EDIT_OPS) return `at most ${MAX_EDIT_OPS} operations`
  const budget = { numbers: MAX_EDIT_NUMBERS }
  for (const op of list) {
    if (!isPlain(op)) return "an operation must be an object"
    const keys = Object.keys(op)
    if (!keys.every((k) => k === "op" || k === "p" || k === "off")) {
      return "an operation has op, p and off"
    }
    if (!opKinds.has(op.op)) return "unknown operation"
    if (op.off !== undefined && typeof op.off !== "boolean") return "off must be a boolean"
    if (!isPlain(op.p)) return "an operation needs parameters"
    const problem = valueProblem(op.p, 1, budget)
    if (problem) return problem
  }
  // The size as it will travel; a cheap bound checked last.
  if (JSON.stringify(list).length > MAX_EDIT_LIST_CHARS) return "the edit list is too large"
  return null
}

export type EditQuality = "draft" | "final"
export const EDIT_QUALITIES = ["draft", "final"] as const satisfies readonly EditQuality[]

export const SAVE_FORMATS = ["jpeg", "png", "gif", "bmp", "tiff"] as const
export type SaveFormat = (typeof SAVE_FORMATS)[number]
/** The file extensions a format may be saved under; the first is the default. */
export const SAVE_EXTENSIONS: Record<SaveFormat, readonly string[]> = {
  jpeg: ["jpg", "jpeg", "jpe", "jfif"],
  png: ["png"],
  gif: ["gif"],
  bmp: ["bmp"],
  tiff: ["tif", "tiff"],
}

/** keep: EXIF, XMP, ICC; strip: only the color profile stays; stripGps: no location. */
export const METADATA_POLICIES = ["keep", "strip", "stripGps"] as const
export type MetadataPolicy = (typeof METADATA_POLICIES)[number]

/** copy: "name (edited).ext" beside the original; as: a native save dialog; replace: the original goes to the trash first. */
export const SAVE_TARGETS = ["copy", "as", "replace"] as const
export type SaveTarget = (typeof SAVE_TARGETS)[number]

export const MIN_JPEG_QUALITY = 1
export const MAX_JPEG_QUALITY = 100
export const DEFAULT_JPEG_QUALITY = 92
export const MAX_DPI = 10_000

/** Pixels per inch; 0 = unknown. */
export interface EditDpi {
  x: number
  y: number
}

export interface EditOpenParams {
  entryId: number
  /** The calling window, added by Electron main (one session per window); never from a renderer. */
  owner?: number
}

/** The decoder family of the opened picture. */
export type EditSourceFormat = SaveFormat | "webp"

export interface EditOpenResult {
  sessionId: string
  name: string
  /** The full size, upright. */
  width: number
  height: number
  format: EditSourceFormat
  hasAlpha: boolean
  dpi: EditDpi
  /** "bitDepth": the source had more than 8 bits per channel and was reduced. */
  notice?: "bitDepth"
  /** What a save defaults to: the source's format, or PNG when that cannot be written (WebP). */
  saveFormat: SaveFormat
  /** The original can be replaced: its format can be written and its drive has a trash. */
  canReplace: boolean
}

export interface EditView {
  /** The long edge the frame is shown at, in device pixels. */
  maxEdge: number
}

export interface EditRenderParams {
  sessionId: string
  /** Orders requests: a higher revision replaces every lower one. */
  rev: number
  editList: EditList
  view: EditView
  quality: EditQuality
  histogram: boolean
  /**
   * Also asks for the histogram of the picture after that many active operations: what the tool
   * at that place is given (levels and curves draw it).
   */
  histogramAt?: number
}

/** 256 bins each; fully transparent pixels are not counted. */
export interface EditHistogram {
  lum: number[]
  r: number[]
  g: number[]
  b: number[]
  pixels: number
  /** Pixels with a channel at 0, and at 255. */
  clipLow: number
  clipHigh: number
  /** Mean luminosity, 0..255. */
  mean: number
}

export interface EditOutput {
  /** The size and resolution a save would write. */
  width: number
  height: number
  dpi: EditDpi
}

/** Sidecar → main: the frame as a file in the cache's tmp folder. */
export interface EditFrameFile {
  file: string
  mime: string
  width: number
  height: number
}

/** Main → renderer: the frame as a one-shot token URL. */
export interface EditFrame {
  url: string
  width: number
  height: number
}

interface EditRendered<F> {
  rev: number
  /** A newer revision replaced this one; there is no frame. */
  superseded?: boolean
  frame?: F
  output?: EditOutput
  histogram?: EditHistogram
  /** The histogram asked for with `histogramAt`, when Go had that picture at hand. */
  before?: EditHistogram
}
export type EditFrameResult = EditRendered<EditFrameFile>
export type EditRenderResult = EditRendered<EditFrame>

export interface EditSessionParams {
  sessionId: string
}

export const EDIT_INFO_GROUPS = [
  "camera",
  "lens",
  "exposure",
  "date",
  "gps",
  "software",
  "image",
] as const
export type EditInfoGroupName = (typeof EDIT_INFO_GROUPS)[number]

export interface EditInfoItem {
  /** The tag's name, such as "ExposureTime". */
  id: string
  value: string
  /** A value from a fixed list that the interface translates, such as "aperturePriority". */
  code?: string
}

export interface EditInfoGroup {
  name: EditInfoGroupName
  items: EditInfoItem[]
}

export interface EditInfoResult {
  groups: EditInfoGroup[]
}

export interface EditEstimateParams {
  sessionId: string
  editList: EditList
  format: SaveFormat
  /** JPEG, 1..100; 0 = the default. */
  quality: number
  metadata: MetadataPolicy
}

export interface EditEstimateResult {
  bytes: number
}

export interface EditSaveParams {
  sessionId: string
  editList: EditList
  target: SaveTarget
  format: SaveFormat
  quality: number
  metadata: MetadataPolicy
  /** The resolution to write; 0 keeps the edit list's. */
  dpi: number
}

/** Main → sidecar: `path` is the answer of the save dialog (target "as"). */
export interface EditWriteParams extends EditSaveParams {
  path?: string
}

export interface EditWriteResult {
  jobId: number
  /** The file being written, for messages. */
  name: string
}

export interface EditSaveResult {
  /** null when the save dialog was cancelled. */
  jobId: number | null
  name: string
}

export interface EditJobParams {
  jobId: number
}

export interface EditSavedResult {
  /** The saved file's entry once it is indexed, else 0. */
  entryId: number
  name: string
}

/** Electron main only. */
export interface EditSavedPathResult {
  path: string
}

// Stage 13: a color under the pointer, preset thumbnails, Count colors ------

export interface EditProbeParams {
  sessionId: string
  /** The list whose result is probed (the operations before the tool, for its eyedroppers). */
  editList: EditList
  view: EditView
  /** 0..1 of the picture. */
  x: number
  y: number
  /** The color is averaged over a square of 2·radius+1 pixels (0..16). */
  radius: number
}

export interface EditProbeResult {
  /** Straight (not premultiplied) red, green, blue and alpha, 0..255. */
  rgba: [number, number, number, number]
  hex: string
}

export const MAX_EDIT_THUMBS = 16
export const MAX_THUMB_EDGE = 256

export interface EditThumbsParams {
  sessionId: string
  /** At most MAX_EDIT_THUMBS lists; each gets a small rendering of the picture. */
  editLists: EditList[]
  edge: number
}

/** Sidecar → main: thumbnail files (null for a list that could not be rendered). */
export interface EditThumbFramesResult {
  thumbs: (EditFrameFileSize | null)[]
}
export interface EditFrameFileSize {
  file: string
  width: number
  height: number
}

/** Main → renderer: the same as token URLs. */
export interface EditThumbsResult {
  thumbs: (EditFrame | null)[]
}

/** preview: the proxy as rendered (fast, an estimate); edited, original: the full picture (exact). */
export const COLOR_SCOPES = ["preview", "edited", "original"] as const
export type ColorScope = (typeof COLOR_SCOPES)[number]
export const MAX_SWATCHES = 32

export interface EditColorsParams {
  sessionId: string
  editList: EditList
  scope: ColorScope
  /** Swatches of the dominant palette, 1..32. */
  maxColors: number
}

export interface EditSwatch {
  hex: string
  /** 0..1 of the visible pixels. */
  share: number
}

export interface EditColorsResult {
  /** The exact number of distinct colors of the visible pixels. */
  distinct: number
  palette: EditSwatch[]
  hasAlpha: boolean
  /** The size of the picture that was counted. */
  width: number
  height: number
}

// Stage 14: assets (pictures picked through main's dialog) and fonts ---------

export const MAX_ASSET_BYTES = 16 * 1024 * 1024
export const MAX_ASSET_EDGE = 8000

/** Renderer → main: opens the native dialog; there is no path in either direction. */
export interface AssetPickParams {
  sessionId: string
}

/** Main → renderer: what was picked, or null when the dialog was cancelled. */
export interface AssetPickResult {
  asset: EditAsset | null
}

export interface EditAsset {
  assetId: AssetId
  /** The file's name, for the panel. */
  name: string
  width: number
  height: number
  /** A small rendering as a token URL. */
  thumbUrl: string
}

export interface AssetReleaseParams {
  sessionId: string
  assetId: AssetId
}

/** Main → sidecar: the path main's dialog returned. */
export interface EditAssetAddParams {
  sessionId: string
  path: string
}

/** Sidecar → main: the asset, with its thumbnail as a file. */
export interface EditAssetFile {
  assetId: AssetId
  name: string
  width: number
  height: number
  thumb: EditFrameFileSize
}

export interface EditFontsResult {
  /** Family names only: the built-in ones first, then the system's. */
  families: string[]
}

// Stage 15: red pupils found in the picture -----------------------------------

export const MAX_EYES = 32

export interface EditEyesParams {
  sessionId: string
  /** The list whose result is searched. */
  editList: EditList
}

export interface EditEyesResult {
  /** One rect per pupil, 0..1 of the picture; pupils are reported in pairs. */
  eyes: NormalizedRect[]
}

/** Main → the viewer: the commander's media overlay asked to edit a picture. */
export interface EditRequestEvent {
  entryId: number
}
