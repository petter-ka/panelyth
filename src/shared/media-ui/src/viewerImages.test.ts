import type { MediaOpenResult } from "@panelyth/contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { configureMedia } from "./port"
import { problemFromCode, problemFromMediaError } from "./video"
import { getViewerImage, MEDIA_RETRY_MS, requestMedia, resetViewerImages } from "./viewerImages"

const opened = { url: "panelyth-media://m/t", kind: "video" } as unknown as MediaOpenResult
const failure = (code: string) => Object.assign(new Error(code), { code })

let openMedia: ReturnType<typeof vi.fn<(id: number) => Promise<MediaOpenResult>>>
beforeEach(() => {
  vi.useFakeTimers()
  resetViewerImages()
  openMedia = vi.fn<(id: number) => Promise<MediaOpenResult>>()
  configureMedia({
    isAvailable: () => true,
    openMedia,
    ensurePreviews: vi.fn(),
    openWithSystem: vi.fn(),
    onPreviewReady: () => () => undefined,
  })
})
afterEach(() => vi.useRealTimers())

describe("requestMedia", () => {
  it("asks again while the app itself is not ready (a drive waking up), staying pending", async () => {
    openMedia
      .mockRejectedValueOnce(failure("SIDECAR_UNAVAILABLE"))
      .mockRejectedValueOnce(failure("TIMEOUT"))
      .mockResolvedValueOnce(opened)
    const done = requestMedia(7)
    await vi.advanceTimersByTimeAsync(0)
    expect(getViewerImage(7)?.media).toEqual({ status: "pending" })
    await vi.advanceTimersByTimeAsync(MEDIA_RETRY_MS[0]! + MEDIA_RETRY_MS[1]!)
    await done
    expect(openMedia).toHaveBeenCalledTimes(3)
    expect(getViewerImage(7)?.media).toMatchObject({ status: "ready", media: opened })
  })

  it("gives up after the retries, and a file's own failure is not retried", async () => {
    openMedia.mockRejectedValue(failure("TIMEOUT"))
    const done = requestMedia(7)
    await vi.advanceTimersByTimeAsync(10_000)
    await done
    expect(openMedia).toHaveBeenCalledTimes(1 + MEDIA_RETRY_MS.length)
    expect(getViewerImage(7)?.media).toEqual({ status: "failed", code: "TIMEOUT" })

    openMedia.mockReset().mockRejectedValue(failure("NOT_FOUND"))
    await requestMedia(8)
    expect(openMedia).toHaveBeenCalledTimes(1)
  })

  it("does not keep a failure for the next look at the file", async () => {
    openMedia.mockRejectedValueOnce(failure("NOT_FOUND")).mockResolvedValueOnce(opened)
    await requestMedia(7)
    expect(getViewerImage(7)?.media?.status).toBe("failed")
    await requestMedia(7)
    expect(getViewerImage(7)?.media?.status).toBe("ready")
    // Once it works, it is kept.
    await requestMedia(7)
    expect(openMedia).toHaveBeenCalledTimes(2)
  })
})

describe("what the player says", () => {
  it("says a video can't be played only when the file's format is the reason", () => {
    expect(problemFromCode("UNSUPPORTED_MEDIA")).toBe("unsupported")
    for (const code of ["TIMEOUT", "BUSY", "SIDECAR_UNAVAILABLE", "CANCELLED"] as const)
      expect(problemFromCode(code), code).toBe("unavailable")
    expect(problemFromMediaError(1)).toBe("unavailable")
    expect(problemFromMediaError(4)).toBe("unsupported")
  })
})
