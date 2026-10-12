import { describe, expect, it } from "vitest"
import { createWheelStepper, WHEEL_NOTCH_PX, type WheelStepperOptions } from "./wheel"

/** Feeds events ([ms, deltaY]) and returns the steps made, in order. */
function run(
  options: WheelStepperOptions,
  events: readonly (readonly [number, number])[],
): number[] {
  const step = createWheelStepper(options)
  const out: number[] = []
  for (const [at, deltaY] of events) {
    const n = step({ deltaY, deltaMode: 0 }, at)
    if (n !== 0) out.push(n)
  }
  return out
}

const sum = (steps: number[]): number => steps.reduce((a, b) => a + b, 0)

/** A stream at 60 events a second: `count` events of `deltaY(i)` pixels. */
function stream(start: number, count: number, deltaY: (i: number) => number): [number, number][] {
  return Array.from({ length: count }, (_, i) => [start + i * 16, deltaY(i)] as [number, number])
}

/**
 * A swipe on a trackpad: 12 events under the fingers, then the system's
 * inertia, each event 6 % smaller than the one before, until it is under a
 * pixel (about 0.8 s and 850 px in all).
 */
const swipe = (start: number, sign: 1 | -1 = 1): [number, number][] => {
  const out: [number, number][] = []
  let delta = 50
  for (let i = 0; delta >= 1; i++) {
    out.push([start + i * 16, sign * delta])
    if (i >= 12) delta *= 0.94
  }
  return out
}

const NEXT: WheelStepperOptions = { stepPx: WHEEL_NOTCH_PX, minIntervalMs: 140 }

describe("wheel steps: a mouse", () => {
  it("steps once per notch, in the notch's direction", () => {
    expect(
      run(NEXT, [
        [0, 100],
        [400, 100],
        [800, -100],
        [1200, -100],
      ]),
    ).toEqual([1, 1, -1, -1])
  })

  it("steps once per notch where the system reports a few pixels for one (macOS)", () => {
    expect(
      run(NEXT, [
        [0, 4],
        [300, 4],
        [600, -4],
      ]),
    ).toEqual([1, 1, -1])
  })

  it("steps once per notch where a notch is a third of the default (one line per notch)", () => {
    expect(
      run(NEXT, [
        [0, 33],
        [250, 33],
        [500, 33],
      ]),
    ).toEqual([1, 1, 1])
  })

  it("a spun wheel steps at most once per interval", () => {
    // 20 notches, 30 ms apart: 0.6 s.
    const steps = run(
      NEXT,
      Array.from({ length: 20 }, (_, i) => [i * 30, 100] as const),
    )
    expect(sum(steps)).toBeGreaterThanOrEqual(4)
    expect(sum(steps)).toBeLessThanOrEqual(5)
  })

  it("one notch that the system reports as several is one step", () => {
    expect(run(NEXT, [[0, 300]])).toEqual([1])
  })

  it("a turn back steps back at once", () => {
    expect(
      run({ stepPx: 50 }, [
        [0, -100],
        [10, 100],
        [20, 100],
      ]),
    ).toEqual([-1, 1, 1])
  })
})

describe("wheel steps: a trackpad", () => {
  it("a slow drag steps by distance, not once per event", () => {
    // One second at 2 px an event: 124 px. Once per interval would be 7 steps.
    expect(
      run(
        NEXT,
        stream(0, 62, () => 2),
      ),
    ).toEqual([1, 1])
  })

  it("a touch that barely moves is one step", () => {
    expect(
      run(
        NEXT,
        stream(0, 5, () => 1),
      ),
    ).toEqual([1])
  })

  it("a swipe with inertia steps a few times and stops with the movement", () => {
    const events = swipe(0)
    const steps = run(NEXT, events)
    expect(sum(steps)).toBeGreaterThanOrEqual(3)
    expect(sum(steps)).toBeLessThanOrEqual(6)
    // The tail of the inertia (the last 200 ms, a few pixels an event) adds nothing.
    const end = events[events.length - 1]![0]
    const early = run(
      NEXT,
      events.filter(([at]) => at < end - 200),
    )
    expect(sum(steps)).toBe(sum(early))
  })

  it("a swipe back after a swipe steps back", () => {
    const steps = run(NEXT, [...swipe(0), ...swipe(2000, -1)])
    expect(steps[0]).toBe(1)
    expect(steps[steps.length - 1]).toBe(-1)
  })

  it("a pinch changes the size by steps of its distance", () => {
    // Ctrl + wheel events of a pinch: 40 events of 5 (200 in all), no interval.
    expect(
      sum(
        run(
          { stepPx: 50 },
          stream(0, 40, () => -5),
        ),
      ),
    ).toBe(-4)
    // A mouse notch with Ctrl is one size, not two.
    expect(run({ stepPx: 50 }, [[0, -100]])).toEqual([-1])
  })
})

describe("wheel steps: rows", () => {
  const ROWS: WheelStepperOptions = { stepPx: 16, maxSteps: 20, linePx: 16 }

  it("moves the rows the wheel travelled and keeps the rest", () => {
    // 100 px over 16 px rows: 6 rows, 4 px kept; 12 more make the 7th.
    expect(
      run(ROWS, [
        [0, 100],
        [16, 12],
      ]),
    ).toEqual([6, 1])
  })

  it("a slow drag moves row by row", () => {
    // 2 px an event: the first event moves a row, then one row per 16 px.
    expect(
      sum(
        run(
          ROWS,
          stream(0, 64, () => 2),
        ),
      ),
    ).toBe(1 + Math.floor((63 * 2) / 16))
  })

  it("one event moves at most the limit", () => {
    expect(run(ROWS, [[0, 10_000]])).toEqual([20])
  })

  it("a device that reports lines moves a row per line", () => {
    const step = createWheelStepper(ROWS)
    expect(step({ deltaY: 3, deltaMode: 1 }, 0)).toBe(3)
    expect(step({ deltaY: -1, deltaMode: 1 }, 500)).toBe(-1)
  })

  it("ignores an event without vertical travel", () => {
    const step = createWheelStepper(ROWS)
    expect(step({ deltaY: 0, deltaMode: 0 }, 0)).toBe(0)
    expect(step({ deltaY: Number.NaN, deltaMode: 0 }, 10)).toBe(0)
  })
})
