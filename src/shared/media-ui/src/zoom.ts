// Zoom and pan math for the image viewer (pure; unit-tested).
//
// `zoom` is image pixels → device pixels: 1 means 100 % (actual size, one
// image pixel per screen pixel). In CSS px an image is shown at
// `w × zoom / dpr`. The offset is the image centre relative to the viewport
// centre, in CSS px.

export interface Size {
  w: number
  h: number
}

export interface ZoomState {
  zoom: number
  x: number
  y: number
}

export const MAX_ZOOM = 8
export const ZOOM_STEP = 1.25

/** Largest zoom that shows the whole image; never above 100 % (no upscaling). */
export function fitZoom(image: Size, viewport: Size, dpr: number): number {
  if (image.w <= 0 || image.h <= 0 || viewport.w <= 0 || viewport.h <= 0) return 1
  return Math.min((viewport.w * dpr) / image.w, (viewport.h * dpr) / image.h, 1)
}

export function minZoom(fit: number): number {
  return Math.min(fit, 0.1)
}

export function clampZoom(zoom: number, fit: number): number {
  return Math.min(Math.max(zoom, minZoom(fit)), MAX_ZOOM)
}

/** Displayed size in CSS px. */
export function displaySize(image: Size, zoom: number, dpr: number): Size {
  return { w: (image.w * zoom) / dpr, h: (image.h * zoom) / dpr }
}

/**
 * Keeps the image covering the viewport where it is larger than it, and
 * centred on axes where it is smaller: no panning into empty space.
 */
export function clampOffset(s: ZoomState, image: Size, viewport: Size, dpr: number): ZoomState {
  const d = displaySize(image, s.zoom, dpr)
  const maxX = Math.max(0, (d.w - viewport.w) / 2)
  const maxY = Math.max(0, (d.h - viewport.h) / 2)
  return {
    zoom: s.zoom,
    // + 0 turns -0 (clamping into a zero range) into 0.
    x: Math.min(Math.max(s.x, -maxX), maxX) + 0,
    y: Math.min(Math.max(s.y, -maxY), maxY) + 0,
  }
}

/**
 * Zooms to `next` keeping the image point under `point` (CSS px relative to
 * the viewport centre) fixed on screen.
 */
export function zoomAt(s: ZoomState, next: number, point: { x: number; y: number }): ZoomState {
  const k = next / s.zoom
  return { zoom: next, x: point.x - (point.x - s.x) * k, y: point.y - (point.y - s.y) * k }
}

/** Device pixels needed along the long edge at this zoom. */
export function neededPixels(image: Size, zoom: number): number {
  return Math.max(image.w, image.h) * zoom
}
