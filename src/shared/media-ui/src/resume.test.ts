import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { configureMedia, type MediaPort } from "./port"
import {
  flushResume,
  parseStored,
  readResume,
  recordResume,
  resetResume,
  RESUME_KEY,
  trim,
  usablePoint,
} from "./resume"

const HOUR = 3600

let store: Record<string, unknown>
function configure(): void {
  store = {}
  const port: MediaPort = {
    isAvailable: () => true,
    openMedia: vi.fn(),
    ensurePreviews: vi.fn(),
    openWithSystem: vi.fn(),
    onPreviewReady: () => () => undefined,
    settings: {
      read: async (key) => structuredClone(store[key]),
      write: async (key, value) => {
        store[key] = structuredClone(value)
      },
    },
  }
  configureMedia(port)
}

beforeEach(() => {
  vi.useFakeTimers()
  resetResume()
  configure()
})
afterEach(() => vi.useRealTimers())

describe("usablePoint", () => {
  const point = { t: 1800, d: HOUR, at: 1 }
  it("continues a long video from its saved position", () => {
    expect(usablePoint(point, HOUR)).toBe(1800)
    expect(usablePoint(point, HOUR + 1)).toBe(1800) // the container's duration may differ a little
  })
  it("starts over for short videos, other files, the very start and the very end", () => {
    expect(usablePoint(point, 599)).toBeNull()
    expect(usablePoint({ ...point, d: 599 }, 599)).toBeNull()
    expect(usablePoint(point, HOUR + 30)).toBeNull() // replaced by another file
    expect(usablePoint({ ...point, t: 3 }, HOUR)).toBeNull()
    expect(usablePoint({ ...point, t: HOUR - 10 }, HOUR)).toBeNull()
    expect(usablePoint(undefined, HOUR)).toBeNull()
  })
})

describe("stored positions", () => {
  it("drops malformed entries", () => {
    expect(
      parseStored({
        "12": { t: 5, d: 700, at: 1 },
        x: { t: 5, d: 700, at: 1 },
        "13": { t: -1, d: 700, at: 1 },
        "14": "no",
        "15": { t: 5, d: 0, at: 1 },
      }),
    ).toEqual({ "12": { t: 5, d: 700, at: 1 } })
    expect(parseStored([1, 2])).toEqual({})
    expect(parseStored(null)).toEqual({})
  })

  it("keeps the newest 200", () => {
    const many = Object.fromEntries(
      Array.from({ length: 250 }, (_, i) => [String(i + 1), { t: 10, d: 900, at: i }]),
    )
    const kept = trim(many)
    expect(Object.keys(kept)).toHaveLength(200)
    expect(kept["250"]).toBeDefined()
    expect(kept["1"]).toBeUndefined()
  })
})

describe("recording", () => {
  it("saves a long video's position after a pause and reads it back", async () => {
    recordResume(7, 1234, HOUR)
    expect(store[RESUME_KEY]).toBeUndefined() // debounced
    await vi.advanceTimersByTimeAsync(1100)
    expect(store[RESUME_KEY]).toEqual({ "7": { t: 1234, d: HOUR, at: expect.any(Number) } })
    expect((await readResume(7))?.t).toBe(1234)
  })

  it("never saves a video under ten minutes", async () => {
    recordResume(8, 100, 599)
    await flushResume()
    expect(store[RESUME_KEY]).toBeUndefined()
  })

  it("forgets the position when the video ends or goes back to the start", async () => {
    recordResume(9, 2000, HOUR)
    await flushResume()
    expect(Object.keys(store[RESUME_KEY] as object)).toEqual(["9"])
    recordResume(9, HOUR, HOUR)
    await flushResume()
    expect(store[RESUME_KEY]).toEqual({})
    recordResume(9, 2000, HOUR)
    recordResume(9, 1, HOUR)
    await flushResume()
    expect(store[RESUME_KEY]).toEqual({})
  })

  it("merges into what another window saved meanwhile", async () => {
    recordResume(1, 100, HOUR)
    store[RESUME_KEY] = { "2": { t: 50, d: 900, at: 5 } } // the other app
    await flushResume()
    expect(Object.keys(store[RESUME_KEY] as object).sort()).toEqual(["1", "2"])
  })
})
