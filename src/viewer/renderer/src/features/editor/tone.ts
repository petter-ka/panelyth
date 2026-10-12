// Tone math for the levels and curves widgets (pure; unit-tested). The pixels
// are Go's work: this only draws the curve the user is shaping and turns a
// histogram or a picked color into ordinary parameters. Both mirror
// internal/imaging/color.go, so what the widget shows is what Go applies.
import type {
  CurvePoint,
  EditHistogram,
  LevelsChannel,
  LevelsChannelName,
  LevelsParams,
} from "@panelyth/contracts"

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

export const NEUTRAL: LevelsChannel = {
  inBlack: 0,
  inWhite: 255,
  gamma: 1,
  outBlack: 0,
  outWhite: 255,
}

/**
 * A curve through control points as 256 values (monotone cubic, PCHIP): it
 * passes through every point and never overshoots between two of them; it
 * is flat before the first point and after the last.
 */
export function curveLut(points: readonly CurvePoint[]): number[] {
  const n = points.length
  const out = Array.from({ length: 256 }, (_, v) => v)
  if (n < 2) return out
  const d: number[] = []
  for (let i = 0; i < n - 1; i++) {
    d.push((points[i + 1]![1] - points[i]![1]) / (points[i + 1]![0] - points[i]![0]))
  }
  const m: number[] = new Array<number>(n).fill(0)
  m[0] = d[0]!
  m[n - 1] = d[n - 2]!
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1]! * d[i]! <= 0) continue
    const h0 = points[i]![0] - points[i - 1]![0]
    const h1 = points[i + 1]![0] - points[i]![0]
    const w0 = 2 * h1 + h0
    const w1 = h1 + 2 * h0
    m[i] = (w0 + w1) / (w0 / d[i - 1]! + w1 / d[i]!)
  }
  for (let i = 0; i < d.length; i++) {
    if (d[i] === 0) {
      m[i] = 0
      m[i + 1] = 0
      continue
    }
    const a = m[i]! / d[i]!
    const b = m[i + 1]! / d[i]!
    const s = a * a + b * b
    if (s > 9) {
      const k = 3 / Math.sqrt(s)
      m[i] = k * a * d[i]!
      m[i + 1] = k * b * d[i]!
    }
  }
  let seg = 0
  for (let v = 0; v < 256; v++) {
    if (v <= points[0]![0]) {
      out[v] = Math.round(clamp(points[0]![1], 0, 255))
      continue
    }
    if (v >= points[n - 1]![0]) {
      out[v] = Math.round(clamp(points[n - 1]![1], 0, 255))
      continue
    }
    while (v > points[seg + 1]![0]) seg++
    const h = points[seg + 1]![0] - points[seg]![0]
    const u = (v - points[seg]![0]) / h
    const u2 = u * u
    const u3 = u2 * u
    const y =
      (2 * u3 - 3 * u2 + 1) * points[seg]![1] +
      (u3 - 2 * u2 + u) * h * m[seg]! +
      (-2 * u3 + 3 * u2) * points[seg + 1]![1] +
      (u3 - u2) * h * m[seg + 1]!
    out[v] = Math.round(clamp(y, 0, 255))
  }
  return out
}

/** Adds a point to a curve (replacing one at the same input), keeping the inputs rising. */
export function withPoint(points: readonly CurvePoint[], x: number, y: number): CurvePoint[] {
  const px = Math.round(clamp(x, 0, 255))
  const py = Math.round(clamp(y, 0, 255))
  const rest = points.filter((p) => p[0] !== px)
  return [...rest, [px, py] as CurvePoint].sort((a, b) => a[0] - b[0])
}

/** Moves point `index`: it stays between its neighbours, one level apart at least. */
export function movePoint(
  points: readonly CurvePoint[],
  index: number,
  x: number,
  y: number,
): CurvePoint[] {
  const lo = index > 0 ? points[index - 1]![0] + 1 : 0
  const hi = index < points.length - 1 ? points[index + 1]![0] - 1 : 255
  const next = points.map((p): CurvePoint => [p[0], p[1]])
  next[index] = [Math.round(clamp(x, lo, hi)), Math.round(clamp(y, 0, 255))]
  return next
}

export interface AutoOptions {
  /** Percent of the pixels that may be cut off at each end, 0..5. */
  clip: number
  /** Per channel (also removes a color cast), or all three together. */
  mode: "rgb" | "lum"
  /** Also bring the midtones towards the middle. */
  gamma: boolean
}

function channelFrom(bins: readonly number[], clip: number, gamma: boolean): LevelsChannel {
  let total = 0
  for (const n of bins) total += n
  const cut = Math.floor((total * clip) / 100)
  let lo = 0
  let hi = 255
  for (let acc = 0; lo < 254; lo++) {
    acc += bins[lo]!
    if (acc > cut) break
  }
  for (let acc = 0; hi > lo + 1; hi--) {
    acc += bins[hi]!
    if (acc > cut) break
  }
  const c: LevelsChannel = { inBlack: lo, inWhite: hi, gamma: 1, outBlack: 0, outWhite: 255 }
  if (gamma) {
    let inside = 0
    for (let v = lo; v <= hi; v++) inside += bins[v]!
    let median = lo
    for (let v = lo, acc = 0; v <= hi; v++) {
      acc += bins[v]!
      if (acc * 2 >= inside) {
        median = v
        break
      }
    }
    const m = (median - lo) / (hi - lo)
    if (m > 0.02 && m < 0.98) {
      c.gamma = Math.round(clamp(Math.log(m) / Math.log(0.5), 0.6, 1.6) * 100) / 100
    }
  }
  return c
}

/** The levels a histogram asks for (imaging.AutoLevels): ordinary values the user can tune. */
export function autoLevels(h: EditHistogram, o: AutoOptions): LevelsParams {
  if (o.mode === "lum") return { l: channelFrom(h.lum, o.clip, o.gamma) }
  return {
    r: channelFrom(h.r, o.clip, o.gamma),
    g: channelFrom(h.g, o.clip, o.gamma),
    b: channelFrom(h.b, o.clip, o.gamma),
  }
}

export type Eyedropper = "black" | "gray" | "white"

/**
 * The levels eyedroppers: the picked color becomes black, neutral gray or
 * white. Black and white set each channel's end of the input range (which
 * also removes a cast there); gray sets each channel's gamma so the picked
 * color has equal channels at its own brightness.
 */
export function levelsFromPick(
  current: LevelsParams,
  kind: Eyedropper,
  rgb: readonly [number, number, number],
): LevelsParams {
  const next: LevelsParams = { ...current }
  delete next.auto
  const names: readonly Exclude<LevelsChannelName, "l">[] = ["r", "g", "b"]
  const mean = (rgb[0] + rgb[1] + rgb[2]) / 3
  names.forEach((name, i) => {
    const c: LevelsChannel = { ...NEUTRAL, ...current[name] }
    const v = rgb[i]!
    if (kind === "black") c.inBlack = Math.round(clamp(v, 0, c.inWhite - 1))
    else if (kind === "white") c.inWhite = Math.round(clamp(v, c.inBlack + 1, 255))
    else {
      // Where the picked value sits in this channel's range, and where it should.
      const span = c.inWhite - c.inBlack
      const at = clamp((v - c.inBlack) / span, 0.01, 0.99)
      const want = clamp((mean - c.inBlack) / span, 0.01, 0.99)
      c.gamma = Math.round(clamp(Math.log(at) / Math.log(want), 0.1, 9.99) * 100) / 100
    }
    next[name] = c
  })
  return next
}

/** "#rrggbb" of three channel values. */
export function toHex(rgb: readonly number[]): string {
  return (
    "#" +
    rgb
      .slice(0, 3)
      .map((v) =>
        Math.round(clamp(v, 0, 255))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  )
}
