import type { EditRenderResult } from "@panelyth/contracts"
import { describe, expect, it, vi } from "vitest"
import { createScheduler, type RenderRequest } from "./scheduler"

const request = (angle: number): RenderRequest => ({
  editList: [{ op: "rotate", p: { angle } }],
  quality: "draft",
  maxEdge: 1000,
  histogram: true,
})

const frame = (rev: number): EditRenderResult => ({
  rev,
  frame: { url: `panelyth-media://m/${rev}`, width: 10, height: 10 },
})

/** A port whose renders are finished by the test, in any order. */
function port() {
  const pending = new Map<
    number,
    { request: RenderRequest; resolve(r: EditRenderResult): void; reject(e: unknown): void }
  >()
  const frames: number[] = []
  const errors: unknown[] = []
  const busy: boolean[] = []
  const render = vi.fn(
    (rev: number, req: RenderRequest) =>
      new Promise<EditRenderResult>((resolve, reject) => {
        pending.set(rev, { request: req, resolve, reject })
      }),
  )
  return {
    port: {
      render,
      onFrame: (r: EditRenderResult) => void frames.push(r.rev),
      onError: (e: unknown) => void errors.push(e),
      onBusy: (b: boolean) => void busy.push(b),
    },
    render,
    pending,
    frames,
    errors,
    busy,
    async finish(rev: number, result: EditRenderResult = frame(rev)) {
      pending.get(rev)!.resolve(result)
      pending.delete(rev)
      await Promise.resolve()
      await Promise.resolve()
    },
    async fail(rev: number, error: unknown) {
      pending.get(rev)!.reject(error)
      pending.delete(rev)
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe("render scheduler", () => {
  it("keeps one render in flight and only the newest request queued", async () => {
    const p = port()
    const s = createScheduler(p.port)
    s.request(request(1))
    s.request(request(2))
    s.request(request(3))
    s.request(request(4))
    // One call so far; 2 and 3 were replaced while waiting.
    expect(p.render).toHaveBeenCalledTimes(1)
    expect(p.pending.get(1)!.request).toEqual(request(1))
    await p.finish(1)
    expect(p.render).toHaveBeenCalledTimes(2)
    expect(p.pending.get(2)!.request).toEqual(request(4))
    await p.finish(2)
    expect(p.render).toHaveBeenCalledTimes(2)
    expect(p.frames).toEqual([1, 2])
  })

  it("numbers requests upwards so Go can order them", async () => {
    const p = port()
    const s = createScheduler(p.port, 5)
    s.request(request(1))
    await p.finish(5)
    s.request(request(2))
    await p.finish(6)
    expect(p.render.mock.calls.map(([rev]) => rev)).toEqual([5, 6])
  })

  it("shows no frame for a superseded revision", async () => {
    const p = port()
    const s = createScheduler(p.port)
    s.request(request(1))
    s.request(request(2))
    await p.finish(1, { rev: 1, superseded: true })
    expect(p.frames).toEqual([])
    await p.finish(2)
    expect(p.frames).toEqual([2])
  })

  it("reports busy from the first request until the last frame", async () => {
    const p = port()
    const s = createScheduler(p.port)
    s.request(request(1))
    s.request(request(2))
    await p.finish(1)
    expect(p.busy.at(-1)).toBe(true)
    await p.finish(2)
    expect(p.busy.at(-1)).toBe(false)
  })

  it("reports an error only when nothing newer is waiting", async () => {
    const p = port()
    const s = createScheduler(p.port)
    s.request(request(1))
    s.request(request(2))
    await p.fail(1, new Error("first"))
    expect(p.errors).toEqual([])
    expect(p.render).toHaveBeenCalledTimes(2)
    await p.fail(2, new Error("second"))
    expect(p.errors).toHaveLength(1)
    expect(p.busy.at(-1)).toBe(false)
    // The scheduler keeps working after an error.
    s.request(request(3))
    await p.finish(3)
    expect(p.frames).toEqual([3])
  })

  it("ignores everything after stop", async () => {
    const p = port()
    const s = createScheduler(p.port)
    s.request(request(1))
    s.request(request(2))
    s.stop()
    await p.finish(1)
    expect(p.frames).toEqual([])
    expect(p.render).toHaveBeenCalledTimes(1)
    s.request(request(3))
    expect(p.render).toHaveBeenCalledTimes(1)
  })
})
