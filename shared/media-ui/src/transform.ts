// View transforms for the image viewer (Stage 08, ADR-0022). Display only:
// the file is never changed. Rotation and flip are in screen space ("rotate
// right" always turns clockwise on screen, "flip" always mirrors left-right),
// and map one-to-one onto the Go edit list (internal/imaging/transform.go)
// for a future export or edited preview. Crop is modelled here so a crop
// overlay can plug in without changing the viewer's geometry contract.

import type { Size } from "./zoom"

export type Rotation = 0 | 90 | 180 | 270

export interface ViewTransform {
  /** Clockwise, applied before the flip. */
  rotate: Rotation
  flipH: boolean
}

/** A crop rectangle in 0..1 coordinates of the transformed image. */
export interface CropRect {
  x: number
  y: number
  w: number
  h: number
}

export const IDENTITY: ViewTransform = { rotate: 0, flipH: false }

export function isIdentity(t: ViewTransform): boolean {
  return t.rotate === 0 && !t.flipH
}

const normalize = (deg: number): Rotation => (((deg % 360) + 360) % 360) as Rotation

/** Turns a quarter clockwise (1) or counter-clockwise (-1) on screen. */
export function rotateBy(t: ViewTransform, direction: 1 | -1): ViewTransform {
  // Under a mirror, an image-space turn looks reversed on screen.
  return { ...t, rotate: normalize(t.rotate + (t.flipH ? -direction : direction) * 90) }
}

export function flipHorizontal(t: ViewTransform): ViewTransform {
  return { ...t, flipH: !t.flipH }
}

/** Size of the image as displayed (width and height swap on quarter turns). */
export function orientedSize(size: Size, t: ViewTransform): Size {
  return t.rotate === 90 || t.rotate === 270 ? { w: size.h, h: size.w } : size
}

/** CSS transform functions for the image box (appended after scale). */
export function cssTransform(t: ViewTransform): string {
  // CSS applies the rightmost function first: rotate, then mirror on screen.
  return `${t.flipH ? "scaleX(-1) " : ""}rotate(${t.rotate}deg)`
}

/** The equivalent Go edit list (imaging.EditList JSON). */
export function toEditList(
  t: ViewTransform,
  crop?: CropRect,
): { op: string; deg?: number; axis?: string; rect?: CropRect }[] {
  const ops: { op: string; deg?: number; axis?: string; rect?: CropRect }[] = []
  if (t.rotate !== 0) ops.push({ op: "rotate", deg: t.rotate })
  if (t.flipH) ops.push({ op: "flip", axis: "h" })
  if (crop) ops.push({ op: "crop", rect: crop })
  return ops
}
