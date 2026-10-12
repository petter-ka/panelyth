// Geometry of the draw and retouch tools (Stage 15; pure, unit-tested). A
// stroke is a list of points, 0..1 of the picture; Go paints it. What is
// here is what the pointer needs before that: thinning a path so a long
// stroke stays a small message, constraining a shape while Shift is held,
// and turning the brush settings into operations.
import type { DrawTool, EditOp, NormalizedRect, Stroke, StrokePoint } from "@panelyth/contracts"

/** What the paint tools share: the brush and what each tool adds to it. */
export interface PaintSettings {
  drawTool: DrawTool
  color: string
  /** Percent of the shorter edge. */
  size: number
  hardness: number
  opacity: number
  filled: boolean
  text: string
  font: string
  bold: boolean
  tolerance: number
  healMode: "spot" | "brush"
  /**
   * Where clone and the heal brush copy from. `source` is the point that was
   * chosen; with the first stroke it becomes an `offset` to the brush, which
   * later strokes keep (the source moves with the brush).
   */
  source: [number, number] | null
  offset: [number, number] | null
  redStrength: number
  redPupil: number
}

export const DEFAULT_PAINT: PaintSettings = {
  drawTool: "brush",
  color: "#ff3b30",
  size: 2,
  hardness: 80,
  opacity: 100,
  filled: false,
  text: "",
  font: "",
  bold: false,
  tolerance: 20,
  healMode: "spot",
  source: null,
  offset: null,
  redStrength: 100,
  redPupil: 0,
}

export const MIN_BRUSH = 0.05
export const MAX_BRUSH = 50

/** Tools that follow the pointer along a path. */
export const isPathTool = (tool: DrawTool): boolean => tool === "brush" || tool === "eraser"
/** Tools dragged from one corner to the other. */
export const isShapeTool = (tool: DrawTool): boolean =>
  tool === "line" || tool === "arrow" || tool === "rect" || tool === "ellipse"

const round4 = (v: number): number => Math.round(v * 1e4) / 1e4

/** A point as it travels: four decimals (a tenth of a pixel on 1,000 px), pressure only from a pen. */
export function strokePoint(x: number, y: number, pressure?: number): StrokePoint {
  const p: StrokePoint = [round4(x), round4(y)]
  // A mouse reports 0.5 while pressed (0 otherwise): that is "no pressure".
  if (pressure !== undefined && pressure > 0 && pressure !== 0.5) {
    return [p[0], p[1], Math.round(Math.min(pressure, 1) * 100) / 100]
  }
  return p
}

/**
 * Drops the points of a path that lie within `tolerance` of the line through
 * their neighbours (Ramer–Douglas–Peucker; the same rule as Go's
 * imaging.SimplifyPath). The ends stay.
 */
export function simplifyPath<P extends readonly number[]>(
  points: readonly P[],
  tolerance: number,
): P[] {
  if (points.length < 3 || tolerance <= 0) return [...points]
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length > 0) {
    const [a, b] = stack.pop()!
    const ax = points[a]![0]!
    const ay = points[a]![1]!
    const dx = points[b]![0]! - ax
    const dy = points[b]![1]! - ay
    const len2 = dx * dx + dy * dy
    let worst = 0
    let at = -1
    for (let i = a + 1; i < b; i++) {
      const px = points[i]![0]! - ax
      const py = points[i]![1]! - ay
      const t = len2 > 0 ? Math.min(Math.max((px * dx + py * dy) / len2, 0), 1) : 0
      const d = Math.hypot(px - t * dx, py - t * dy)
      if (d > worst) {
        worst = d
        at = i
      }
    }
    if (at >= 0 && worst > tolerance) {
      keep[at] = 1
      stack.push([a, at], [at, b])
    }
  }
  return points.filter((_, i) => keep[i] === 1)
}

/** The tolerance for a stroke: a quarter of a pixel of the editor's proxy (2,560 px). */
export const STROKE_TOLERANCE = 0.25 / 2560

/**
 * The second corner of a shape while Shift is held: a line or an arrow turns
 * in steps of 45°, a rectangle becomes a square and an ellipse a circle.
 * `aspect` is the picture's width over its height (points are 0..1 of each).
 */
export function constrain(
  tool: DrawTool,
  from: readonly [number, number],
  to: readonly [number, number],
  aspect: number,
): [number, number] {
  // In pixels of a picture `aspect` wide and 1 high.
  const dx = (to[0] - from[0]) * aspect
  const dy = to[1] - from[1]
  if (tool === "line" || tool === "arrow") {
    const length = Math.hypot(dx, dy)
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
    return [from[0] + (Math.cos(angle) * length) / aspect, from[1] + Math.sin(angle) * length]
  }
  const side = Math.max(Math.abs(dx), Math.abs(dy))
  return [from[0] + (Math.sign(dx || 1) * side) / aspect, from[1] + Math.sign(dy || 1) * side]
}

/** A stroke of the draw tool from the brush settings. */
export function drawStroke(s: PaintSettings, points: StrokePoint[]): Stroke {
  const tool = s.drawTool
  const stroke: Stroke = { tool, points }
  if (tool !== "eraser") stroke.color = s.color
  if (tool !== "fill") stroke.size = s.size
  if (s.opacity !== 100) stroke.opacity = s.opacity
  if (isPathTool(tool) && s.hardness !== 100) stroke.hardness = s.hardness
  if ((tool === "rect" || tool === "ellipse") && s.filled) stroke.filled = true
  if (tool === "text") {
    stroke.text = s.text
    if (s.font) stroke.font = s.font
    if (s.bold) stroke.bold = true
  }
  if (tool === "fill") stroke.tolerance = s.tolerance
  return stroke
}

/** The source of a clone or heal stroke: it keeps its distance to the stroke's start. */
export function cloneOp(s: PaintSettings, points: StrokePoint[], source: [number, number]): EditOp {
  return {
    op: "clone",
    p: {
      size: s.size,
      ...(s.hardness !== 50 && { hardness: s.hardness }),
      ...(s.opacity !== 100 && { opacity: s.opacity }),
      source: [round4(source[0]), round4(source[1])],
      points,
    },
  }
}

export function healOp(
  s: PaintSettings,
  points: StrokePoint[],
  source: [number, number] | null,
): EditOp {
  return source && s.healMode === "brush"
    ? {
        op: "heal",
        p: { mode: "brush", size: s.size, source: [round4(source[0]), round4(source[1])], points },
      }
    : { op: "heal", p: { size: s.size, points } }
}

/** The box of an eye from a drag, or around a click (6 % of the shorter edge). */
export function eyeRect(
  from: readonly [number, number],
  to: readonly [number, number],
  aspect: number,
): NormalizedRect {
  let w = Math.abs(to[0] - from[0])
  let h = Math.abs(to[1] - from[1])
  let x = Math.min(from[0], to[0])
  let y = Math.min(from[1], to[1])
  // A click, or a drag too small to be a box.
  if (w * aspect < 0.01 && h < 0.01) {
    const short = Math.min(aspect, 1)
    w = (0.06 * short) / aspect
    h = 0.06 * short
    x = from[0] - w / 2
    y = from[1] - h / 2
  }
  x = Math.max(x, 0)
  y = Math.max(y, 0)
  return {
    x: round4(x),
    y: round4(y),
    w: round4(Math.min(w, 1 - x)),
    h: round4(Math.min(h, 1 - y)),
  }
}

export function redEyeOp(s: PaintSettings, rect: NormalizedRect): EditOp {
  return {
    op: "redeye",
    p: {
      rect,
      ...(s.redStrength !== 100 && { strength: s.redStrength }),
      ...(s.redPupil !== 0 && { pupil: s.redPupil }),
    },
  }
}

/** The next brush size for the [ and ] keys: steps that grow with the size. */
export function stepBrush(size: number, direction: 1 | -1): number {
  const step =
    direction > 0
      ? size < 1
        ? 0.1
        : size < 5
          ? 0.5
          : size < 20
            ? 1
            : 5
      : size <= 1
        ? 0.1
        : size <= 5
          ? 0.5
          : size <= 20
            ? 1
            : 5
  const next = size + direction * step
  return Math.round(Math.min(Math.max(next, MIN_BRUSH), MAX_BRUSH) * 100) / 100
}

/**
 * Where a stroke starting at `start` copies from: the chosen point for the
 * first stroke after it was chosen, the same distance from the brush after.
 */
export function sourceFor(
  s: Pick<PaintSettings, "source" | "offset">,
  start: readonly [number, number],
): { source: [number, number]; offset: [number, number] } | null {
  if (s.offset)
    return { source: [start[0] + s.offset[0], start[1] + s.offset[1]], offset: s.offset }
  if (!s.source) return null
  return { source: s.source, offset: [s.source[0] - start[0], s.source[1] - start[1]] }
}
