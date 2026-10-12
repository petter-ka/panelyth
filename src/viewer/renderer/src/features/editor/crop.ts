// Crop box math (pure; unit-tested). A rectangle is normalized to the
// picture it is drawn on (0..1), which is what the edit list stores; pixel
// values follow the rounding the Go pipeline uses, so the numbers in the
// panel are the size a save produces.
import type { NormalizedRect } from "@panelyth/contracts"
import { msg } from "@panelyth/i18n"

export interface Size {
  w: number
  h: number
}

export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw"
export const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"]

export const FULL: NormalizedRect = { x: 0, y: 0, w: 1, h: 1 }

export interface RatioChoice {
  id: string
  label: string
  /** Width over height in pixels; null = free, 0 = the picture's own. */
  value: number | null
}

export const CROP_RATIOS: readonly RatioChoice[] = [
  { id: "free", label: msg("Free"), value: null },
  { id: "original", label: msg("Original"), value: 0 },
  { id: "1:1", label: "1:1", value: 1 },
  { id: "4:3", label: "4:3", value: 4 / 3 },
  { id: "3:2", label: "3:2", value: 3 / 2 },
  { id: "16:9", label: "16:9", value: 16 / 9 },
  { id: "3:4", label: "3:4", value: 3 / 4 },
  { id: "2:3", label: "2:3", value: 2 / 3 },
  { id: "9:16", label: "9:16", value: 9 / 16 },
]

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

/** Keeps a rectangle inside the picture and at least one pixel large. */
export function clampRect(r: NormalizedRect, image: Size): NormalizedRect {
  const minW = 1 / Math.max(image.w, 1)
  const minH = 1 / Math.max(image.h, 1)
  const w = clamp(r.w, minW, 1)
  const h = clamp(r.h, minH, 1)
  return { x: clamp(r.x, 0, 1 - w), y: clamp(r.y, 0, 1 - h), w, h }
}

/** The pixel rectangle Go cuts for a normalized one (imaging.cropRect). */
export function toPixels(r: NormalizedRect, image: Size): { x: number; y: number } & Size {
  let x0 = Math.round(r.x * image.w)
  let y0 = Math.round(r.y * image.h)
  let x1 = Math.round((r.x + r.w) * image.w)
  let y1 = Math.round((r.y + r.h) * image.h)
  x0 = clamp(x0, 0, image.w - 1)
  y0 = clamp(y0, 0, image.h - 1)
  x1 = clamp(x1, x0 + 1, image.w)
  y1 = clamp(y1, y0 + 1, image.h)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function fromPixels(p: { x: number; y: number } & Size, image: Size): NormalizedRect {
  return clampRect(
    { x: p.x / image.w, y: p.y / image.h, w: p.w / image.w, h: p.h / image.h },
    image,
  )
}

/** The ratio a choice means for this picture (null = free). */
export function ratioValue(choice: RatioChoice, image: Size): number | null {
  if (choice.value === null) return null
  return choice.value === 0 ? image.w / image.h : choice.value
}

/** A pixel ratio as a ratio of normalized width to height. */
const normalized = (ratio: number, image: Size): number => (ratio * image.h) / image.w

/** The largest rectangle of a ratio inside `within`, centered in it. */
export function fitRatio(within: NormalizedRect, ratio: number, image: Size): NormalizedRect {
  const nr = normalized(ratio, image)
  let w = within.w
  let h = w / nr
  if (h > within.h) {
    h = within.h
    w = h * nr
  }
  return clampRect(
    { x: within.x + (within.w - w) / 2, y: within.y + (within.h - h) / 2, w, h },
    image,
  )
}

export function moveRect(r: NormalizedRect, dx: number, dy: number, image: Size): NormalizedRect {
  return clampRect({ ...r, x: r.x + dx, y: r.y + dy }, image)
}

/**
 * Drags a handle by (dx, dy), in normalized units. With a ratio the box keeps
 * it: a corner follows the pointer along the diagonal, an edge grows the
 * other side around the box's center line. The box never leaves the picture.
 */
export function dragHandle(
  r: NormalizedRect,
  handle: Handle,
  dx: number,
  dy: number,
  ratio: number | null,
  image: Size,
): NormalizedRect {
  const minW = 1 / Math.max(image.w, 1)
  const minH = 1 / Math.max(image.h, 1)
  let x0 = r.x
  let y0 = r.y
  let x1 = r.x + r.w
  let y1 = r.y + r.h
  if (handle.includes("w")) x0 = clamp(x0 + dx, 0, x1 - minW)
  if (handle.includes("e")) x1 = clamp(x1 + dx, x0 + minW, 1)
  if (handle.includes("n")) y0 = clamp(y0 + dy, 0, y1 - minH)
  if (handle.includes("s")) y1 = clamp(y1 + dy, y0 + minH, 1)
  if (ratio === null) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }

  const nr = normalized(ratio, image)
  let w = x1 - x0
  let h = y1 - y0
  // The fixed point: the opposite corner, or the middle of the opposite edge.
  const west = handle.includes("w")
  const east = handle.includes("e")
  const north = handle.includes("n")
  const south = handle.includes("s")
  const ax = west ? x1 : east ? x0 : r.x + r.w / 2
  const ay = north ? y1 : south ? y0 : r.y + r.h / 2
  if (!west && !east) w = h * nr
  else if (!north && !south) h = w / nr
  else if (w / h > nr) w = h * nr
  else h = w / nr
  // The room from the fixed point in the direction the box grows.
  const roomW = west ? ax : east ? 1 - ax : 2 * Math.min(ax, 1 - ax)
  const roomH = north ? ay : south ? 1 - ay : 2 * Math.min(ay, 1 - ay)
  const k = Math.min(1, roomW / w, roomH / h)
  w *= k
  h *= k
  return {
    x: west ? ax - w : east ? ax : ax - w / 2,
    y: north ? ay - h : south ? ay : ay - h / 2,
    w,
    h,
  }
}

/** Arrow keys: move the box, or with a handle focused resize by it. One pixel, ten with Shift. */
export function nudge(
  r: NormalizedRect,
  handle: Handle | "move",
  key: string,
  fast: boolean,
  ratio: number | null,
  image: Size,
): NormalizedRect | null {
  const step = fast ? 10 : 1
  const dx = (key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0) / image.w
  const dy = (key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0) / image.h
  if (dx === 0 && dy === 0) return null
  return handle === "move"
    ? moveRect(r, dx, dy, image)
    : dragHandle(r, handle, dx, dy, ratio, image)
}

/**
 * The correction for a line drawn along something that should be level or
 * upright: the clockwise angle that makes it so, within ±45°.
 */
export function straightenAngle(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI
  // Fold onto the nearest axis.
  while (deg > 45) deg -= 90
  while (deg < -45) deg += 90
  return -deg
}
