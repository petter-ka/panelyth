// Wheel input that moves in steps (the next file, a tile size, a row of a
// byte view) instead of scrolling a box (Stage P04). A mouse wheel sends one
// event per notch; a trackpad sends a stream of small ones, and after the
// fingers lift the OS keeps sending them while the movement runs out.
// Stepping once per event turns one swipe into dozens of steps, so steps
// follow the distance travelled.

/** What a step reads from a WheelEvent. */
export interface WheelDelta {
  deltaY: number
  deltaMode: number
}

export interface WheelStepperOptions {
  /** Wheel travel that makes one step, in CSS pixels. */
  stepPx: number
  /** At most one step in this many milliseconds (0: no limit). */
  minIntervalMs?: number
  /** Most steps one event may make: 1 for "next", more for rows. */
  maxSteps?: number
  /** Pixels of one line, for the devices that report lines. */
  linePx?: number
}

/** One notch of a mouse wheel in Chromium at the system's default setting. */
export const WHEEL_NOTCH_PX = 100

/**
 * "Next file" and "previous file" with the wheel: a notch of travel is a
 * step, at most seven steps a second.
 */
export const WHEEL_NAVIGATION: WheelStepperOptions = { stepPx: WHEEL_NOTCH_PX, minIntervalMs: 140 }

/** A pause this long ends a gesture: the next event starts a new one. */
const GESTURE_GAP_MS = 200
const PAGE_PX = 800

/**
 * Returns a function that turns wheel events into whole steps (negative:
 * up). The first event of a gesture always steps, so one notch of any
 * mouse is one step, however few pixels the system reports for it; within a
 * gesture a step takes `stepPx` of travel.
 */
export function createWheelStepper({
  stepPx,
  minIntervalMs = 0,
  maxSteps = 1,
  linePx = 40,
}: WheelStepperOptions): (e: WheelDelta, now?: number) => number {
  let travelled = 0
  let lastEvent = -Infinity
  let lastStep = -Infinity
  let lastSign = 0
  return (e, now = performance.now()) => {
    const px =
      e.deltaMode === 1 ? e.deltaY * linePx : e.deltaMode === 2 ? e.deltaY * PAGE_PX : e.deltaY
    if (px === 0 || !Number.isFinite(px)) return 0
    const sign = px > 0 ? 1 : -1
    // A clock that went back (a suspended machine, a test) starts over.
    if (now < lastEvent) lastStep = -Infinity
    const fresh = now < lastEvent || now - lastEvent > GESTURE_GAP_MS || sign !== lastSign
    lastEvent = now
    lastSign = sign
    if (fresh) travelled = 0
    travelled += px
    if (now - lastStep < minIntervalMs) {
      // One step may wait for the interval to pass; more would queue up
      // behind a swipe and keep stepping after it ended.
      travelled = Math.max(-stepPx, Math.min(stepPx, travelled))
      return 0
    }
    let steps = Math.trunc(travelled / stepPx)
    if (steps === 0) {
      if (!fresh) return 0
      steps = sign
      travelled = 0
    } else {
      steps = Math.max(-maxSteps, Math.min(maxSteps, steps))
      travelled = maxSteps === 1 ? 0 : travelled - steps * stepPx
    }
    lastStep = now
    return steps
  }
}
