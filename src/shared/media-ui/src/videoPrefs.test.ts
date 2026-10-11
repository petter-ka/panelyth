import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { configureMedia } from "./port"
import { setLoop, setMuted, useVideoPrefs } from "./video"
import { parsePlayerPrefs, startVideoPrefsPersistence } from "./videoPrefs"

describe("parsePlayerPrefs", () => {
  it("reads the stored setting; an older one without repeat has repeat off", () => {
    expect(parsePlayerPrefs({ volume: 0.4, muted: true, loop: true })).toEqual({
      volume: 0.4,
      muted: true,
      loop: true,
    })
    expect(parsePlayerPrefs({ volume: 2, muted: false })).toEqual({
      volume: 1,
      muted: false,
      loop: false,
    })
    expect(parsePlayerPrefs({ volume: "x", muted: false })).toBeNull()
    expect(parsePlayerPrefs(null)).toBeNull()
  })
})

describe("startVideoPrefsPersistence", () => {
  const read = vi.fn()
  const write = vi.fn(async () => undefined)
  let stop: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    read.mockReset()
    write.mockClear()
    useVideoPrefs.setState({ volume: 1, muted: false, loop: false })
    configureMedia({
      isAvailable: () => true,
      openMedia: vi.fn(),
      ensurePreviews: vi.fn(),
      openWithSystem: vi.fn(),
      onPreviewReady: () => () => undefined,
      settings: { read, write },
    })
  })
  afterEach(() => {
    stop()
    vi.useRealTimers()
  })

  it("restores mute and repeat from the saved setting", async () => {
    read.mockResolvedValue({ volume: 0.7, muted: true, loop: true })
    stop = startVideoPrefsPersistence()
    await vi.advanceTimersByTimeAsync(0)
    expect(useVideoPrefs.getState()).toEqual({ volume: 0.7, muted: true, loop: true })
    expect(write).not.toHaveBeenCalled()
  })

  it("saves a change once, debounced, with repeat", async () => {
    read.mockResolvedValue(undefined)
    stop = startVideoPrefsPersistence()
    setMuted(true)
    setLoop(true)
    await vi.advanceTimersByTimeAsync(600)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith("player", { volume: 1, muted: true, loop: true })
  })

  it("picks up a change made in another window when this one is focused", async () => {
    read
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ volume: 1, muted: true, loop: false })
    stop = startVideoPrefsPersistence()
    await vi.advanceTimersByTimeAsync(0)
    window.dispatchEvent(new Event("focus"))
    await vi.advanceTimersByTimeAsync(0)
    expect(useVideoPrefs.getState().muted).toBe(true)
    expect(write).not.toHaveBeenCalled()
  })
})
